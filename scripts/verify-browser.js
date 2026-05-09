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

const PAGES_BASE = 'https://purecleaningpressurecleaning.com';
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
    warn('Browser auth', 'No credentials configured. Add ADMIN_PASSWORD to .env.local to enable browser verification.');
    console.log('⚠️   No auth credentials — browser verification skipped (see .env.local.example)');
    process.exit(0);
  }
  pass('Browser auth', 'Session token obtained via auto-auth');

  if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

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

      // ── Regression: drag to navigate (drag day-header 160px left = next week) ──
      const labelBefore = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      const dayHdr = page.locator('.day-hdr').first();
      const box = await dayHdr.boundingBox().catch(() => null);
      if (box) {
        const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let i = 1; i <= 16; i++) await page.mouse.move(sx - i * 10, sy);
        await page.mouse.up();
        await page.waitForTimeout(500);
        const labelAfter = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
        if (labelBefore && labelAfter && labelBefore !== labelAfter) {
          pass('Calendar — drag to navigate', `${labelBefore} → ${labelAfter}`);
        } else {
          fail('Calendar — drag to navigate', `Week unchanged after 160px drag. Before: "${labelBefore}" After: "${labelAfter}"`);
        }
      } else {
        warn('Calendar — drag to navigate', 'No .day-hdr bounding box found');
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
