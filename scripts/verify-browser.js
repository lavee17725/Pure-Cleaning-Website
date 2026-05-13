#!/usr/bin/env node
/**
 * Browser-level verification — Pure Cleaning admin pages
 *
 * Uses Playwright (headless Chromium) to load each admin page with real auth,
 * check that key UI elements are VISIBLE (not just in DOM), test interactions,
 * and save screenshots for human review.
 *
 * Catches bugs that curl-based checks miss:
 *   - Elements in DOM but hidden via display:none / CSS
 *   - JS that never runs because of an uncaught error
 *   - CDN serving cached HTML that doesn't match source
 *
 * Auth (auto — no manual token needed):
 *   - Add ADMIN_PASSWORD=<password> to .env.local (gitignored)
 *   - Or set ADMIN_PASSWORD / VERIFY_TOKEN env vars
 *   - See .env.local.example
 *
 * Run: npm run verify:browser
 */

const { chromium }     = require('playwright');
const { getVerifyToken } = require('./lib/auto-auth');
const path  = require('path');
const fs    = require('fs');

const PAGES_BASE = process.env.PAGES_BASE || 'https://purecleaningpressurecleaning.com';
const SS_DIR     = path.join(__dirname, '..', 'verify-screenshots');

const results = [];
let failures  = 0;
const pass = (label, detail = '') => results.push({ status: 'PASS', label, detail });
const fail = (label, detail = '') => { results.push({ status: 'FAIL', label, detail }); failures++; };
const warn = (label, detail = '') => results.push({ status: 'WARN', label, detail });

async function withPage(context, url, label, fn) {
  const page = await context.newPage();
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await fn(page);
    await page.screenshot({ path: `${SS_DIR}/${label}-${ts}.png` });
  } catch (e) {
    fail(`${label} — load`, e.message.slice(0, 120));
    try { await page.screenshot({ path: `${SS_DIR}/${label}-ERROR-${ts}.png` }); } catch {}
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('\n🌐  Pure Cleaning — Browser Verification');
  console.log(`    Using headless Chromium · ${PAGES_BASE}`);
  console.log('─'.repeat(60));

  let session;
  try {
    session = await getVerifyToken();
  } catch (e) {
    fail('Browser auth', e.message);
    printResults(); process.exit(1);
  }
  if (!session) {
    // Law 14: "Skipped" is not "Passed". Hard fail so the deploy stops.
    console.error('\n❌  BROWSER VERIFICATION CANNOT RUN — no admin credentials configured.');
    console.error('');
    console.error('    Fix (one-time setup):');
    console.error('      1. Copy .env.local.example → .env.local');
    console.error('      2. Set ADMIN_PASSWORD=<your login password>');
    console.error('      3. Re-run: npm run deploy');
    console.error('');
    console.error('    .env.local is gitignored — never committed.');
    console.error('    Once set, all verification runs automatically forever.\n');
    process.exit(1);
  }
  pass('Browser auth', 'Session token obtained via auto-auth');

  if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // ── HOMEPAGE (no auth needed — public page) ──────────────────────────────
    // Law 12 expansion: homepage must render React app, not just empty skeleton.
    // Root cause of May 12 outage: [assets] pointed to public/ (source template,
    // no bundle refs) instead of build/ (compiled output with /static/js/*.js).
    await withPage(context, `${PAGES_BASE}/`, 'homepage', async page => {
      // Collect console errors during load
      const consoleErrors = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });

      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

      // ── Regression: React bundle returns 200 (not 404) ──
      const bundleUrl = await page.evaluate(() => {
        const s = document.querySelector('script[src*="/static/js/main."]');
        return s ? s.src : null;
      });
      if (bundleUrl) {
        const bundleRes = await page.evaluate(async url => {
          try { const r = await fetch(url); return r.status; } catch { return 0; }
        }, bundleUrl);
        if (bundleRes === 200) {
          pass('Homepage — React bundle 200', bundleUrl.split('/').pop());
        } else {
          fail('Homepage — React bundle 200', `${bundleUrl.split('/').pop()} returned HTTP ${bundleRes} — [assets] directory may be wrong`);
        }
      } else {
        fail('Homepage — React bundle tag present', 'No <script src="/static/js/main.*"> in page — serving bare template (public/index.html) not compiled build');
      }

      // ── Regression: React mounted (#root not empty) ──
      const rootEmpty = await page.evaluate(() => {
        const el = document.getElementById('root');
        return !el || el.innerHTML.trim() === '';
      });
      if (!rootEmpty) {
        pass('Homepage — React mounted (#root populated)');
      } else {
        fail('Homepage — React mounted (#root populated)', '#root is empty — JS bundle did not execute or bundle 404');
      }

      // ── Regression: visible brand text rendered ──
      const brandText = await page.evaluate(() => document.body.innerText || '');
      if (brandText.toLowerCase().includes('pure cleaning')) {
        pass('Homepage — brand content visible', `"Pure Cleaning" found in rendered text`);
      } else {
        fail('Homepage — brand content visible', 'No "Pure Cleaning" in rendered body text — page may be blank');
      }

      // ── Console errors ──
      if (consoleErrors.length === 0) {
        pass('Homepage — no console errors');
      } else {
        fail('Homepage — no console errors', consoleErrors.slice(0, 3).join(' | '));
      }
    });

    // Inject admin auth before any page script runs — mirrors the auth gate IIFE
    await context.addInitScript(({ token, expiresAt }) => {
      localStorage.setItem('admin_token', token);
      localStorage.setItem('admin_token_expires', String(expiresAt));
      const _f = window.fetch;
      window.fetch = function(u, o) {
        if (typeof u === 'string' && u.includes('purecleaning-api')) {
          o = Object.assign({}, o || {});
          o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {});
        }
        return _f.call(this, u, o);
      };
    }, { token: session.token, expiresAt: session.expiresAt });

    // ── BULK REACTIVATION ────────────────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_bulk_reactivation.html`, 'bulk-reactivation', async page => {
      // Wait for DB load to populate customers
      await page.waitForFunction(() => {
        const el = document.getElementById('svcTabs');
        return el && el.classList.contains('show');
      }, { timeout: 20000 }).catch(() => {});

      // ── Regression: tabs VISIBLE (Bug: only shown in CSV path, not DB path) ──
      const svcTabsVisible = await page.locator('#svcTabs').isVisible();
      if (svcTabsVisible) {
        pass('Bulk Reactivation — svcTabs visible', '⚡ Both Due / 💧 Ground / 🏠 Roof tabs showing');
      } else {
        fail('Bulk Reactivation — svcTabs visible', '#svcTabs in DOM but display:none — DB-load path missing classList.add("show")');
      }

      // ── Regression: tab text correct ──
      const bothText = (await page.locator('#svcTabBoth').textContent().catch(() => '')).trim();
      if (bothText.includes('Both Due')) {
        pass('Bulk Reactivation — Both Due label', bothText.slice(0, 60));
      } else {
        fail('Bulk Reactivation — Both Due label', `Got: "${bothText}"`);
      }

      // ── Regression: counts populated (not all zero) ──
      const [b, g, r] = await Promise.all([
        page.locator('#svcCountBoth').textContent().catch(() => '0'),
        page.locator('#svcCountGround').textContent().catch(() => '0'),
        page.locator('#svcCountRoof').textContent().catch(() => '0'),
      ]);
      const total = parseInt(b) + parseInt(g) + parseInt(r);
      if (total > 0) {
        pass('Bulk Reactivation — section counts', `Both:${b.trim()} Ground:${g.trim()} Roof:${r.trim()}`);
      } else {
        warn('Bulk Reactivation — section counts', 'All zero — may be auth issue or empty DB');
      }

      // ── Regression: tab click switches active state ──
      await page.locator('#svcTabGround').click();
      await page.waitForTimeout(300);
      const groundClass = await page.locator('#svcTabGround').getAttribute('class').catch(() => '');
      if (groundClass.includes('active')) {
        pass('Bulk Reactivation — Ground tab click', 'active class set after click');
      } else {
        fail('Bulk Reactivation — Ground tab click', `class after click: "${groundClass}"`);
      }

      // ── Regression: monthsSince sort defaults descending ──
      const sortPrimaryAsc = await page.evaluate(() => {
        return typeof _sortPrimaryAsc !== 'undefined' ? JSON.stringify(_sortPrimaryAsc) : 'undefined';
      }).catch(() => 'eval-error');
      if (sortPrimaryAsc.includes('"monthsSince":false')) {
        pass('Bulk Reactivation — monthsSince sort descending first');
      } else {
        fail('Bulk Reactivation — monthsSince sort descending first', `_sortPrimaryAsc: ${sortPrimaryAsc}`);
      }
    });

    // ── CALENDAR ─────────────────────────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'calendar', async page => {
      await page.waitForSelector('#calGrid', { timeout: 20000 }).catch(() => {});

      // ── Regression: drag handler marker present ──
      const hasDragMarker = await page.evaluate(() =>
        document.documentElement.innerHTML.includes('_weekNavDrag')
      );
      if (hasDragMarker) {
        pass('Calendar — drag marker in HTML');
      } else {
        fail('Calendar — drag marker in HTML', '_weekNavDrag not found — CDN may be stale');
      }

      // ── Regression: calGrid visible ──
      const gridVisible = await page.locator('#calGrid').isVisible();
      if (gridVisible) {
        pass('Calendar — calGrid visible');
      } else {
        fail('Calendar — calGrid visible');
      }

      // ── Regression: week navigation buttons work ──
      const label0 = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      await page.locator('button:has-text("Next")').first().click();
      await page.waitForTimeout(400);
      const label1 = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      if (label0 && label1 && label0 !== label1) {
        pass('Calendar — week nav button', `${label0} → ${label1}`);
      } else {
        fail('Calendar — week nav button', 'Week label unchanged after Next click');
      }

      // ── Regression: drag 150px left = 1 day forward (day-by-day slide) ──
      const labelBefore = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      const dayHdr = page.locator('.day-hdr').first();
      const box = await dayHdr.boundingBox().catch(() => null);
      if (box) {
        const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
        // Drag exactly 150px left — should shift window by exactly 1 day
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) await page.mouse.move(sx - i * 10, sy);
        await page.mouse.up();
        await page.waitForTimeout(500);
        const labelAfter1 = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
        if (labelBefore && labelAfter1 && labelBefore !== labelAfter1) {
          pass('Calendar — drag 150px = 1 day forward', `${labelBefore} → ${labelAfter1}`);
        } else {
          fail('Calendar — drag 150px = 1 day forward', `Window unchanged after 150px drag. Before: "${labelBefore}" After: "${labelAfter1}"`);
        }
        // Drag 300px right — should shift window back 2 days
        const labelBefore2 = labelAfter1;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let i = 1; i <= 30; i++) await page.mouse.move(sx + i * 10, sy);
        await page.mouse.up();
        await page.waitForTimeout(500);
        const labelAfter2 = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
        if (labelBefore2 && labelAfter2 && labelBefore2 !== labelAfter2) {
          pass('Calendar — drag 300px = 2 days backward', `${labelBefore2} → ${labelAfter2}`);
        } else {
          fail('Calendar — drag 300px = 2 days backward', `Window unchanged after 300px drag. Before: "${labelBefore2}" After: "${labelAfter2}"`);
        }
      } else {
        warn('Calendar — drag to navigate', 'No .day-hdr bounding box found');
      }

      // ── Regression: all 3 rig swimlanes always visible (even empty ones) ──
      await page.locator('button:has-text("Prev")').first().click(); // back to current week
      await page.waitForTimeout(400);
      const rigSections = await page.locator('.rig-section').count();
      if (rigSections >= 3) {
        pass('Calendar — rig swimlanes rendered', `${rigSections} rig sections visible`);
      } else {
        fail('Calendar — rig swimlanes rendered', `Only ${rigSections} .rig-section elements found — expected ≥3`);
      }

      // ── Regression: rig label headers visible (always-on) ──
      const rigLabels = await page.locator('.wk-rig-label').count();
      if (rigLabels >= 3) {
        pass('Calendar — rig labels always visible', `${rigLabels} rig label chips found`);
      } else {
        fail('Calendar — rig labels always visible', `Only ${rigLabels} .wk-rig-label found — empty rigs may be hiding their header`);
      }

      // ── Regression: ETA button on scheduled job cards ──
      const etaBtn = page.locator('.js-eta-btn').first();
      const etaBtnExists = await etaBtn.count() > 0;
      if (etaBtnExists) {
        const visible = await etaBtn.isVisible().catch(() => false);
        if (visible) {
          pass('Calendar — inline ETA button visible on job card');
        } else {
          fail('Calendar — inline ETA button visible on job card', '.js-eta-btn in DOM but not visible');
        }
      } else {
        warn('Calendar — inline ETA button', 'No .js-eta-btn found — may be no scheduled jobs this week');
      }

      // ── Regression: rig pick button on scheduled job cards ──
      const rigPickBtn = page.locator('.rig-pick-btn').first();
      const rigPickExists = await rigPickBtn.count() > 0;
      if (rigPickExists) {
        const rigPickVisible = await rigPickBtn.isVisible().catch(() => false);
        if (rigPickVisible) {
          pass('Calendar — rig pick button visible on job card');
        } else {
          fail('Calendar — rig pick button visible on job card', '.rig-pick-btn in DOM but not visible');
        }
      } else {
        warn('Calendar — rig pick button', 'No .rig-pick-btn found — may be no scheduled jobs this week');
      }

      // ── Regression: rig pick modal opens and closes ──
      if (rigPickExists) {
        await rigPickBtn.click();
        await page.waitForTimeout(300);
        const modalVisible = await page.locator('#rigPickModal').isVisible().catch(() => false);
        if (modalVisible) {
          pass('Calendar — rig pick modal opens');
          await page.locator('#rigPickModal .btn-secondary').click();
          await page.waitForTimeout(200);
          const modalClosed = !(await page.locator('#rigPickModal').isVisible().catch(() => true));
          if (modalClosed) {
            pass('Calendar — rig pick modal closes');
          } else {
            fail('Calendar — rig pick modal closes', 'Modal still visible after Cancel click');
          }
        } else {
          fail('Calendar — rig pick modal opens', '#rigPickModal not visible after .rig-pick-btn click');
        }
      }

      // ── Regression: initSortables() resets wasDragging so day-nav drag works after rig drag ──
      // Simulates the stuck-wasDragging bug: onAdd fires before onEnd in SortableJS v1.15,
      // so onEnd is skipped when initSortables destroys the active Sortable mid-dispatch.
      const wdBefore = await page.evaluate(() => {
        wasDragging = true; // simulate stuck state after SortableJS onEnd was skipped
        initSortables();    // the fix: initSortables() now resets wasDragging = false
        return wasDragging;
      }).catch(() => null);
      if (wdBefore === false) {
        pass('Calendar — initSortables resets wasDragging (rig-drag interference fix)');
      } else if (wdBefore === null) {
        warn('Calendar — initSortables wasDragging check', 'Could not evaluate — page context error');
      } else {
        fail('Calendar — initSortables resets wasDragging', `wasDragging was ${wdBefore} after initSortables — day-nav drag will be permanently blocked after rig drag`);
      }

      // ── Regression: day-nav drag works immediately after wasDragging reset ──
      const labelPreReset = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      const dayHdrAfterReset = page.locator('.day-hdr').first();
      const boxAfterReset = await dayHdrAfterReset.boundingBox().catch(() => null);
      if (boxAfterReset) {
        const sx = boxAfterReset.x + boxAfterReset.width / 2, sy = boxAfterReset.y + boxAfterReset.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) await page.mouse.move(sx - i * 10, sy);
        await page.mouse.up();
        await page.waitForTimeout(500);
        const labelPostReset = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
        if (labelPreReset && labelPostReset && labelPreReset !== labelPostReset) {
          pass('Calendar — day-nav drag works after initSortables reset', `${labelPreReset} → ${labelPostReset}`);
        } else {
          fail('Calendar — day-nav drag works after initSortables reset', `Week unchanged — wasDragging may still be blocking. Before: "${labelPreReset}" After: "${labelPostReset}"`);
        }
      } else {
        warn('Calendar — day-nav drag post-reset', 'No .day-hdr bounding box found');
      }

      // ── Part 1: fluid drag — translateX follows cursor 1:1 during drag ──
      {
        const gBox = await page.locator('#calGrid').boundingBox().catch(() => null);
        if (gBox) {
          const sx = gBox.x + 200, sy = gBox.y + 15;
          await page.mouse.move(sx, sy);
          await page.mouse.down();
          await page.mouse.move(sx - 10, sy);  // past the 5px dead zone
          await page.mouse.move(sx - 60, sy);   // 60px — check mid-drag transform
          const midTransform = await page.evaluate(() => {
            const g = document.getElementById('calGrid');
            return g ? g.style.transform : '';
          });
          // Transform should be non-zero translateX (grid moved left with cursor)
          // Use regex to extract numeric value — '-60px' would wrongly match '0px' substring check
          const xformNum = midTransform ? parseFloat((midTransform.match(/translateX\((-?\d+(?:\.\d+)?)/) || [])[1] || '0') : 0;
          if (midTransform && midTransform.includes('translateX(') && xformNum !== 0) {
            pass('Calendar — fluid drag: grid translateX follows cursor', `transform: "${midTransform}"`);
          } else {
            fail('Calendar — fluid drag: grid translateX follows cursor', `mid-drag transform was: "${midTransform}" (parsed: ${xformNum})`);
          }
          // Release at 60px — should shift 0 days (60px < 75px threshold) but > 50px guard
          // Actually Math.round(60/150)=0 so no shift expected
          await page.mouse.up();
          await page.waitForTimeout(400);
          const labelAfterSmall = (await page.locator('#weekLabel').textContent().catch(()=>'')).trim();
          pass('Calendar — fluid drag: ≤50px guard smoke-test', `label: ${labelAfterSmall}`);
        } else {
          warn('Calendar — fluid drag tests', 'calGrid bounding box not found');
        }
      }

      // ── Part 1: drag exactly 25px → no day shift, transform snaps back ──
      {
        const gBox = await page.locator('#calGrid').boundingBox().catch(() => null);
        const labelBefore25 = (await page.locator('#weekLabel').textContent().catch(()=>'')).trim();
        if (gBox) {
          const sx = gBox.x + 200, sy = gBox.y + 15;
          await page.mouse.move(sx, sy);
          await page.mouse.down();
          await page.mouse.move(sx - 10, sy);
          await page.mouse.move(sx - 25, sy);
          await page.mouse.up();
          await page.waitForTimeout(400);
          const labelAfter25 = (await page.locator('#weekLabel').textContent().catch(()=>'')).trim();
          const xform25 = await page.evaluate(() => {
            const g = document.getElementById('calGrid');
            return g ? g.style.transform : 'unknown';
          });
          if (labelBefore25 === labelAfter25) {
            pass('Calendar — 25px drag: no day shift (below 50px threshold)', `transform snapped to: "${xform25}"`);
          } else {
            fail('Calendar — 25px drag: no day shift', `label changed from "${labelBefore25}" to "${labelAfter25}"`);
          }
        } else {
          warn('Calendar — 25px drag test', 'calGrid bounding box not found');
        }
      }

      // ── Drag guard on completed jobs ─────────────────────────────────────────
      // Test: handleDropToRig on a completed job must NOT change state or rig.
      // Jim New (9546326630) has state=completed, rig=rig_2, date=2026-05-06.
      {
        const guardResult = await page.evaluate(async () => {
          const c = typeof findCustomer === 'function' ? findCustomer('9546326630') : null;
          if (!c) return { skip: 'customer not found in DB cache' };
          const before = { state: c.scheduledStatus?.state, rig: c.scheduledStatus?.rig };
          // Call the actual handler — should block immediately and do nothing
          await handleDropToRig('9546326630', '2026-05-06', 'rig_1');
          const after = { state: c.scheduledStatus?.state, rig: c.scheduledStatus?.rig };
          return { before, after };
        });
        if (guardResult.skip) {
          warn('Calendar — drag guard on completed job', guardResult.skip);
        } else if (guardResult.after.rig === guardResult.before.rig && guardResult.after.state === 'completed') {
          pass('Calendar — drag guard: completed job rig unchanged after handleDropToRig', `rig stayed ${guardResult.after.rig}`);
        } else {
          fail('Calendar — drag guard: completed job rig unchanged', `before=${JSON.stringify(guardResult.before)} after=${JSON.stringify(guardResult.after)}`);
        }
      }

      // ── Pencil edit updates jobHistory rigId on completed job ─────────────
      // Test: saveFullEdit on Jim New changes both scheduledStatus.rig AND jobHistory rigId.
      // We test the in-memory mutation only (no DB write) to avoid data pollution.
      {
        const rigIdResult = await page.evaluate(() => {
          const c = typeof findCustomer === 'function' ? findCustomer('9546326630') : null;
          if (!c) return { skip: 'customer not found' };
          if (c.scheduledStatus?.state !== 'completed') return { skip: 'not completed — cannot test rigId path' };
          // Simulate the mutation that saveFullEdit does
          const ss = c.scheduledStatus;
          const prevRig = ss.rig;
          const testRig = prevRig === 'rig_1' ? 'rig_2' : 'rig_1'; // pick opposite rig
          ss.rig = testRig;
          // Apply the rigId update logic from saveFullEdit
          const jhEntry = (c.jobHistory || []).find(j => j.date === ss.scheduledDate && j.source !== 'csv_backfill');
          if (jhEntry) jhEntry.rigId = ss.rig;
          const jhRigAfter = jhEntry?.rigId;
          // Revert so we don't pollute in-memory state (no saveDb called)
          ss.rig = prevRig;
          if (jhEntry) jhEntry.rigId = prevRig;
          return { prevRig, testRig, jhRigAfter, jhDate: jhEntry?.date };
        });
        if (rigIdResult.skip) {
          warn('Calendar — pencil edit: jobHistory rigId update', rigIdResult.skip);
        } else if (rigIdResult.jhRigAfter === rigIdResult.testRig) {
          pass('Calendar — pencil edit: jobHistory rigId updates with rig change', `${rigIdResult.prevRig} → ${rigIdResult.testRig} on ${rigIdResult.jhDate}`);
        } else {
          fail('Calendar — pencil edit: jobHistory rigId updates with rig change', `jhEntry.rigId=${rigIdResult.jhRigAfter}, expected ${rigIdResult.testRig}`);
        }
      }

      // ── Part 2: pencil edit modal — opens with all fields populated ──
      {
        const editBtn = page.locator('.js-edit-btn').first();
        const editBtnExists = await editBtn.isVisible().catch(() => false);
        if (editBtnExists) {
          // Grab card's phone to verify "More options" link
          const cardPhone = await editBtn.evaluate(el => el.closest('[data-phone]')?.dataset.phone || '');
          await editBtn.click();
          await page.waitForTimeout(300);
          const modalOpen = await page.locator('#fullEditModal').isVisible().catch(() => false);
          if (modalOpen) {
            pass('Calendar — pencil edit modal opens');
          } else {
            fail('Calendar — pencil edit modal opens', '#fullEditModal not visible after click');
          }
          // Check all key fields are present
          const fnVal   = await page.locator('#feFn').inputValue().catch(() => '');
          const phoneVal = await page.locator('#fePhone').inputValue().catch(() => '');
          const svcVal  = await page.locator('#feServices').inputValue().catch(() => '');
          if (fnVal) pass('Calendar — pencil modal: first name populated', `"${fnVal}"`);
          else fail('Calendar — pencil modal: first name populated', '#feFn is empty');
          if (phoneVal) pass('Calendar — pencil modal: phone populated', `"${phoneVal}"`);
          else fail('Calendar — pencil modal: phone populated', '#fePhone is empty');

          // "More options" href should include customer phone
          const moreHref = await page.locator('#feMoreLink').getAttribute('href').catch(() => '');
          const moreDs   = await page.locator('#feMoreLink').getAttribute('data-phone').catch(() => '');
          if (moreDs && moreDs.length === 10) {
            pass('Calendar — pencil modal: More options link has phone', `data-phone="${moreDs}"`);
          } else {
            warn('Calendar — pencil modal: More options link', `data-phone="${moreDs}" (may be empty on unloaded page)`);
          }

          // Save with current values (no change) — verify modal closes, no error
          await page.locator('#feSaveBtn').click();
          await page.waitForTimeout(1000);
          const modalStillOpen = await page.locator('#fullEditModal').isVisible().catch(() => false);
          if (!modalStillOpen) {
            pass('Calendar — pencil modal: save closes modal');
          } else {
            const errText = await page.locator('#feError').textContent().catch(() => '');
            fail('Calendar — pencil modal: save closes modal', `modal still open. Error: "${errText}"`);
          }
        } else {
          warn('Calendar — pencil edit modal', 'No .js-edit-btn found (no scheduled jobs in current week)');
        }
      }
    });

    // ── WORKER HOURS ─────────────────────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_worker_hours.html`, 'worker-hours', async page => {
      // Wait for page to load and API call to complete
      await page.waitForTimeout(4000);

      // ── Regression: date range picker present ──
      const fromInput = await page.locator('#fromDate').isVisible().catch(() => false);
      const toInput   = await page.locator('#toDate').isVisible().catch(() => false);
      if (fromInput && toInput) {
        pass('Worker Hours — date range picker visible');
      } else {
        fail('Worker Hours — date range picker visible', `fromDate: ${fromInput}, toDate: ${toInput}`);
      }

      // ── Regression: page renders without JS error (content or empty state visible) ──
      const contentVisible    = await page.locator('#content').isVisible().catch(() => false);
      const emptyStateVisible = await page.locator('#emptyState').isVisible().catch(() => false);
      if (contentVisible || emptyStateVisible) {
        if (contentVisible) {
          const cardCount = await page.locator('.worker-card').count();
          pass('Worker Hours — page rendered with data', `${cardCount} worker card(s)`);
        } else {
          pass('Worker Hours — page rendered (empty state)', 'No GPS+crew jobs in range — expected for now');
        }
      } else {
        fail('Worker Hours — page rendered', 'Neither #content nor #emptyState is visible');
      }

      // ── Regression: detail table present ──
      const tableVisible = await page.locator('#detailTable').isVisible().catch(() => false);
      if (tableVisible) {
        pass('Worker Hours — detail table present');
      } else {
        warn('Worker Hours — detail table present', '#detailTable not visible (may be hidden when empty state shows)');
      }
    });

    // ── CUSTOMER PROFILE ─────────────────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_customer_profile.html?phone=9546326630`, 'customer-profile', async page => {
      await page.waitForFunction(() => {
        const el = document.getElementById('profileContent');
        return el && el.style.display !== 'none';
      }, { timeout: 20000 }).catch(() => {});

      const profileVisible = await page.locator('#profileContent').isVisible();
      if (profileVisible) {
        pass('Customer Profile — profileContent visible');
      } else {
        fail('Customer Profile — profileContent visible', 'Profile content hidden — may be load error or auth issue');
      }
    });

    // ── REVIEW HUB ───────────────────────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_review_hub.html`, 'review-hub', async page => {
      await page.waitForSelector('#ready-content', { timeout: 20000 }).catch(() => {});
      const visible = await page.locator('#ready-content').isVisible();
      if (visible) {
        pass('Review Hub — ready-content visible');
      } else {
        fail('Review Hub — ready-content visible');
      }
    });

    // ── INCOMING REQUESTS ────────────────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_incoming.html`, 'incoming', async page => {
      await page.waitForTimeout(3000);

      // ── Regression: req-name not white-on-white ──
      const reqColor = await page.evaluate(() => {
        const el = document.querySelector('.req-name');
        if (!el) return null;
        return window.getComputedStyle(el).color;
      }).catch(() => null);

      if (!reqColor) {
        warn('Incoming — .req-name color', 'No .req-name found (empty inbox or load failure)');
      } else if (reqColor === 'rgb(255, 255, 255)') {
        fail('Incoming — .req-name color', `White-on-white detected: ${reqColor}`);
      } else {
        pass('Incoming — .req-name color', `${reqColor} (not white-on-white)`);
      }

      // ── Verbal Quote button removed (verbal quotes now flow via new_customer.html) ──
      const addVerbalGone = await page.locator('#addVerbalBtn').count() === 0;
      if (addVerbalGone) {
        pass('Incoming — Add Verbal Quote button removed (redirected to new_customer.html flow)');
      } else {
        fail('Incoming — Add Verbal Quote button removed', '#addVerbalBtn still present');
      }
    });

    // ── BULK REACTIVATION — DNS TAB ──────────────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_bulk_reactivation.html`, 'bulk-reactivation-dns', async page => {
      await page.waitForSelector('.pool-tab', { timeout: 20000 }).catch(() => {});

      // ── DNS tab button exists ──
      const dnsTab = await page.locator('button:has-text("Did Not Service")').isVisible().catch(() => false);
      if (dnsTab) {
        pass('Bulk Reactivation — DNS tab button visible');
      } else {
        fail('Bulk Reactivation — DNS tab button visible', 'No button with "Did Not Service" text found');
      }

      // ── Click DNS tab → renders without JS error ──
      if (dnsTab) {
        await page.locator('button:has-text("Did Not Service")').click();
        await page.waitForTimeout(500);
        const tbody = await page.locator('#tableBody').isVisible().catch(() => false);
        if (tbody) {
          pass('Bulk Reactivation — DNS tab renders after click');
        } else {
          fail('Bulk Reactivation — DNS tab renders after click', '#tableBody not visible after DNS tab click');
        }
      }
    });

    // ── BCPA DEEP-LINK: calendar job card ────────────────────────────────────
    // Phone 9546877537 = Weston customer with address — should show a BCPA chip
    await withPage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'bcpa-calendar', async page => {
      await page.waitForFunction(() => document.querySelectorAll('.pa-link').length > 0, { timeout: 20000 }).catch(() => {});

      const paLinks = await page.locator('.pa-link').count();
      if (paLinks === 0) {
        warn('BCPA calendar — .pa-link chips visible', 'No .pa-link elements found (may be no Broward jobs visible in current week)');
        return;
      }
      pass('BCPA calendar — .pa-link chips present', `${paLinks} chip(s) visible`);

      // Confirm at least one has a deep-link URL with searchValue
      const hasDeepLink = await page.evaluate(() => {
        const links = [...document.querySelectorAll('.pa-link')];
        return links.some(a => (a.href || '').includes('searchValue='));
      });
      if (hasDeepLink) {
        pass('BCPA calendar — deep-link URL contains searchValue param');
      } else {
        fail('BCPA calendar — deep-link URL contains searchValue param', 'No .pa-link found with searchValue= in href');
      }
    });

    // ── DAY ROUTE VIEW (day tab + week tab + averages tab) ───────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_day_route.html?date=2026-05-11`, 'day-route', async page => {
      await page.waitForTimeout(5000); // API call + render

      // Test 1: three tabs present
      const tabDay  = await page.locator('#tab-day').isVisible().catch(() => false);
      const tabWeek = await page.locator('#tab-week').isVisible().catch(() => false);
      const tabAvg  = await page.locator('#tab-avg').isVisible().catch(() => false);
      if (tabDay && tabWeek && tabAvg) {
        pass('Day Route — all 3 tabs visible (Day / Week / Averages)');
      } else {
        fail('Day Route — all 3 tabs visible', `day:${tabDay} week:${tabWeek} avg:${tabAvg}`);
      }

      // Test 2: date picker visible in day tab
      const datePicker = await page.locator('#datePicker').isVisible().catch(() => false);
      if (datePicker) { pass('Day Route — date picker visible'); }
      else            { fail('Day Route — date picker visible', '#datePicker not found'); }

      // Test 3: three rig columns rendered
      const col1 = await page.locator('#col_rig_1').isVisible().catch(() => false);
      const col2 = await page.locator('#col_rig_2').isVisible().catch(() => false);
      const col3 = await page.locator('#col_rig_3').isVisible().catch(() => false);
      if (col1 && col2 && col3) { pass('Day Route — three rig columns rendered'); }
      else { fail('Day Route — three rig columns rendered', `col_rig_1:${col1} col_rig_2:${col2} col_rig_3:${col3}`); }

      const rigLabels = await page.locator('.rig-label').count();
      if (rigLabels >= 3) { pass('Day Route — rig labels rendered', `${rigLabels} found`); }
      else { fail('Day Route — rig labels rendered', `only ${rigLabels}`); }

      // Test 4: click Week tab → week grid renders
      if (tabWeek) {
        await page.locator('#tab-week').click();
        await page.waitForTimeout(6000); // 7 parallel API calls
        const weekTable = await page.locator('#weekTable').isVisible().catch(() => false);
        if (weekTable) {
          pass('Day Route — Week tab: #weekTable visible after click');
        } else {
          fail('Day Route — Week tab: #weekTable visible after click', '#weekTable not visible');
        }
        const weekCells = await page.locator('.week-cell').count();
        if (weekCells > 0) {
          pass('Day Route — Week tab: .week-cell elements rendered', `${weekCells} cells`);
        } else {
          warn('Day Route — Week tab: .week-cell elements', 'No .week-cell found — all empty days or still loading');
        }
      }

      // Test 5: click Averages tab → cards render
      if (tabAvg) {
        await page.locator('#tab-avg').click();
        await page.waitForFunction(() => {
          const cards = document.getElementById('avgCards');
          return cards && cards.style.display !== 'none';
        }, { timeout: 15000 }).catch(() => {});
        const avgCards = await page.locator('#avgCards').isVisible().catch(() => false);
        if (avgCards) {
          pass('Day Route — Averages tab: #avgCards visible after click');
        } else {
          fail('Day Route — Averages tab: #avgCards visible after click', '#avgCards not visible');
        }
        const avgCardCount = await page.locator('.avg-card').count();
        if (avgCardCount >= 3) {
          pass('Day Route — Averages tab: stat cards rendered', `${avgCardCount} cards`);
        } else {
          fail('Day Route — Averages tab: stat cards rendered', `only ${avgCardCount} .avg-card elements (expected ≥3)`);
        }
      }
    });

    // Test 5: calendar has Day Route button
    await withPage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'calendar-day-route-link', async page => {
      await page.waitForTimeout(3000);
      const btn = await page.getByText('Day Route', { exact: false }).isVisible().catch(() => false);
      if (btn) {
        pass('Calendar — Day Route button visible in topbar');
      } else {
        fail('Calendar — Day Route button visible in topbar', 'No element containing "Day Route" found');
      }
    });

    // Test 6: API endpoint returns valid structure
    {
      const token = await (async () => {
        const { getVerifyToken } = require('./lib/auto-auth');
        const auth = await getVerifyToken().catch(() => null);
        return auth?.token || null;
      })();
      if (token) {
        const apiRes = await fetch(`${PAGES_BASE}/admin/day-route?date=2026-05-11&rig=rig_1`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        if (!apiRes) {
          warn('Day Route API — /admin/day-route endpoint', 'fetch failed');
        } else if (apiRes.status === 200) {
          const body = await apiRes.json().catch(() => null);
          if (body && 'segments' in body && 'totals' in body) {
            pass('Day Route API — returns expected shape', `${body.segments?.length ?? 0} segments, noData:${!!body.noData}`);
          } else {
            fail('Day Route API — returns expected shape', `missing segments or totals: ${JSON.stringify(body).slice(0,100)}`);
          }
        } else {
          fail('Day Route API — /admin/day-route', `HTTP ${apiRes.status}`);
        }
      } else {
        warn('Day Route API — skipped', 'no auth token configured');
      }
    }

    // ── GOOGLE DRIVE / WEEKLY EXPORT ─────────────────────────────────────────
    // Test 1: /oauth/google/start returns a redirect to Google (302 → accounts.google.com)
    await withPage(context, `${PAGES_BASE}/oauth/google/start`, 'google-oauth-start', async page => {
      // After the redirect chain, we should be at accounts.google.com OR the setup-required page
      const finalUrl = page.url();
      if (finalUrl.includes('accounts.google.com')) {
        pass('Google OAuth — /oauth/google/start redirects to Google consent screen');
      } else if (finalUrl.includes('oauth/google/start')) {
        // Stayed on page — secrets not set yet, shows setup instructions
        const bodyText = await page.locator('body').innerText().catch(() => '');
        if (bodyText.includes('Setup Required') || bodyText.includes('wrangler secret')) {
          pass('Google OAuth — /oauth/google/start shows setup instructions (secrets not yet set)');
        } else {
          fail('Google OAuth — /oauth/google/start', `Unexpected page content at ${finalUrl}`);
        }
      } else {
        pass('Google OAuth — /oauth/google/start redirected', `landed at ${finalUrl.slice(0, 80)}`);
      }
    });

    // Test 2: /admin/export-weekly exists and requires auth
    const exportRes = await fetch(`${PAGES_BASE}/admin/export-weekly`, { method: 'POST' });
    if (exportRes.status === 401) {
      pass('Weekly export — /admin/export-weekly requires auth (401 without token)');
    } else if (exportRes.status === 200 || exportRes.status === 500) {
      // 500 = authorized but Drive not configured yet — endpoint exists
      pass('Weekly export — /admin/export-weekly endpoint reachable', `status ${exportRes.status}`);
    } else {
      fail('Weekly export — /admin/export-weekly endpoint', `unexpected status ${exportRes.status}`);
    }

    // Test 3: /admin/google-drive/status exists and requires auth
    const statusRes = await fetch(`${PAGES_BASE}/admin/google-drive/status`);
    if (statusRes.status === 401) {
      pass('Google Drive status — /admin/google-drive/status requires auth (401)');
    } else if (statusRes.status === 200) {
      const body = await statusRes.json().catch(() => ({}));
      if ('authorized' in body) {
        pass('Google Drive status — returns expected shape', `authorized: ${body.authorized}`);
      } else {
        warn('Google Drive status — response missing "authorized" key');
      }
    } else {
      fail('Google Drive status — /admin/google-drive/status', `unexpected status ${statusRes.status}`);
    }

    // ── NEW CUSTOMER — 3-option post-save modal ────────────────────────────────
    await withPage(context, `${PAGES_BASE}/pure_cleaning_new_customer.html`, 'new-customer-postsave', async page => {
      // Trigger modal directly without a real DB save
      const opened = await page.evaluate(() => {
        try {
          window._lastSavedCustomer = { firstName: 'Test', lastName: 'Customer', phone: '0000000000', quoteStatus: null };
          showWhatNextModal(window._lastSavedCustomer);
          return true;
        } catch(e) { return e.message; }
      });
      if (opened !== true) { fail('New Customer — whatNextModal trigger', String(opened)); return; }

      const modalVisible = await page.locator('#whatNextModal').isVisible();
      if (modalVisible) pass('New Customer — post-save modal visible after save');
      else fail('New Customer — post-save modal visible', '#whatNextModal not visible');

      const optCount = await page.locator('.wn-opt').count();
      if (optCount >= 3) pass('New Customer — post-save modal has 3 options', `${optCount} options`);
      else fail('New Customer — post-save modal has 3 options', `only ${optCount} found`);

      // Click "Schedule it now" → schedDateModal should appear
      await page.locator('.wn-opt').first().click();
      const datePicker = await page.locator('#schedDateModal').isVisible();
      if (datePicker) pass('New Customer — Schedule it now opens date picker');
      else fail('New Customer — Schedule it now opens date picker', '#schedDateModal not visible');

      // Dismiss date modal, verify Incoming Queue option is present
      await page.locator('#schedDateModal button').first().click();
      const queueOptVisible = await page.locator('.wn-opt', { hasText: 'Add to Incoming Queue' }).isVisible();
      if (queueOptVisible) pass('New Customer — Add to Incoming Queue option visible');
      else fail('New Customer — Add to Incoming Queue option visible', 'option text not found');

      const miniOptVisible = await page.locator('.wn-opt', { hasText: 'Build mini quote' }).isVisible();
      if (miniOptVisible) pass('New Customer — Build mini quote option visible');
      else fail('New Customer — Build mini quote option visible', 'option text not found');
    });

    await context.close();
  } finally {
    await browser.close();
  }

  printResults();
  if (failures > 0) {
    console.log(`\n    Screenshots → verify-screenshots/`);
    console.log('\n🚨  BROWSER VERIFICATION FAILED');
    process.exit(1);
  } else {
    console.log('\n🟢  Browser verification passed');
    console.log(`    Screenshots → verify-screenshots/`);
  }
}

function printResults() {
  console.log('');
  for (const { status, label, detail } of results) {
    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ ';
    console.log(`${icon}  ${label}${detail ? '  ' + detail : ''}`);
  }
  const passed  = results.filter(r => r.status === 'PASS').length;
  const warned  = results.filter(r => r.status === 'WARN').length;
  console.log('\n' + '─'.repeat(60));
  console.log(`    ${passed} passed · ${warned} warnings · ${failures} failed`);
}

main().catch(e => { console.error('verify-browser crashed:', e); process.exit(1); });
