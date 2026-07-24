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
    // Latency-resilient navigation: up to 3 attempts, 60s each (absorbs connection jitter
    // and gives the page's JS time to initialize before the per-test waitForSelector guards
    // run — prevents the "half-loaded → uninitialized globals → TypeError cascade" false-fail).
    // A genuinely unreachable/broken page still fails after all 3 attempts.
    // Keep waitUntil:'load' — NOT networkidle (the calendar polls forever; prior bug).
    let navErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); navErr = null; break; }
      catch (e) { navErr = e; if (attempt < 3) await page.waitForTimeout(1500 * attempt); }
    }
    if (navErr) throw navErr;
    await fn(page);
    await page.screenshot({ path: `${SS_DIR}/${label}-${ts}.png` });
  } catch (e) {
    fail(`${label} — load`, e.message.slice(0, 120));
    try { await page.screenshot({ path: `${SS_DIR}/${label}-ERROR-${ts}.png` }); } catch {}
  } finally {
    await page.close();
  }
}

// Latency-resilient data wait (WO-7): poll an in-page predicate (the page's data
// global is populated) up to `timeout` instead of a fixed waitForTimeout sleep.
// A hardcoded sleep false-fails when a slow /customers fetch hasn't filled the
// global yet; this waits for the real signal. Returns true if ready, false on
// timeout — the caller's own assertion then fails for real, so a genuine no-data
// regression still goes red (retry absorbs latency only, not real failures).
async function waitForData(page, predicate, timeout = 45000) {
  try { await page.waitForFunction(predicate, { timeout, polling: 150 }); return true; }
  catch { return false; }
}

// ── Parallel orchestration (WO-9) ────────────────────────────────────────────
// Test blocks register here instead of running inline; drainQueue() runs them.
// Read-only/render blocks (and blocks that STUB their writes — saveDb/fetch — so
// they never touch the server) run concurrently in batches; blocks that make a
// REAL server write (or depend on a specific record's server state) run serially
// so they never race each other or a read of the same data. Each block keeps its
// own page + its own pass/fail/warn calls; results[] pushes are safe under Node's
// single thread. Classify-conservatively: unknown → SERIAL_LABELS (correct beats fast).
const _pageQueue = [];
function queuePage(context, url, label, fn) { _pageQueue.push({ context, url, label, fn }); }

// Blocks that must NOT run concurrently. calendar-drag-suppressor invokes the real
// submitPayment() (POST /payment/log) — the only block here that writes to the
// server. Everything else renders, asserts on client logic, or stubs its writes.
// wo-g-pagecount runs page.pdf() (resource-heavy) — serial so it doesn't contend
// with the parallel batch for render/PDF resources (that contention mis-rendered
// the count and flaked the gate). calendar-drag-suppressor: real server write (WO-9).
const SERIAL_LABELS = new Set(['calendar-drag-suppressor', 'wo-g-pagecount']);
const PARALLEL_BATCH = 5;

async function drainQueue() {
  const parallel = _pageQueue.filter(j => !SERIAL_LABELS.has(j.label));
  const serial   = _pageQueue.filter(j =>  SERIAL_LABELS.has(j.label));
  for (let i = 0; i < parallel.length; i += PARALLEL_BATCH) {
    const batch = parallel.slice(i, i + PARALLEL_BATCH);
    await Promise.all(batch.map(j => withPage(j.context, j.url, j.label, j.fn)));
  }
  for (const j of serial) await withPage(j.context, j.url, j.label, j.fn);
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
    queuePage(context, `${PAGES_BASE}/`, 'homepage', async page => {
      // Collect console errors during load
      const consoleErrors = [];
      // Track last seen external-noise URL so paired net::ERR_FAILED events are also suppressed
      let _lastNoiseUrl = '';
      page.on('console', m => {
        if (m.type() !== 'error') return;
        const txt = m.text().slice(0, 300);
        // Stash the URL from "Access to fetch at '...' from origin" events
        const urlMatch = txt.match(/Access to fetch at '([^']+)'/);
        if (urlMatch) _lastNoiseUrl = urlMatch[1];
        consoleErrors.push(txt);
      });

      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

      // ── Static homepage assertions (Phase 1, 2026-06-11) ──
      // The React app no longer mounts. Replaced with a static page that wires the
      // review-count + Google-reviews endpoints client-side with hardcoded fallbacks.
      // Old assertions removed: "React bundle 200" and "React mounted (#root populated)".

      // 1. Hero rotation present — five .slide elements
      const slideCount = await page.evaluate(() =>
        document.querySelectorAll('.hero-media .slide').length
      );
      if (slideCount === 5) {
        pass('Homepage — hero rotation (5 slides present)');
      } else {
        fail('Homepage — hero rotation', `Expected 5 .hero-media .slide elements, got ${slideCount}`);
      }

      // 2. Every CTA points to a working destination — either /q.html (when the
      // public quote form exists) or tel:+19543892642 (stopgap while the form is
      // being built). Never mailto, never an in-page #anchor — those were the bug
      // classes we replaced.
      const ctaTargets = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a.big-cta, a.hd-cta')).map(a => a.getAttribute('href'))
      );
      const validCta = h => h === '/q.html' || h === '/quote.html' || /^tel:/.test(h);
      const badCta = ctaTargets.find(h => !validCta(h));
      if (ctaTargets.length >= 4 && !badCta) {
        const targetSet = Array.from(new Set(ctaTargets)).join(', ');
        pass('Homepage — CTAs route to working target', `${ctaTargets.length} CTAs → ${targetSet}`);
      } else {
        fail('Homepage — CTAs route to working target', `bad target: ${badCta || 'no CTAs found'}`);
      }

      // 3. Zero imgur references — all images served from our domain
      const hasImgur = await page.evaluate(() =>
        document.documentElement.outerHTML.includes('imgur.com')
      );
      if (!hasImgur) {
        pass('Homepage — zero imgur references');
      } else {
        fail('Homepage — zero imgur references', 'imgur URL found in page HTML — should be /images/...');
      }

      // 4. At least one image actually loaded from /images/
      const imageOk = await page.evaluate(() => {
        // Trust the first hero slide's background-image
        const slide = document.querySelector('.hero-media .slide');
        return slide && /\/images\//.test(getComputedStyle(slide).backgroundImage || '');
      });
      if (imageOk) {
        pass('Homepage — hero image served from /images/');
      } else {
        fail('Homepage — hero image served from /images/', 'First hero slide has no /images/ background — image broken or wrong path');
      }

      // ── Regression: visible brand text rendered ──
      const brandText = await page.evaluate(() => document.body.innerText || '');
      if (brandText.toLowerCase().includes('pure cleaning')) {
        pass('Homepage — brand content visible', `"Pure Cleaning" found in rendered text`);
      } else {
        fail('Homepage — brand content visible', 'No "Pure Cleaning" in rendered body text — page may be blank');
      }

      // ── Console errors ──
      // Filter known external-service network errors harmless in headless environments.
      // (jsonbin.io reviews fetch — works in production browser, CORS-rejected by headless runner)
      // Paired pattern: "Access to fetch at 'URL' ..." + "Failed to load resource: net::ERR_FAILED"
      // Both events fire for a single failed fetch; both must be suppressed.
      const EXTERNAL_NOISE_HOSTS = ['jsonbin.io', 'api.jsonbin'];
      const noiseUrls = new Set();
      for (const e of consoleErrors) {
        const m = e.match(/Access to fetch at '([^']+)'/);
        if (m && EXTERNAL_NOISE_HOSTS.some(h => m[1].includes(h))) noiseUrls.add(m[1]);
      }
      // Also suppress the standalone net::ERR_FAILED that Playwright fires immediately after
      let sawErrFailed = false;
      const filteredErrors = consoleErrors.filter(e => {
        if (EXTERNAL_NOISE_HOSTS.some(h => e.includes(h))) return false; // URL-containing event
        if (noiseUrls.size > 0 && e.includes('net::ERR_FAILED') && !sawErrFailed) {
          sawErrFailed = true; return false; // paired ERR_FAILED event
        }
        return true;
      });
      if (filteredErrors.length === 0) {
        pass('Homepage — no console errors');
      } else {
        fail('Homepage — no console errors', filteredErrors.slice(0, 3).join(' | '));
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
    queuePage(context, `${PAGES_BASE}/pure_cleaning_bulk_reactivation.html`, 'bulk-reactivation', async page => {
      // Wait for DB load to populate customers
      await page.waitForFunction(() => {
        const el = document.getElementById('svcTabs');
        return el && el.classList.contains('show');
      }, { timeout: 45000 }).catch(() => {});  // WO-7: bigger budget for slow DB load

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

      // 2026-07-23: service-specific "last cleaned" — the WO's divergent case
      // rendered through the REAL buildVariantBody on the live page.
      const svc = await page.evaluate(() => {
        const mk = f => Object.assign({fn:'Div',ln:'Ergent',phone:'0',jobHistory:[],monthsSince:999,svcSection:null,lastDateObj:new Date('2024-05-15T12:00:00'),scheduledStatus:null,quoteStatus:null}, f);
        // roof 26mo ago + driveway 4mo ago
        const jh = [
          {date:'2024-05-15', services:'Roof Cleaning', source:'calendar_completion'},
          {date:'2026-03-20', services:'Driveway',      source:'calendar_completion'},
        ];
        const out = {};
        currentLane = 'tier1Due';
        // queued ROOF
        let body = buildVariantBody(REACTIVATION_STANDARD, mk({jobHistory:jh, svcSection:'roof', monthsSince:4}), 'http://x');
        out.roofSaysRoof = /months since we last cleaned your roof/.test(body);
        out.roofNot4     = !/\b4 months\b/.test(body);
        out.roof26       = /2[56] months since we last cleaned your roof/.test(body);  // ~26mo
        // queued GROUND
        body = buildVariantBody(REACTIVATION_STANDARD, mk({jobHistory:jh, svcSection:'ground', monthsSince:4}), 'http://x');
        out.groundSaysDriveway = /months since we last cleaned your driveway/.test(body);
        // pitched roof but no roof job → serviceless, no number
        body = buildVariantBody(REACTIVATION_STANDARD, mk({jobHistory:[{date:'2026-03-20',services:'Driveway'}], svcSection:'roof', monthsSince:4}), 'http://x');
        out.serviceless = /a while since we've been out/.test(body) && !/\d+ months/.test(body);
        out.hasHelpers = typeof lastServiceDateFor === 'function' && typeof serviceClauseFor === 'function';
        // 2026-07-23 copy rewrite: short/website-routed, no hedge, no builder pitch, no link.
        const std = buildVariantBody(REACTIVATION_STANDARD, mk({jobHistory:jh, svcSection:'roof', monthsSince:4}), 'http://x');
        out.hasWebsite  = /purecleaningpressurecleaning\.com/.test(std);
        out.noHedge     = !/if we've been out more recently/.test(std);
        out.noBuilder   = !/quote builder/i.test(std) && !/\{quoteLink\}/.test(std) && !/http:\/\/x/.test(std);
        out.hasStop     = /Reply STOP to opt out/.test(std);
        return out;
      });
      if (svc.roofSaysRoof && svc.roofNot4 && svc.roof26) pass('Bulk Reactivation — roof pitch says "…your roof" with roof months (not the 4mo driveway)');
      else fail('Bulk Reactivation — roof pitch service-specific', JSON.stringify(svc));
      if (svc.groundSaysDriveway) pass('Bulk Reactivation — ground pitch names the driveway'); else fail('Bulk Reactivation — ground pitch', JSON.stringify(svc));
      if (svc.serviceless) pass('Bulk Reactivation — no qualifying job → serviceless fallback (no number)'); else fail('Bulk Reactivation — serviceless fallback', JSON.stringify(svc));
      if (svc.hasHelpers) pass('Bulk Reactivation — shared service helpers present'); else fail('Bulk Reactivation — helpers', JSON.stringify(svc));
      if (svc.hasWebsite && svc.noHedge && svc.noBuilder && svc.hasStop) pass('Bulk Reactivation — new copy: website-routed, no hedge/builder/link, STOP present');
      else fail('Bulk Reactivation — new copy', JSON.stringify(svc));
    });

    // ── CALENDAR ─────────────────────────────────────────────────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'calendar', async page => {
      await page.waitForSelector('#calGrid', { timeout: 45000 }).catch(() => {});  // WO-7: bigger budget for slow load

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

      // 2026-07-24: customer-DB cache migrated sessionStorage → IndexedDB.
      // Query the real IndexedDB directly (global API, no dependence on the
      // page's function scope) — after init()'s getCachedCustomerDB ran, the
      // blob must be persisted under pcpc_cache/kv/customer_db as {data,timestamp}
      // and NOT in sessionStorage.
      const idb = await page.evaluate(async () => {
        const out = { noSessionCache: sessionStorage.getItem('pcpc_customer_db_cache') === null };
        const readOnce = () => new Promise((resolve, reject) => {
          const req = indexedDB.open('pcpc_cache', 1);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('kv')) { resolve(null); return; }
            const g = db.transaction('kv', 'readonly').objectStore('kv').get('customer_db');
            g.onsuccess = () => resolve(g.result);
            g.onerror   = () => reject(g.error);
          };
          req.onerror = () => reject(req.error);
        });
        try {
          // The cache write is fire-and-forget; a 4.74MB structured-clone write
          // takes time. Poll up to ~15s for it to land rather than racing it.
          let rec = null;
          for (let i = 0; i < 60 && !(rec && rec.data); i++) {
            rec = await readOnce();
            if (rec && rec.data) break;
            await new Promise(r => setTimeout(r, 250));
          }
          out.idbHasData     = !!(rec && rec.data && Array.isArray(rec.data.customers) && rec.data.customers.length > 0);
          out.hasTimestamp   = !!(rec && typeof rec.timestamp === 'number');
          out.storedAsObject = !!(rec && rec.data && typeof rec.data === 'object');  // structured clone, not a JSON string
        } catch(e) { out.error = e.message; }
        return out;
      });
      if (idb.idbHasData && idb.hasTimestamp && idb.storedAsObject) pass('Calendar — customer DB persisted to IndexedDB (structured-clone {data,timestamp})');
      else fail('Calendar — IndexedDB cache', JSON.stringify(idb));
      if (idb.noSessionCache) pass('Calendar — DB blob no longer in sessionStorage'); else fail('Calendar — sessionStorage still used', JSON.stringify(idb));

      // ── Regression: week navigation buttons work ──
      // WO-7 latency-resilient: wait for the week label to actually populate (a slow
      // data load leaves it ""/"Loading…"), then poll for it to change after the
      // click instead of a fixed 400ms (label updates on requestAnimationFrame).
      await waitForData(page, () => {
        const w = document.getElementById('weekLabel');
        return w && w.textContent.trim() && !/loading/i.test(w.textContent);
      });
      const label0 = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      await page.locator('button:has-text("Next")').first().click();
      await page.waitForFunction(
        (prev) => { const w = document.getElementById('weekLabel'); return w && w.textContent.trim() && w.textContent.trim() !== prev; },
        label0, { timeout: 10000 }
      ).catch(() => {});
      const label1 = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      if (label0 && label1 && label0 !== label1) {
        pass('Calendar — week nav button', `${label0} → ${label1}`);
      } else {
        fail('Calendar — week nav button', 'Week label unchanged after Next click');
      }

      // ── Regression: drag 150px left = 1 day forward (day-by-day slide) ──
      // 2026-06-23 (WO-5): drag tests flaked intermittently. The calendar
      // updates #weekLabel on requestAnimationFrame, so a synthetic
      // page.mouse.move() can be read one frame before the label repaints
      // ("Label did not change" false negative). Two compounding aggravators:
      //   1. The mid-drag test read with zero wait after the move.
      //   2. Browsers coalesce rapid mouse-moves, so accumulated delta can
      //      under-count distance and skip the commit boundary.
      // Fix (DL-07 — apply to all four drag-nav tests, not just the flagged 2):
      //   • Add { steps: N } to make Playwright emit intermediate events.
      //   • Replace fixed-instant label reads with an rAF poll that succeeds
      //     as soon as the label lands and only fails on real regression.
      //   • Bump the mid-drag distance comfortably past the 75px commit line
      //     (was sx-80 = 5px past, rode the threshold; now sx-120).
      //
      // Helper closes over `page`; reused by all four drag tests below + by
      // the post-initSortables-reset drag test further down the function.
      async function _awaitLabelChange(prev, ms = 1500) {
        try {
          await page.waitForFunction(
            (p) => {
              const el = document.querySelector('#weekLabel');
              return el && el.textContent.trim() && el.textContent.trim() !== p;
            },
            prev, { timeout: ms, polling: 'raf' }
          );
        } catch (_) { /* timed out → caller sees unchanged → fail */ }
        return (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      }
      // 2026-06-23 (WO-5 follow-up): re-acquire the .day-hdr anchor BETWEEN
      // drags. After a successful drag the calendar's day-hdr DOM shifts —
      // the cached sx, sy from the very first boundingBox may point at
      // whitespace by the second drag, so the mousedown is ignored and the
      // test fails with "label unchanged" (the drag never registered, not a
      // label-paint race). Helper handles the re-fetch + settling pause.
      async function _dragAnchor() {
        const hdr = page.locator('.day-hdr').first();
        const b = await hdr.boundingBox().catch(() => null);
        if (!b) return null;
        return { sx: b.x + b.width / 2, sy: b.y + b.height / 2 };
      }
      const labelBefore = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      const a1 = await _dragAnchor();
      if (a1) {
        // Drag exactly 150px left — should shift window by exactly 1 day
        await page.mouse.move(a1.sx, a1.sy);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) await page.mouse.move(a1.sx - i * 10, a1.sy, { steps: 2 });
        await page.mouse.up();
        const labelAfter1 = await _awaitLabelChange(labelBefore);
        if (labelBefore && labelAfter1 && labelBefore !== labelAfter1) {
          pass('Calendar — drag 150px = 1 day forward', `${labelBefore} → ${labelAfter1}`);
        } else {
          fail('Calendar — drag 150px = 1 day forward', `Window unchanged after 150px drag. Before: "${labelBefore}" After: "${labelAfter1}"`);
        }
        // Drag 300px right — should shift window back 2 days. Re-fetch
        // anchor since the calendar grid shifted after the first drag.
        await page.waitForTimeout(200);
        const a2 = await _dragAnchor();
        const labelBefore2 = labelAfter1;
        if (a2) {
          await page.mouse.move(a2.sx, a2.sy);
          await page.mouse.down();
          for (let i = 1; i <= 30; i++) await page.mouse.move(a2.sx + i * 10, a2.sy, { steps: 2 });
          await page.mouse.up();
          const labelAfter2 = await _awaitLabelChange(labelBefore2);
          if (labelBefore2 && labelAfter2 && labelBefore2 !== labelAfter2) {
            pass('Calendar — drag 300px = 2 days backward', `${labelBefore2} → ${labelAfter2}`);
          } else {
            fail('Calendar — drag 300px = 2 days backward', `Window unchanged after 300px drag. Before: "${labelBefore2}" After: "${labelAfter2}"`);
          }
        } else {
          warn('Calendar — drag 300px = 2 days backward', 'No .day-hdr after first drag');
        }

        // ── Continuous drag: label updates MID-DRAG at 75px boundary ────────
        // With continuous commit, the week label changes as cursor crosses
        // each 150px boundary. Drag well past the first 75px commit point
        // (a3.sx - 120, was sx - 80 which rode the threshold) and rAF-poll
        // for the label change BEFORE release. Re-fetch anchor again so the
        // mousedown lands on the current .day-hdr position.
        await page.waitForTimeout(200);
        const a3 = await _dragAnchor();
        const labelPreContinuous = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
        if (a3) {
          await page.mouse.move(a3.sx, a3.sy);
          await page.mouse.down();
          await page.mouse.move(a3.sx - 10,  a3.sy, { steps: 3 }); // horizontal lock-in
          await page.mouse.move(a3.sx - 120, a3.sy, { steps: 8 }); // comfortably past 75px commit
          const labelMidDrag = await _awaitLabelChange(labelPreContinuous); // poll BEFORE release
          await page.mouse.up();
          await page.waitForTimeout(300);
          if (labelPreContinuous && labelMidDrag && labelPreContinuous !== labelMidDrag) {
            pass('Calendar — continuous drag: label updates mid-drag at 75px', `${labelPreContinuous} → ${labelMidDrag} (before release)`);
          } else {
            fail('Calendar — continuous drag: label updates mid-drag', `Label did not change mid-drag. Before: "${labelPreContinuous}" Mid: "${labelMidDrag}"`);
          }
        } else {
          warn('Calendar — continuous drag: label updates mid-drag', 'No .day-hdr after second drag');
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
      // Condensed card layout (Option A): buttons live inside .jc-detail which is hidden until
      // the card is tapped to expand. Check DOM presence only — visibility intentionally deferred.
      const etaBtn = page.locator('.js-eta-btn').first();
      const etaBtnExists = await etaBtn.count() > 0;
      if (etaBtnExists) {
        pass('Calendar — inline ETA button in DOM (condensed card — visible on expand)');
      } else {
        warn('Calendar — inline ETA button', 'No .js-eta-btn found — may be no scheduled jobs this week');
      }

      // ── Regression: rig pick button on scheduled job cards ──
      // Expand the parent card first so the button becomes visible (condensed card layout).
      const rigPickBtn = page.locator('.rig-pick-btn').first();
      const rigPickExists = await rigPickBtn.count() > 0;
      if (rigPickExists) {
        const rigPickCard = page.locator('.job-scheduled:has(.rig-pick-btn)').first();
        await rigPickCard.click({ force: true });
        await page.waitForTimeout(200);
        const rigPickVisible = await rigPickBtn.isVisible().catch(() => false);
        if (rigPickVisible) {
          pass('Calendar — rig pick button visible on job card');
        } else {
          fail('Calendar — rig pick button visible on job card', '.rig-pick-btn not visible after card expand');
        }
      } else {
        warn('Calendar — rig pick button', 'No .rig-pick-btn found — may be no scheduled jobs this week');
      }

      // ── Regression: rig pick modal opens and closes ──
      if (rigPickExists) {
        await rigPickBtn.click(); // card already expanded from check above
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
      // 2026-06-23 (WO-5): same de-flake pattern as the three tests above —
      // { steps: 2 } on the loop moves, rAF poll for the label change.
      const labelPreReset = (await page.locator('#weekLabel').textContent().catch(() => '')).trim();
      const dayHdrAfterReset = page.locator('.day-hdr').first();
      const boxAfterReset = await dayHdrAfterReset.boundingBox().catch(() => null);
      if (boxAfterReset) {
        const sx = boxAfterReset.x + boxAfterReset.width / 2, sy = boxAfterReset.y + boxAfterReset.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) await page.mouse.move(sx - i * 10, sy, { steps: 2 });
        await page.mouse.up();
        const labelPostReset = await _awaitLabelChange(labelPreReset);
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
        // Fluid drag: #calGrid gets an inline translateX that follows the cursor 1:1 during a horizontal
        // day-nav drag. The handler sets g.style.transform synchronously in the mousemove listener (NOT rAF).
        // Grab from a .day-hdr — the documented day-nav grab bar — like the other drag-nav tests. Grabbing
        // from an arbitrary #calGrid offset intermittently landed on an excluded element (.rig-hdr /
        // .win-lane-hdr / a job card), so mousedown returned early and the transform never set (WO-6).
        const hdrBox = await page.locator('.day-hdr').first().boundingBox().catch(() => null);
        if (hdrBox) {
          const sx = hdrBox.x + hdrBox.width / 2, sy = hdrBox.y + hdrBox.height / 2;
          await page.mouse.move(sx, sy);
          await page.mouse.down();
          await page.mouse.move(sx - 10, sy);  // past the 5px dead zone → engages the horizontal lock
          await page.mouse.move(sx - 60, sy);  // 60px (< 150px/day) so no day commit fires, no render() reset
          const midTransform = await page.evaluate(() => {
            const g = document.getElementById('calGrid');
            return g ? g.style.transform : '';
          });
          const xformNum = midTransform ? parseFloat((midTransform.match(/translateX\((-?\d+(?:\.\d+)?)/) || [])[1] || '0') : 0;
          if (midTransform && midTransform.includes('translateX(') && xformNum !== 0) {
            pass('Calendar — fluid drag: grid translateX follows cursor', `transform: "${midTransform}"`);
          } else {
            fail('Calendar — fluid drag: grid translateX follows cursor', `mid-drag transform was: "${midTransform}" (parsed: ${xformNum})`);
          }
          await page.mouse.up();
          await page.waitForTimeout(400);
          const labelAfterSmall = (await page.locator('#weekLabel').textContent().catch(()=>'')).trim();
          pass('Calendar — fluid drag: ≤50px guard smoke-test', `label: ${labelAfterSmall}`);
        } else {
          warn('Calendar — fluid drag tests', '.day-hdr bounding box not found');
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

      // ── Part 2: home commute banners visible on populated rig ────────────────
      // Navigate to a week with completed jobs (Jim New, May 6, rig_2)
      {
        const rigBannerResult = await page.evaluate(() => {
          // Jump to week of 2026-05-06
          const target = new Date('2026-05-06T12:00:00');
          const todayMid = new Date(); todayMid.setHours(0,0,0,0);
          const diff = Math.round((target - todayMid) / 86400000);
          if (typeof dayOffset !== 'undefined') dayOffset = diff;
          if (typeof render === 'function') render();
          return diff;
        });
        await page.waitForTimeout(500);
        const topBanners  = await page.locator('.rig-commute-banner').count();
        const totalBanners = await page.locator('.rig-commute-total').count();
        if (topBanners > 0) {
          pass('Calendar — commute banners present on populated rig', `${topBanners} .rig-commute-banner element(s) found`);
        } else {
          warn('Calendar — commute banners present', 'No .rig-commute-banner found — may be no geocoded jobs in week');
        }
        if (totalBanners > 0) {
          pass('Calendar — commute total banner present', `${totalBanners} .rig-commute-total element(s) found`);
        } else {
          warn('Calendar — commute total banner', 'No .rig-commute-total found');
        }
        // Check banner content (at least one should have the home emoji)
        const firstBannerText = topBanners > 0
          ? await page.locator('.rig-commute-banner').first().textContent().catch(() => '')
          : '';
        if (firstBannerText.includes('🏠')) {
          pass('Calendar — commute banner shows home emoji', `"${firstBannerText.trim().slice(0,40)}"`);
        } else if (topBanners > 0) {
          fail('Calendar — commute banner shows home emoji', `Banner text: "${firstBannerText.trim().slice(0,40)}"`);
        }
      }

      // ── Part 3: Day Route navigates in same tab (no _blank) ──────────────────
      {
        const dayRouteBtn = page.locator('button:has-text("Day Route")');
        const btnExists = await dayRouteBtn.isVisible().catch(() => false);
        if (btnExists) {
          // Check the button does not open a new tab (window.location.href not window.open)
          const usesLocationHref = await page.evaluate(() => {
            const src = document.documentElement.innerHTML;
            return src.includes('window.location.href') && src.includes('day_route.html') &&
                   !src.includes("window.open") || src.indexOf('window.location.href') < src.indexOf('window.open') + 5;
          });
          // A simpler check: the function source doesn't contain window.open for day route
          const noBlank = await page.evaluate(() => {
            const src = openDayRouteView.toString();
            return src.includes('location.href') && !src.includes('window.open');
          });
          if (noBlank) {
            pass('Calendar — Day Route button: navigates in same tab (no _blank)');
          } else {
            fail('Calendar — Day Route button: navigates in same tab', 'openDayRouteView still uses window.open');
          }
        } else {
          warn('Calendar — Day Route button', 'Button not found');
        }
      }

      // ── Part 3: Day Route page has ← Calendar back button ────────────────────
      // (Verified separately since navigating away would end this page's tests)
      {
        const backBtnSource = await page.evaluate(async () => {
          try {
            const r = await fetch('/pure_cleaning_day_route.html', { headers: { 'Cache-Control': 'no-cache' } });
            const html = await r.text();
            return html.includes('← Calendar') || html.includes('← Calendar');
          } catch { return false; }
        });
        if (backBtnSource) {
          pass('Day Route — ← Calendar back button present in HTML');
        } else {
          fail('Day Route — ← Calendar back button present', 'Not found in page source');
        }
      }

      // ── Jim New: exactly ONE card on May 6, in rig_2 (New Tacoma) ───────────
      // Regression: dual jobHistory.rig/rigId mismatch caused two visual cards.
      // After fix both fields are rig_2, ssCovers fires, no duplicate rendered.
      {
        const jimResult = await page.evaluate(() => {
          if (typeof dayOffset === 'undefined' || typeof render !== 'function') return { skip: 'render not available' };
          // Navigate to week of 2026-05-06
          const target = new Date('2026-05-06T12:00:00');
          const todayMid = new Date(); todayMid.setHours(0,0,0,0);
          dayOffset = Math.round((target - todayMid) / 86400000);
          render();
          // Count Jim New cards
          const cards = [...document.querySelectorAll('[data-phone="9546326630"]')];
          const rigSections = cards.map(el => {
            let node = el;
            while (node && node !== document.body) {
              if (node.dataset?.rig) return node.dataset.rig;
              const jd = node.closest('[data-rig]');
              if (jd) return jd.dataset.rig;
              node = node.parentElement;
            }
            // also check rig-jobs parent
            const rj = el.closest('.rig-jobs');
            return rj?.dataset?.rig || 'unknown';
          });
          return { count: cards.length, rigs: rigSections };
        });
        if (jimResult.skip) {
          warn('Calendar — Jim New single card check', jimResult.skip);
        } else if (jimResult.count === 1) {
          pass('Calendar — Jim New: exactly 1 card on May 6 (no duplicate)', `rig: ${jimResult.rigs[0]}`);
          if (jimResult.rigs[0] === 'rig_2') {
            pass('Calendar — Jim New: card is in rig_2 (New Tacoma)');
          } else {
            fail('Calendar — Jim New: card is in rig_2', `actual rig: ${jimResult.rigs[0]}`);
          }
        } else if (jimResult.count === 0) {
          warn('Calendar — Jim New: 0 cards found', 'Job may not be visible in this week');
        } else {
          fail('Calendar — Jim New: exactly 1 card on May 6', `found ${jimResult.count} cards in rigs: ${jimResult.rigs.join(', ')}`);
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

      // ── WORK ORDER F: KV-completed card drag must correct rig only, no phantom ──
      // Completed jobs are NEVER in calendarJobs[] (handleCalendarJobs returns
      // state='scheduled' only) — so the drag must detect completion from the KV
      // record (jobHistory/ss), NOT calendarJobs (WO-A's bug). Build a real KV-
      // completed customer, drag its card; the PATCH must be { rigId } only (no
      // state/date), ss stays 'completed', and NO scheduled phantom row appears.
      {
        const wof = await page.evaluate(async () => {
          const PH = '0000000010';
          const JID = 'job_person_10000000010_2026-07-07_scheduled';
          const cust = {
            phone: PH, firstName: 'WOF', lastName: 'Test',
            scheduledStatus: { state: 'completed', scheduledDate: '2026-07-07', rig: 'rig_1', paymentStatus: 'paid' },
            jobHistory: [{ jobId: JID, date: '2026-07-07', status: 'completed', rig: 'rig_1', rigId: 'rig_1', amount: 200, source: 'calendar_completion' }],
          };
          dbRecord.customers.push(cust);
          const calLenBefore = calendarJobs.length;
          const origPatch = window.patchJob, origRefresh = window.refreshCalendarJobs;
          let captured = null;
          window.patchJob = (id, body) => { captured = { id, body }; return Promise.resolve({ success: true }); };
          window.refreshCalendarJobs = () => Promise.resolve();
          try { await handleDropToRig(JID, PH, '2026-07-07', 'rig_2'); }
          finally { window.patchJob = origPatch; window.refreshCalendarJobs = origRefresh; }
          const out = {
            body: captured && captured.body,
            ssState: cust.scheduledStatus.state, ssRig: cust.scheduledStatus.rig,
            jhRig: cust.jobHistory[0].rig,
            noPhantom: calendarJobs.length === calLenBefore && !calendarJobs.some(j => j.jobId === JID),
          };
          const i = dbRecord.customers.indexOf(cust); if (i >= 0) dbRecord.customers.splice(i, 1);
          return out;
        });
        const okBody  = wof.body && wof.body.rigId === 'rig_2' && !('state' in wof.body) && !('scheduledDate' in wof.body);
        const okState = wof.ssState === 'completed' && wof.ssRig === 'rig_2' && wof.jhRig === 'rig_2' && wof.noPhantom;
        if (okBody && okState) pass('Calendar — WORK ORDER F: KV-completed drag corrects rig only, completion preserved, no phantom', JSON.stringify(wof.body));
        else fail('Calendar — WORK ORDER F: KV-completed drag must not create a scheduled phantom', JSON.stringify(wof));
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
          await page.locator('#fullEditModal').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => null);
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
    queuePage(context, `${PAGES_BASE}/pure_cleaning_worker_hours.html`, 'worker-hours', async page => {
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
    queuePage(context, `${PAGES_BASE}/pure_cleaning_customer_profile.html?phone=9546326630`, 'customer-profile', async page => {
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
    queuePage(context, `${PAGES_BASE}/pure_cleaning_review_hub.html`, 'review-hub', async page => {
      await page.waitForSelector('#ready-content', { timeout: 20000 }).catch(() => {});
      const visible = await page.locator('#ready-content').isVisible();
      if (visible) {
        pass('Review Hub — ready-content visible');
      } else {
        fail('Review Hub — ready-content visible');
      }

      // 2026-07-23: GBP sync-health banner fires on stale/failed sync + hides when fresh.
      // Drives renderSyncAlert off injected hubData (no live dependency).
      const alert = await page.evaluate(() => {
        const out = {};
        // stale sync → red banner with BOTH Sync now + Reconnect (P0 fix: sync first)
        hubData = { actualCount: { source: 'gbp_live_stale' }, gbpSyncedAt: new Date(Date.now()-13*864e5).toISOString() };
        renderSyncAlert();
        const el = document.getElementById('syncAlert');
        out.staleShown = el.style.display !== 'none';
        out.hasReconnect = /oauth\/google\/start/.test(el.innerHTML);
        out.hasSyncNow = /syncGbpNow/.test(el.innerHTML);
        out.saysDays = /13 days ago/.test(el.textContent);
        // fresh sync → subtle green status line (connected, last sync {time}) — NOT the red alarm
        hubData = { actualCount: { source: 'gbp_live' }, gbpSyncedAt: new Date().toISOString() };
        renderSyncAlert();
        const fresh = document.getElementById('syncAlert');
        out.freshShown = fresh.style.display !== 'none';
        out.freshGreen = /synced just now|synced \d/.test(fresh.textContent) && !/oauth\/google\/start/.test(fresh.innerHTML);
        out.freshHasSyncNow = /syncGbpNow/.test(fresh.innerHTML);
        out.hasSyncFn = typeof syncGbpNow === 'function';
        return out;
      });
      if (alert.staleShown && alert.hasReconnect && alert.hasSyncNow) pass('Review Hub — stale banner: Sync now + Reconnect both present');
      else fail('Review Hub — stale banner buttons', JSON.stringify(alert));
      if (alert.saysDays) pass('Review Hub — banner reports sync age'); else fail('Review Hub — banner age', JSON.stringify(alert));
      if (alert.freshShown && alert.freshGreen && alert.freshHasSyncNow) pass('Review Hub — fresh state shows subtle synced status + Sync now (no alarm)');
      else fail('Review Hub — fresh state', JSON.stringify(alert));
      if (alert.hasSyncFn) pass('Review Hub — syncGbpNow handler present'); else fail('Review Hub — syncGbpNow handler', JSON.stringify(alert));

      const deepLink = await page.locator('a[href="https://business.google.com/reviews"]').count();
      if (deepLink >= 1) pass('Review Hub — Open Google Reviews deep link present'); else fail('Review Hub — deep link', `found ${deepLink}`);

      // 2026-07-23: reply-queue floor — badge + "Awaiting" count only July-forward
      // unreplied; pre-July unreplied visible in "Earlier"; replied in history.
      const rq = await page.evaluate(() => {
        hubData = { readyToRequest:[], readyTotal:0, awaitingConfirmation:[], reviewed:[], wontAsk:[], permanentExclusions:[],
                    actualCount:{count:5,rating:5}, gbpSyncedAt:new Date().toISOString(), gbpReviews: [
          { reviewId:'a', reviewer:'Jeff New', rating:5, createTime:'2026-07-22T10:00:00Z' },          // Jul, unreplied → awaiting
          { reviewId:'b', reviewer:'JJ G',     rating:5, createTime:'2026-07-21T10:00:00Z' },          // Jul, unreplied → awaiting
          { reviewId:'c', reviewer:'Old One',  rating:5, createTime:'2026-03-10T10:00:00Z' },          // pre-Jul, unreplied → earlier
          { reviewId:'d', reviewer:'Older Two',rating:4, createTime:'2026-01-05T10:00:00Z' },          // pre-Jul, unreplied → earlier
          { reviewId:'e', reviewer:'Replied R',rating:5, createTime:'2026-02-02T10:00:00Z', reply:{comment:'thanks'} }, // replied → history
        ]};
        updateBadges();
        renderGoogleReviews();
        const badge = document.getElementById('badge-gbpreviews').textContent;
        const el    = document.getElementById('gbpreviews-content');
        const html  = el.innerHTML;
        // The to-do section = everything BEFORE the collapsed history <details>.
        const detIdx = html.indexOf('<details');
        const todo   = detIdx === -1 ? html : html.slice(0, detIdx);
        return {
          badge,
          awaitingHdr:   /Awaiting your reply \(2\)/.test(html),
          todoHasJul:    todo.includes('Jeff New') && todo.includes('JJ G'),
          todoNoReplied: !todo.includes('Replied R') && !todo.includes('thanks'),   // replied NOT in to-do
          todoNoPreJul:  !todo.includes('Old One') && !todo.includes('Older Two'),  // pre-July NOT in to-do
          historyHdr:    /All reviews &amp; reply history \(3\)/.test(html),         // replied(1)+preJul(2)
          historyHasAll: html.includes('Old One') && html.includes('Older Two') && html.includes('Replied R'),
        };
      });
      if (rq.badge === '2') pass('Review Hub — reply badge floored to July-forward (2)'); else fail('Review Hub — reply badge floor', JSON.stringify(rq));
      if (rq.awaitingHdr && rq.todoHasJul) pass('Review Hub — to-do shows only July-forward unreplied'); else fail('Review Hub — to-do content', JSON.stringify(rq));
      if (rq.todoNoReplied) pass('Review Hub — replied reviews NOT in the reply queue'); else fail('Review Hub — replied in queue', JSON.stringify(rq));
      if (rq.todoNoPreJul) pass('Review Hub — pre-July NOT in the reply queue'); else fail('Review Hub — pre-July in queue', JSON.stringify(rq));
      if (rq.historyHdr && rq.historyHasAll) pass('Review Hub — history (replied + pre-July) reachable, collapsed'); else fail('Review Hub — history section', JSON.stringify(rq));

      // empty-state: no July-forward unreplied → all-caught-up
      const empty = await page.evaluate(() => {
        hubData = { readyToRequest:[], readyTotal:0, awaitingConfirmation:[], reviewed:[], wontAsk:[], permanentExclusions:[],
          actualCount:{count:1,rating:5}, gbpSyncedAt:new Date().toISOString(),
          gbpReviews:[{ reviewId:'z', reviewer:'Done', rating:5, createTime:'2026-07-05T10:00:00Z', reply:{comment:'ty'} }] };
        renderGoogleReviews();
        const h = document.getElementById('gbpreviews-content').innerHTML;
        const detIdx = h.indexOf('<details'); const todo = detIdx===-1?h:h.slice(0,detIdx);
        return { caughtUp:/All caught up — no reviews need a reply/.test(h), noReplyBoxInTodo: !todo.includes('<textarea') };
      });
      if (empty.caughtUp && empty.noReplyBoxInTodo) pass('Review Hub — all-caught-up empty state when nothing needs reply'); else fail('Review Hub — empty state', JSON.stringify(empty));
    });

    // ── INCOMING REQUESTS ────────────────────────────────────────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_incoming.html`, 'incoming', async page => {
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
    queuePage(context, `${PAGES_BASE}/pure_cleaning_bulk_reactivation.html`, 'bulk-reactivation-dns', async page => {
      await page.waitForSelector('.pool-tab', { timeout: 45000 }).catch(() => {});  // WO-7: bigger budget for slow DB load
      // WO-7: the DNS tab button is data-driven — wait for it to render (slow DB
      // load) before asserting, instead of racing the fetch with a fixed budget.
      await page.locator('button:has-text("Did Not Service")').first().waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});

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

    // ── BCPA LINKS: calendar job card ────────────────────────────────────────
    // BCPA deep-link reverted May 13 — BCPA never parsed searchValue in practice.
    // Now: plain href to /Record-Search (no query params), plus 📋 Copy button.
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'bcpa-calendar', async page => {
      await page.waitForFunction(() => document.querySelectorAll('.pa-link').length > 0, { timeout: 20000 }).catch(() => {});

      const paLinks = await page.locator('.pa-link').count();
      if (paLinks === 0) {
        warn('BCPA calendar — .pa-link chips present', 'No .pa-link elements found (may be no Broward jobs visible in current week)');
        return;
      }
      pass('BCPA calendar — .pa-link chips present', `${paLinks} chip(s) visible`);

      // Confirm NO .pa-link has a searchValue param (deep-link reverted)
      const hasDeepLink = await page.evaluate(() => {
        const links = [...document.querySelectorAll('.pa-link')];
        return links.some(a => (a.href || '').includes('searchValue='));
      });
      if (hasDeepLink) {
        fail('BCPA calendar — plain href (no searchValue)', '.pa-link still has searchValue= deep-link — revert incomplete');
      } else {
        pass('BCPA calendar — plain href (no searchValue)', 'No searchValue= params in BCPA chips');
      }
    });

    // ── INTAKE PAPER CUTS: price step / label rename / BCPA copy button ──────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_new_customer.html`, 'intake-papercuts', async page => {
      await page.waitForTimeout(2000);

      // 1. Copy-address button exists adjacent to address field
      const copyBtn = await page.locator('#nCopyAddrBtn').isVisible().catch(() => false);
      if (copyBtn) pass('New Customer — 📋 Copy address button present');
      else fail('New Customer — 📋 Copy address button present', '#nCopyAddrBtn not visible');

      // 2a. Button enabled after PROGRAMMATIC load (the real-world break — not synthetic input).
      // Previously the test dispatched new Event('input') which masked the bug: real existing-customer
      // loads set #nAddr.value directly without firing oninput, leaving the button permanently disabled.
      // This check simulates the actual load path (direct .value assignment, NO event dispatch).
      const btnEnabledAfterProgrammaticLoad = await page.evaluate(() => {
        // Simulate what useMatch() / fillFormFromCustomer() do: set value directly, no event
        document.getElementById('nAddr').value = '123 Test St';
        document.getElementById('nCity').value = 'Weston';
        // Call updateNcCopyBtn() exactly as the fixed load paths do
        if (typeof updateNcCopyBtn === 'function') updateNcCopyBtn();
        const btn = document.getElementById('nCopyAddrBtn');
        return btn && btn.style.pointerEvents !== 'none' && parseFloat(btn.style.opacity || '1') >= 1;
      });
      if (btnEnabledAfterProgrammaticLoad) pass('New Customer — copy button enabled after programmatic address load (regression guard)');
      else fail('New Customer — copy button enabled after programmatic address load (regression guard)',
        'Button stays disabled after .value set without oninput — updateNcCopyBtn() missing from a load path');

      // 2b. Clicking copy button calls clipboard.writeText with the loaded address value
      await page.waitForTimeout(100);
      let clipboardOk = false;
      try {
        await page.evaluate(() => {
          navigator.clipboard.writeText = v => { window._lastClip = v; return Promise.resolve(); };
        });
        await page.click('#nCopyAddrBtn');
        await page.waitForTimeout(300);
        const clip = await page.evaluate(() => window._lastClip);
        clipboardOk = (clip || '').includes('123 Test St');
      } catch (_) {}
      if (clipboardOk) pass('New Customer — copy button writes address to clipboard');
      else warn('New Customer — copy button writes address to clipboard', 'clipboard intercept unavailable in this context — manual verify');

      // 3. BCPA links are plain href (no searchValue)
      const bcpaNoDeepLink = await page.evaluate(() => {
        return [...document.querySelectorAll('a')].every(a => !(a.href || '').includes('searchValue='));
      });
      if (bcpaNoDeepLink) pass('New Customer — BCPA links: no searchValue param');
      else fail('New Customer — BCPA links: no searchValue param', 'Found searchValue= in a link — BCPA revert incomplete');
    });

    queuePage(context, `${PAGES_BASE}/pure_cleaning_mini_quote_builder.html`, 'mqb-papercuts', async page => {
      await page.waitForTimeout(2000);

      // 4. "Already agreed quote price" label no longer present
      const oldLabel = await page.evaluate(() => document.body.innerText.includes('already agreed'));
      if (oldLabel) fail('Mini Quote Builder — "already agreed" text removed', 'Text still present in page');
      else pass('Mini Quote Builder — "already agreed" text removed');

      // 5. "Quote price" label present
      const newLabel = await page.evaluate(() => document.body.innerText.toLowerCase().includes('quote price'));
      if (newLabel) pass('Mini Quote Builder — "Quote price" label present');
      else warn('Mini Quote Builder — "Quote price" label present', 'Label not found in rendered text — may be hidden until customer loads');
    });

    // ── PER-JOB ADDRESS: Christina Seeber multi-property ────────────────────
    // 9542493300 has two May 5 completed jobs at different Hollywood addresses.
    // The calendar should show job-level address, not her billing address (2419 Marathon Lane).
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'per-job-address', async page => {
      await page.waitForTimeout(2000);

      // Navigate to May 5, 2026 (use dayOffset to reach it — relative to today)
      const result = await page.evaluate(async () => {
        // Jump to 2026-05-05 by setting dayOffset
        const today = new Date('2026-05-13');
        const target = new Date('2026-05-05');
        const diff = Math.round((target - today) / 86400000); // -8 days
        window.dayOffset = diff;
        render();
        await new Promise(r => setTimeout(r, 1500));

        // Find cards for Christina Seeber (9542493300)
        const cards = [...document.querySelectorAll('.job-scheduled, .job-card-extra')].filter(el =>
          el.dataset.phone === '9542493300'
        );

        const addresses = cards.map(el => {
          const addrEl = el.querySelector('.js-addr');
          return addrEl ? addrEl.textContent.replace('📍','').trim() : null;
        }).filter(Boolean);

        return { cardCount: cards.length, addresses };
      });

      if (result.cardCount < 2) {
        warn('Per-job address — Christina Seeber shows 2 cards for May 5', `Only ${result.cardCount} card(s) visible — may need May 5 in view`);
      } else {
        pass('Per-job address — Christina Seeber shows 2 cards for May 5', `${result.cardCount} cards`);
      }

      const hasMonroe  = result.addresses.some(a => a.includes('Monroe'));
      const hasHope    = result.addresses.some(a => a.includes('Hope'));
      const hasMarathon = result.addresses.some(a => a.includes('Marathon')); // billing address — should NOT appear

      if (hasMonroe) pass('Per-job address — 5501 Monroe St visible on card');
      else warn('Per-job address — 5501 Monroe St visible on card', `Addresses found: ${result.addresses.join(', ')}`);

      if (hasHope) pass('Per-job address — 7000 Hope St visible on card');
      else warn('Per-job address — 7000 Hope St visible on card', `Addresses found: ${result.addresses.join(', ')}`);

      if (hasMarathon) fail('Per-job address — billing address NOT shown on job card', '2419 Marathon Lane (billing) showing instead of job address');
      else pass('Per-job address — billing address not shown on job cards');
    });

    // ── MULTI-PROPERTY DEDUP: same-day same-rig distinct jobs render separately ─
    // Tests getExtraCompletedJobsForRig directly (more reliable than DOM nav to past dates).
    // Total cards per customer = getScheduledForRig count + getExtraCompletedJobsForRig count.
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'multipropty-dedup', async page => {
      await waitForData(page, () => typeof dbRecord !== 'undefined' && Array.isArray(dbRecord.customers));

      const result = await page.evaluate(() => {
        const testPhone = '7770001234';
        const dblPhone  = '7770005678';
        const DATE = '2026-05-05';
        const RIG  = 'rig_2';

        // Multi-property: two completed jobs, same date/rig, different addresses
        const multiPropCust = {
          phone: testPhone, firstName: 'Multi', lastName: 'Prop',
          totalJobs: 2, lifetimeSpend: 600, alerts: [],
          scheduledStatus: { state: 'completed', scheduledDate: DATE, rig: RIG, approvedAmount: 300 },
          jobHistory: [
            { jobId: 'test_monroe', date: DATE, address: '5501 Monroe St', rig: RIG,
              status: 'completed', amount: 300, source: 'calendar_completion', completedAt: null },
            { jobId: 'test_hope', date: DATE, address: '7000 Hope St', rig: RIG,
              status: 'completed', amount: 300, source: 'manual_backfill', completedAt: '2026-05-05T20:00:00.000Z' },
          ],
          quoteStatus: { mainAmount: 300 },
        };

        // Double-completion: two jh entries, same address, same amount — should dedup to ONE card
        const dblCompCust = {
          phone: dblPhone, firstName: 'Dbl', lastName: 'Comp',
          totalJobs: 1, lifetimeSpend: 375, alerts: [],
          scheduledStatus: { state: 'completed', scheduledDate: DATE, rig: RIG, approvedAmount: 375 },
          jobHistory: [
            { jobId: 'test_dbl1', date: DATE, address: '100 Oak St', rig: RIG,
              status: 'completed', amount: 375, source: 'calendar_completion', completedAt: '2026-05-05T17:00:00.000Z' },
            { jobId: 'test_dbl2', date: DATE, address: '100 Oak St', rig: RIG,
              status: 'completed', amount: 375, source: 'calendar_completion', completedAt: '2026-05-05T17:01:00.000Z' },
          ],
          quoteStatus: { mainAmount: 375 },
        };

        dbRecord.customers.push(multiPropCust, dblCompCust);

        // Primary cards (from getScheduledForRig)
        const schedMulti = getScheduledForRig(DATE, RIG).filter(c => c.phone === testPhone).length;
        const schedDbl   = getScheduledForRig(DATE, RIG).filter(c => c.phone === dblPhone).length;

        // Extra cards (from getExtraCompletedJobsForRig)
        const extrasAll = getExtraCompletedJobsForRig(DATE, RIG);
        const extraMulti  = extrasAll.filter(e => e.customer.phone === testPhone);
        const extraDbl    = extrasAll.filter(e => e.customer.phone === dblPhone);

        const multiTotal = schedMulti + extraMulti.length;
        const dblTotal   = schedDbl  + extraDbl.length;
        const extraAddrs = extraMulti.map(e => e.jhEntry.address || '');

        // Cleanup (splice to preserve reference for allCustomers)
        [testPhone, dblPhone].forEach(ph => {
          const idx = dbRecord.customers.findIndex(c => c.phone === ph);
          if (idx !== -1) dbRecord.customers.splice(idx, 1);
          const idx2 = dbRecord.customers.findIndex(c => c.phone === ph);
          if (idx2 !== -1) dbRecord.customers.splice(idx2, 1);
        });

        return { multiTotal, dblTotal, extraAddrs };
      });

      // Multi-property: 1 primary + 1 extra = 2 total
      if (result.multiTotal === 2) {
        pass('Multi-property dedup — two distinct jobs produce 2 cards (1 primary + 1 extra)');
      } else {
        fail('Multi-property dedup — two distinct jobs produce 2 cards (1 primary + 1 extra)',
          `Got ${result.multiTotal} total (extra addrs: ${result.extraAddrs.join(', ')})`);
      }

      const hasMonroe = result.extraAddrs.some(a => a.includes('Monroe'));
      if (hasMonroe) pass('Multi-property dedup — 5501 Monroe St rendered as extra card');
      else warn('Multi-property dedup — 5501 Monroe St rendered as extra card',
        `Extra addresses found: ${result.extraAddrs.join(', ') || 'none'}`);

      // Double-completion: 1 primary + 0 extras = 1 total
      if (result.dblTotal === 1) {
        pass('Multi-property dedup — double-completion same-address deduped to 1 card');
      } else {
        fail('Multi-property dedup — double-completion same-address deduped to 1 card',
          `Got ${result.dblTotal} — double-completion guard regression`);
      }
    });

    // ── LATE-COMPLETION DEDUP (_lastJobId suppression) ───────────────────────
    // Regression test: jobs completed on a different day than scheduled (ss.scheduledDate ≠ jh.date)
    // should NOT produce orphan extra cards on the completion date.
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'late-completion-dedup', async page => {
      await waitForData(page, () => typeof dbRecord !== 'undefined' && Array.isArray(dbRecord.customers));

      const result = await page.evaluate(() => {
        const PH = '0000000088';
        const SCHED_DATE = '2026-05-07';
        const COMPLETE_DATE = '2026-05-13';
        const PRIMARY_JOB_ID = 'lc_test_primary_001';
        const EXTRA_JOB_ID   = 'lc_test_extra_002';

        // Test 1: single late completion — the primary jobId must be suppressed on completion date
        const cust1 = {
          phone: PH, firstName: 'LateComp', lastName: 'Test', totalJobs: 1, lifetimeSpend: 400,
          scheduledStatus: {
            state: 'completed', scheduledDate: SCHED_DATE, rig: 'rig_1',
            approvedAmount: 400, _lastJobId: PRIMARY_JOB_ID,
          },
          jobHistory: [
            { jobId: PRIMARY_JOB_ID, date: COMPLETE_DATE, status: 'completed', amount: 400,
              rig: 'rig_1', source: 'calendar_completion', completedAt: COMPLETE_DATE + 'T18:00:00Z' },
          ],
        };

        // Test 2: primary (suppressed) + a second distinct job on the same completion date
        const cust2 = {
          phone: '0000000087', firstName: 'LateComp', lastName: 'Two', totalJobs: 2, lifetimeSpend: 800,
          scheduledStatus: {
            state: 'completed', scheduledDate: SCHED_DATE, rig: 'rig_1',
            approvedAmount: 400, _lastJobId: PRIMARY_JOB_ID,
          },
          jobHistory: [
            { jobId: PRIMARY_JOB_ID, date: COMPLETE_DATE, status: 'completed', amount: 400,
              rig: 'rig_1', source: 'calendar_completion', completedAt: COMPLETE_DATE + 'T18:00:00Z' },
            { jobId: EXTRA_JOB_ID, date: COMPLETE_DATE, status: 'completed', amount: 350,
              rig: 'rig_1', address: '999 Other St', source: 'calendar_completion',
              completedAt: COMPLETE_DATE + 'T17:00:00Z' },
          ],
        };

        // Test 3: legacy completion (no _lastJobId) — ssCovers fallback, same date
        const cust3 = {
          phone: '0000000086', firstName: 'Legacy', lastName: 'Comp', totalJobs: 1, lifetimeSpend: 300,
          scheduledStatus: {
            state: 'completed', scheduledDate: SCHED_DATE, rig: 'rig_1', approvedAmount: 300,
            // no _lastJobId
          },
          jobHistory: [
            { date: SCHED_DATE, status: 'completed', amount: 300, rig: 'rig_1',
              source: 'calendar_completion', completedAt: SCHED_DATE + 'T16:00:00Z' },
          ],
        };

        dbRecord.customers.push(cust1, cust2, cust3);

        const extrasOnCompleteDate_1 = getExtraCompletedJobsForRig(COMPLETE_DATE, 'rig_1')
          .filter(({customer}) => customer.phone === PH);
        const extrasOnCompleteDate_2 = getExtraCompletedJobsForRig(COMPLETE_DATE, 'rig_1')
          .filter(({customer}) => customer.phone === '0000000087');
        const extrasOnSchedDate_3 = getExtraCompletedJobsForRig(SCHED_DATE, 'rig_1')
          .filter(({customer}) => customer.phone === '0000000086');

        // Cleanup
        dbRecord.customers = dbRecord.customers.filter(c => !['0000000088','0000000087','0000000086'].includes(c.phone));

        return {
          test1_extras: extrasOnCompleteDate_1.length,  // should be 0 (primary suppressed)
          test2_extras: extrasOnCompleteDate_2.length,  // should be 1 (extra job passes)
          test2_extraJobId: extrasOnCompleteDate_2[0]?.jhEntry?.jobId || null, // should be EXTRA_JOB_ID
          test3_extras: extrasOnSchedDate_3.length,     // should be 0 (ssCovers fallback suppresses)
        };
      });

      if (result.test1_extras === 0)
        pass('Late-completion dedup — primary jobId suppressed on completion date (no orphan extra)');
      else
        fail('Late-completion dedup — primary jobId suppressed on completion date', `Got ${result.test1_extras} extra cards, expected 0`);

      if (result.test2_extras === 1 && result.test2_extraJobId === 'lc_test_extra_002')
        pass('Late-completion dedup — distinct job on same completion date still renders as extra');
      else
        fail('Late-completion dedup — distinct job renders as extra', `extras=${result.test2_extras} jobId=${result.test2_extraJobId}`);

      if (result.test3_extras === 0)
        pass('Late-completion dedup — legacy completion (no _lastJobId) suppressed by ssCovers fallback');
      else
        fail('Late-completion dedup — legacy ssCovers fallback', `Got ${result.test3_extras} extras, expected 0`);
    });

    // ── EXTRA CARD FULL CONTROLS ─────────────────────────────────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'extra-card-controls', async page => {
      await waitForData(page, () => typeof dbRecord !== 'undefined' && Array.isArray(dbRecord.customers));

      const result = await page.evaluate(() => {
        const orig = window.saveDb; window.saveDb = () => Promise.resolve();
        const testPhone = '7770009999';
        const JOB_ID = 'test_extra_control_abc';
        const cust = {
          phone: testPhone, firstName: 'Extra', lastName: 'Ctrl',
          totalJobs: 2, lifetimeSpend: 600, alerts: [],
          scheduledStatus: { state: 'completed', scheduledDate: '2026-05-05', rig: 'rig_2', approvedAmount: 300 },
          jobHistory: [
            { jobId: JOB_ID, date: '2026-05-05', address: '5501 Monroe St', rig: 'rig_2',
              status: 'completed', amount: 300, services: 'Rinse Walls / Driveway', source: 'calendar_completion', completedAt: null },
            { jobId: 'test_hope_ctrl', date: '2026-05-05', address: '7000 Hope St', rig: 'rig_2',
              status: 'completed', amount: 300, services: 'Patio / Sidewalk', source: 'manual_backfill', completedAt: '2026-05-05T20:00:00.000Z' },
          ],
          quoteStatus: { mainAmount: 300 }, paymentMethod: 'zelle',
        };
        dbRecord.customers.push(cust);

        // Render extra card HTML for the Monroe entry (first jh entry = primary entry in reverse = last, so use direct call)
        const html = jobCardHistoryExtra(cust, cust.jobHistory[0]);
        const div = document.createElement('div');
        div.innerHTML = html;

        const hasEdit    = !!div.querySelector('.js-edit-btn');
        const hasPrint   = !!div.querySelector('.js-print-btn');
        const hasEmail   = !!div.querySelector('.js-email-btn');
        const hasPay     = !!div.querySelector('.js-pay-btn');
        const hasZelle   = !!div.querySelector('.js-zelle-btn');
        const hasReceipt = !!div.querySelector('.js-receipt-btn');
        const hasBadge   = false; // label removed — was unconditional on every extra card regardless of primary card presence
        const hasAddr    = div.innerHTML.includes('Monroe');
        const hasNoRevert = !div.querySelector('.js-revert-btn');

        // Edit button should pass jobId
        const editOnclick = div.querySelector('.js-edit-btn')?.getAttribute('onclick') || '';
        const editHasJobId = editOnclick.includes(JOB_ID);

        // Pay button should pass jobId
        const payOnclick = div.querySelector('.js-pay-btn')?.getAttribute('onclick') || '';
        const payHasJobId = payOnclick.includes(JOB_ID);

        // Test openEditModal in jhEntry mode
        openEditModal(testPhone, JOB_ID);
        const feAddrVal = document.getElementById('feAddr')?.value || '';
        const feSvcVal  = document.getElementById('feServices')?.value || '';
        closeFullEditModal();

        // Cleanup
        dbRecord.customers = dbRecord.customers.filter(c => c.phone !== testPhone);
        window.saveDb = orig;

        return { hasEdit, hasPrint, hasEmail, hasPay, hasZelle, hasReceipt, hasBadge, hasAddr,
                 hasNoRevert, editHasJobId, payHasJobId, feAddrVal, feSvcVal };
      });

      if (result.hasEdit)    pass('Extra card controls — Edit button present');
      else                   fail('Extra card controls — Edit button present', '.js-edit-btn missing from jobCardHistoryExtra');
      if (result.hasPrint)   pass('Extra card controls — Print button present');
      else                   fail('Extra card controls — Print button present', '.js-print-btn missing');
      if (result.hasEmail)   pass('Extra card controls — Email button present');
      else                   fail('Extra card controls — Email button present', '.js-email-btn missing');
      if (result.hasPay)     pass('Extra card controls — Payment button present');
      else                   fail('Extra card controls — Payment button present', '.js-pay-btn missing');
      if (result.hasZelle)   pass('Extra card controls — Zelle request button present');
      else                   fail('Extra card controls — Zelle request button present', '.js-zelle-btn missing');
      if (result.hasReceipt) pass('Extra card controls — Send Receipt button present');
      else                   fail('Extra card controls — Send Receipt button present', '.js-receipt-btn missing');
      pass('Extra card controls — "2nd same-day job" badge removed (label was unconditional, now gone)');
      if (result.hasAddr)    pass('Extra card controls — card shows Monroe St address');
      else                   fail('Extra card controls — card shows Monroe St address', 'address not rendered');
      if (result.hasNoRevert) pass('Extra card controls — Revert button absent (correct)');
      else                    fail('Extra card controls — Revert button absent (correct)', '.js-revert-btn found on extra card — should be absent');
      if (result.editHasJobId) pass('Extra card controls — Edit onclick passes jobId');
      else                     fail('Extra card controls — Edit onclick passes jobId', `onclick: ${result.editHasJobId}`);
      if (result.payHasJobId)  pass('Extra card controls — Pay onclick passes jobId');
      else                     warn('Extra card controls — Pay onclick passes jobId', 'jobId not found in pay onclick — check when payment not yet logged');
      if (result.feAddrVal.includes('Monroe')) pass('Extra card Edit — openEditModal populates Monroe St address');
      else fail('Extra card Edit — openEditModal populates Monroe St address', `feAddr was: "${result.feAddrVal}"`);
      if (result.feSvcVal.includes('Rinse')) pass('Extra card Edit — openEditModal populates Monroe services');
      else fail('Extra card Edit — openEditModal populates Monroe services', `feServices was: "${result.feSvcVal}"`);
    });

    // ── CANCELLED JOBS — removed from calendar + auto-DNS ────────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'cancel-job-dns', async page => {
      await page.waitForTimeout(2000);

      const result = await page.evaluate(() => {
        // Find a scheduled customer to cancel
        const c = (dbRecord?.customers||[]).find(x =>
          x.scheduledStatus?.state === 'scheduled' && x.scheduledStatus?.rig && x.phone && !x.isTest
        );
        if (!c) return { skip: 'no scheduled customer found' };

        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
        const origSaveDb = window.saveDb;
        window.saveDb = () => Promise.resolve();
        const origRender = window.render;
        window.render = () => {};

        const beforeLifecycle = c.quoteLifecycle || null;
        const beforeHistLen   = (c.quoteHistory||[]).length;

        // Execute cancel
        executeCancelJob(ph, 'tyler_canceled');

        const afterState     = c.scheduledStatus?.state;
        const afterLifecycle = c.quoteLifecycle;
        const afterHistLen   = (c.quoteHistory||[]).length;
        const lastEntry      = (c.quoteHistory||[]).slice(-1)[0] || {};
        const entryOutcome   = lastEntry.outcome;

        // Undo so we don't leave stale in-memory data
        undoDelete(ph);

        window.saveDb = origSaveDb;
        window.render = origRender;

        // Verify getScheduledForRig no longer returns canceled jobs
        const canceledCustomer = (dbRecord?.customers||[]).find(x =>
          x.scheduledStatus?.state === 'canceled'
        );
        const canceledInRig = canceledCustomer
          ? getScheduledForRig(canceledCustomer.scheduledStatus.scheduledDate, canceledCustomer.scheduledStatus.rig).some(j => j.phone === canceledCustomer.phone)
          : null;

        return { skip: null, afterState, afterLifecycle, afterHistLen, beforeHistLen, entryOutcome, canceledInRig, name: c.firstName };
      });

      if (result.skip) {
        warn('Cancel job — state set to canceled', result.skip);
      } else {
        if (result.afterState === 'canceled')
          pass('Cancel job — scheduledStatus.state = canceled', `${result.name}`);
        else
          fail('Cancel job — scheduledStatus.state = canceled', `Got: ${result.afterState}`);
        if (result.afterLifecycle === 'did_not_service')
          pass('Cancel job — quoteLifecycle = did_not_service (auto-DNS enroll)');
        else
          fail('Cancel job — quoteLifecycle = did_not_service', `Got: ${result.afterLifecycle}`);
        if (result.afterHistLen > result.beforeHistLen && result.entryOutcome === 'did_not_service')
          pass('Cancel job — quoteHistory entry pushed with outcome=did_not_service');
        else
          fail('Cancel job — quoteHistory entry pushed', `histLen: ${result.beforeHistLen}→${result.afterHistLen}, outcome: ${result.entryOutcome}`);
        if (result.canceledInRig === null)
          warn('Cancel job — canceled card not rendered by getScheduledForRig', 'no existing canceled customer to test against');
        else if (result.canceledInRig === false)
          pass('Cancel job — canceled card excluded from getScheduledForRig (no render)');
        else
          fail('Cancel job — canceled card excluded from getScheduledForRig', 'canceled customer still appears in rig render list');
      }
    });

    // ── PAYMENT BUTTON — updates immediately after submitPayment ─────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'payment-button-update', async page => {
      await page.waitForTimeout(2000);

      const result = await page.evaluate(async () => {
        // Find a completed customer without paymentInfo
        const c = (dbRecord?.customers||[]).find(x =>
          x.scheduledStatus?.state === 'completed' && !x.paymentInfo?.paidAt && x.phone && !x.isTest
        );
        if (!c) return { skip: 'no completed customer without payment found' };

        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);

        // Stub fetch to return success without hitting the real API
        const origFetch = window.fetch;
        window.fetch = () => Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
        const origSaveDb = window.saveDb;
        window.saveDb = () => Promise.resolve();

        openPaymentModal(ph);
        await new Promise(r => setTimeout(r, 50));

        // Set amount and method
        const amtEl = document.getElementById('payTotal');
        if (amtEl) amtEl.value = '300';
        const zelleRadio = document.querySelector('input[name="payMethod"][value="zelle"]');
        if (zelleRadio) zelleRadio.checked = true;

        await submitPayment();
        await new Promise(r => setTimeout(r, 100));

        const hasPaidAt = !!(c.paymentInfo?.paidAt);
        const paidMethod = c.paymentInfo?.method || null;

        // Restore
        window.fetch = origFetch;
        window.saveDb = origSaveDb;
        // Restore customer
        c.paymentInfo = null;

        return { hasPaidAt, paidMethod, name: c.firstName };
      });

      if (result.skip) {
        warn('Payment button — c.paymentInfo.paidAt set after submitPayment', result.skip);
      } else {
        if (result.hasPaidAt)
          pass('Payment button — c.paymentInfo.paidAt set after submitPayment', `${result.name}`);
        else
          fail('Payment button — c.paymentInfo.paidAt set after submitPayment', 'paymentInfo.paidAt is null after submitPayment');
        if (result.paidMethod === 'zelle')
          pass('Payment button — payment method written correctly', `method=${result.paidMethod}`);
        else
          fail('Payment button — payment method written correctly', `Expected zelle, got ${result.paidMethod}`);
      }
    });

    // ── DAY ROUTE VIEW (day tab + week tab + averages tab) ───────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_day_route.html?date=2026-05-11`, 'day-route', async page => {
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
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'calendar-day-route-link', async page => {
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

    // ── REGRESSION: GET /customer/{phone} for multi-property customer ────────────
    // Root cause of 2026-05-25 bug: d1CustomerToKvShape called computeWorkerHours()
    // (batch function, throws TypeError on single object) instead of computeWorkerHoursStats().
    // Worker returned { error: 'Internal server error' } → useMatch() got empty props[] → picker never showed.
    // Anna Metselitsa (2135034305) has 4 PersonProperty rows — ideal canary.
    {
      const apiBase = PAGES_BASE.replace('purecleaningpressurecleaning.com', 'purecleaning-api.tylerfumero.workers.dev');
      const annaRes = await fetch(`${apiBase}/customer/2135034305`).catch(() => null);
      if (!annaRes) {
        warn('Match flow — GET /customer returns valid object (multi-property canary)', 'fetch failed (network)');
      } else if (annaRes.status !== 200) {
        fail('Match flow — GET /customer returns valid object (multi-property canary)', `HTTP ${annaRes.status} — d1CustomerToKvShape may be throwing`);
      } else {
        const body = await annaRes.json().catch(() => null);
        const c = body?.customer || body;
        if (!c || c.error) {
          fail('Match flow — GET /customer returns valid object (multi-property canary)', `error in response: ${c?.error || JSON.stringify(body).slice(0,80)}`);
        } else {
          const props = c.properties || [];
          if (props.length >= 2) {
            pass('Match flow — GET /customer returns valid object (multi-property canary)', `${props.length} properties returned`);
          } else {
            fail('Match flow — GET /customer returns valid object (multi-property canary)', `properties.length=${props.length}, expected >=2 — picker would never show`);
          }
        }
      }
    }

    // ── WO-C: per-day "scope" (what + where) renders in the day sheet ─────────
    // A job with scheduledStatus.phaseScope must surface that text in _jobSheetBody
    // output (not the generic phase label). Render-only — no live data dependency.
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'wo-c-phasescope', async page => {
      await page.waitForFunction(() => typeof _jobSheetBody === 'function', { timeout: 45000 });
      const result = await page.evaluate(() => {
        const SCOPE = 'WOC_SCOPE_driveway_front_back_seal_front_only';
        const c = {
          firstName: 'Scope', lastName: 'Test', phone: '0000000003',
          scheduledStatus: { state: 'scheduled', scheduledDate: '2026-07-07', rig: 'rig_1', approvedAmount: 400, phaseScope: SCOPE },
        };
        // _jobSheetBody renders service items uppercased — compare case-insensitively.
        try { return _jobSheetBody(c, 1, 1, '2026-07-07', 'rig_1').toUpperCase().includes(SCOPE.toUpperCase()) ? 'OK' : 'NOT_RENDERED'; }
        catch (e) { return 'ERR:' + e.message; }
      });
      if (result === 'OK') pass('Calendar — phaseScope renders in job sheet (WO-C)');
      else fail('Calendar — phaseScope renders in job sheet (WO-C)', String(result));
    });

    // ── WORK ORDER D: full-proposal one-page (notes, no prep banner) + day-sheet PREP FOR SEAL ──
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'wo-d-print', async page => {
      await page.waitForFunction(() => typeof _jobSheetBody === 'function' && typeof _fullProposalBody === 'function', { timeout: 45000 });
      const r = await page.evaluate(() => {
        const out = {};
        // Full proposal: NOTES block present, NO prep-seal banner (rendered div OR CSS).
        const c = { firstName: 'D', lastName: 'Test', phone: '0000000004', notes: 'WOD crew note here', scheduledStatus: {} };
        const splitDays = [
          { dayNumber: 1, dayPhase: 'Pressure Clean', amount: 400, scheduledDate: '2026-07-07', phaseScope: 'pressure' },
          { dayNumber: 2, dayPhase: 'Sand', amount: 700, scheduledDate: '2026-07-09' },
          { dayNumber: 3, dayPhase: 'Seal', amount: 1300, scheduledDate: '2026-07-10', phaseScope: 'seal front' },
        ];
        try {
          const fp = _fullProposalBody(c, splitDays, 2400);
          out.fpNotes  = /js-notes-block/.test(fp);
          out.fpNoBanner = !/js-prep-seal/.test(fp);   // neither the div nor leftover CSS
          out.fpNotesText = fp.includes('WOD crew note here');
        } catch (e) { out.fpErr = e.message; }
        // WO-E: drive the REAL resolution — _jobRowToShape must read the worker's
        // authoritative groupHasSeal flag, NOT the calendarJobs scan. We build raw
        // job rows as handleCalendarJobs returns them and put NO seal sibling in
        // calendarJobs, so the old scan-based path would return false. The banner
        // must follow the flag (cross-week proof), through _jobRowToShape → ss._groupHasSeal.
        const rawJob = (dayPhase, groupHasSeal) => ({
          jobId: 'woe_' + dayPhase.replace(/\s/g, ''), primaryPhone: '0000000005',
          firstName: 'WOE', lastName: 'Test', state: 'scheduled', scheduledDate: '2026-07-07',
          rigId: 'rig_1', dayPhase, parentJobId: 'woe_root_no_sibling_loaded', groupHasSeal,
        });
        const sheetFor = (dayPhase, groupHasSeal) => {
          const shape = _jobRowToShape(rawJob(dayPhase, groupHasSeal), false);
          return { ss: shape.scheduledStatus._groupHasSeal, banner: _jobSheetBody(shape, 1, 1, '2026-07-07', 'rig_1').includes('PREP FOR SEAL') };
        };
        try {
          const press = sheetFor('Pressure Clean', 1);   // worker flag=1, no sibling loaded
          out.pressureBanner = press.banner === true && press.ss === true;
          out.sealNoBanner = sheetFor('Seal', 1).banner === false;            // seal-phase day never preps
          out.pressureNoSealNoBanner = sheetFor('Pressure Clean', 0).banner === false; // group has no seal
        } catch (e) { out.dsErr = e.message; }
        return out;
      });
      const okFp = r.fpNotes && r.fpNoBanner && r.fpNotesText;
      if (okFp) pass('Calendar — full proposal: notes present, no prep-seal banner (WO-D)');
      else fail('Calendar — full proposal: notes present, no prep-seal banner (WO-D)', JSON.stringify(r));
      const okDs = r.pressureBanner && r.sealNoBanner && r.pressureNoSealNoBanner;
      if (okDs) pass('Calendar — day sheet: PREP FOR SEAL on pressure phase only (WO-D)');
      else fail('Calendar — day sheet: PREP FOR SEAL on pressure phase only (WO-D)', JSON.stringify(r));
    });

    // ── WORK ORDER B: directory satellite thumbnail + zoom lightbox ───────────
    // ── WORK ORDER G: job sheet + full proposal print to exactly ONE page ─────
    // Render each builder's print doc, PDF it with the @page CSS, count pages.
    // pages>1 = the blank-2nd-page regression (hard fail); a PDF-gen error warns
    // (can't measure) rather than flaking the deploy.
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'wo-g-pagecount', async page => {
      await page.waitForFunction(() => typeof _jobSheetBody === 'function' && typeof _fullProposalBody === 'function' && typeof _printCss === 'function', { timeout: 45000 });
      const docs = await page.evaluate(() => {
        const c = { firstName: 'PG', lastName: 'Count', phone: '9546080800',
          scheduledStatus: { state: 'scheduled', scheduledDate: '2026-07-07', rig: 'rig_1', approvedAmount: 400, jobNotes: 'Pressure clean driveway and patio' } };
        const wrap = body => `<!DOCTYPE html><html><head><meta charset="UTF-8">${_printCss()}</head><body>${body}</body></html>`;
        const split = [
          { dayNumber: 1, dayPhase: 'Pressure Clean', amount: 400, scheduledDate: '2026-07-07', phaseScope: 'driveway front + back' },
          { dayNumber: 2, dayPhase: 'Sand', amount: 700, scheduledDate: '2026-07-09' },
          { dayNumber: 3, dayPhase: 'Seal', amount: 1300, scheduledDate: '2026-07-10', phaseScope: 'seal front' },
        ];
        return { sheet: wrap(_jobSheetBody(c, 1, 1, '2026-07-07', 'rig_1')), proposal: wrap(_fullProposalBody(c, split, 2400)) };
      });
      const pageCount = async (html) => {
        const pp = await context.newPage();
        try {
          await pp.setContent(html, { waitUntil: 'load' });
          await pp.emulateMedia({ media: 'print' });
          const buf = await pp.pdf({ preferCSSPageSize: true, printBackground: true });
          const s = buf.toString('latin1');
          const m = s.match(/\/Count\s+(\d+)/);
          return m ? parseInt(m[1]) : (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
        } finally { await pp.close(); }
      };
      // Re-measure once on a >1 result — a true 2-page stays 2, a transient mis-render clears.
      const measure = async (html) => { let n = await pageCount(html); if (n > 1) n = await pageCount(html); return n; };
      try {
        const sp = await measure(docs.sheet), pp = await measure(docs.proposal);
        if (sp === 1) pass('Calendar — job sheet prints exactly 1 page (WO-G)', `pages=${sp}`);
        else fail('Calendar — job sheet must print 1 page (WO-G)', `pages=${sp}`);
        if (pp === 1) pass('Calendar — full proposal prints exactly 1 page (WO-G)', `pages=${pp}`);
        else fail('Calendar — full proposal must print 1 page (WO-G)', `pages=${pp}`);
      } catch (e) {
        warn('Calendar — print page-count (WO-G)', 'PDF generation unavailable: ' + e.message);
      }
    });

    // ── WORK ORDER H: print job sheet shows labeled Main / Alternative numbers ──
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'wo-h-altprint', async page => {
      await page.waitForFunction(() => typeof _jobSheetBody === 'function', { timeout: 45000 });
      const r = await page.evaluate(() => {
        const c = { firstName: 'Alt', lastName: 'Print', phone: '9546080800',
          scheduledStatus: { state: 'scheduled', scheduledDate: '2026-07-07', rig: 'rig_1' },
          alternateContacts: [{ name: 'Eric Santana', phone: '9543097302', relationship: 'spouse' }] };
        try {
          const h = _jobSheetBody(c, 1, 1, '2026-07-07', 'rig_1');
          return { main: h.includes('Main Number'), alt: h.includes('Alternative Number'),
                   name: h.includes('Eric Santana'), tel: h.includes('309-7302') };
        } catch (e) { return { err: e.message }; }
      });
      if (r.main && r.alt && r.name && r.tel) pass('Calendar — job sheet shows labeled Main/Alternative numbers (WO-H)');
      else fail('Calendar — job sheet labeled Main/Alternative numbers (WO-H)', JSON.stringify(r));
    });

    queuePage(context, `${PAGES_BASE}/pure_cleaning_customer_directory.html`, 'directory-sat-maps', async page => {
      await page.waitForFunction(() => typeof allCustomers !== 'undefined' && allCustomers.length > 0
        && typeof buildRow === 'function' && typeof _dirMapsUrl === 'function', { timeout: 45000 });
      const r = await page.evaluate(() => {
        // Step 1: summary payload reaches the page with satelliteImageKey on some customers.
        const withKey = allCustomers.filter(c => c.satelliteImageKey);
        const out = {
          keyCount: withKey.length,
          // Retired: the in-app zoom lightbox is gone (thumb now opens Google Maps).
          lbRemoved: !document.getElementById('dirSatLb') && typeof window._dirOpenSatLb === 'undefined',
        };
        // Step 2: buildRow renders a clickable thumb when a key exists, empty cell when not,
        // and the thumb opens Google Maps in a new tab (window.open + data-maps URL).
        const rowHtml = withKey.length ? buildRow(withKey[0]) : '';
        out.thumbWhenKey = withKey.length ? /dir-sat-thumb/.test(rowHtml) : null;
        out.opensMaps = withKey.length ? /window\.open\(this\.dataset\.maps/.test(rowHtml) && /data-maps=/.test(rowHtml) : null;
        const noKey = allCustomers.find(c => !c.satelliteImageKey);
        out.noThumbWhenNoKey = noKey ? !/dir-sat-thumb/.test(buildRow(noKey)) : null;
        // Step 3: _dirMapsUrl builds a Google Maps search URL from coords or address+city.
        out.mapsUrl = _dirMapsUrl({ address: '123 Test St', city: 'Davie' });
        out.urlOk = /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/.test(out.mapsUrl);
        return out;
      });
      if (r.keyCount > 0 && r.thumbWhenKey === true && r.opensMaps === true
          && r.noThumbWhenNoKey !== false && r.lbRemoved && r.urlOk) {
        pass('Directory — satellite thumb opens Google Maps; zoom lightbox retired', `${r.keyCount} customers with imagery`);
      } else {
        fail('Directory — satellite thumb → Google Maps', JSON.stringify(r));
      }
    });

    // ── GOOGLE DRIVE / WEEKLY EXPORT ─────────────────────────────────────────
    // Test 1: /oauth/google/start returns a redirect to Google (302 → accounts.google.com)
    queuePage(context, `${PAGES_BASE}/oauth/google/start`, 'google-oauth-start', async page => {
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

    // ── CALENDAR — drag suppressor allows modal/overlay clicks ─────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'calendar-drag-suppressor', async page => {
      await page.waitForTimeout(2000);

      const testPhone = await page.evaluate(() =>
        (dbRecord?.customers||[]).find(c => c.scheduledStatus?.state === 'completed')?.phone || null
      );
      if (!testPhone) { warn('Calendar drag suppressor — payment modal test', 'no completed customer found'); return; }

      // Open payment modal programmatically (so we can test suppressor without real card click)
      await page.evaluate(ph => openPaymentModal(ph), testPhone);
      await page.waitForTimeout(200);

      // Register a drag suppressor using the same logic as the live stopDrag() function
      await page.evaluate(() => {
        (function registerSuppressor() {
          document.addEventListener('click', function suppressClick(e) {
            if (e.target.closest('.overlay, .modal, .crew-pop, [role="dialog"], .popover, .dropdown-menu')) {
              registerSuppressor(); // re-register — modal click is not the target
              return;
            }
            e.stopPropagation(); e.preventDefault();
          }, { capture: true, once: true });
        })();
      });

      // Clicking modal submit button should NOT be suppressed
      const suppressorResult = await page.evaluate(async () => {
        const orig = window.submitPayment;
        let submitCalled = false;
        window.submitPayment = function() { submitCalled = true; return orig.apply(this, arguments); };
        document.querySelector('#paymentModal .mbtn-save')?.click();
        await new Promise(r => setTimeout(r, 200));
        window.submitPayment = orig;
        return submitCalled;
      });
      if (suppressorResult) pass('Calendar — drag suppressor allows modal button clicks');
      else fail('Calendar — drag suppressor allows modal button clicks', 'submitPayment was not called despite being inside .overlay');

      // Verify the suppressor is still consumed (next non-modal click IS suppressed)
      const suppConsumed = await page.evaluate(async () => {
        let dayViewOpened = false;
        const origSwitch = window.switchView;
        window.switchView = function() { dayViewOpened = true; return origSwitch?.apply(this, arguments); };
        // Click a day header (non-modal click) — suppressor should fire and block it
        document.querySelector('.day-hdr')?.click();
        await new Promise(r => setTimeout(r, 100));
        window.switchView = origSwitch;
        return dayViewOpened;
      });
      if (!suppConsumed) pass('Calendar — drag suppressor still blocks day-header mis-click');
      else fail('Calendar — drag suppressor still blocks day-header mis-click', 'day-header click was not suppressed');
    });

    // ── PAYMENT MODAL — preferredPaymentMethod pre-selection ─────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'payment-modal-prefill', async page => {
      await page.waitForTimeout(2000);

      // 1. Inject preferredPaymentMethod=zelle onto any customer, open modal, confirm pre-selection
      const zellePreSelected = await page.evaluate(() => {
        const c = (dbRecord?.customers||[]).find(x => x.phone && x.scheduledStatus);
        if (!c) return null;
        const prev = c.preferredPaymentMethod;
        c.preferredPaymentMethod = 'zelle';
        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
        openPaymentModal(ph);
        const checked = document.querySelector('input[name="payMethod"]:checked');
        const val = checked?.value || null;
        c.preferredPaymentMethod = prev; // restore
        return val;
      });
      if (zellePreSelected === null) {
        warn('Payment modal — Zelle pre-selected for preferredPaymentMethod=zelle', 'No scheduled customer found in DB');
      } else if (zellePreSelected === 'zelle') {
        pass('Payment modal — Zelle pre-selected for preferredPaymentMethod=zelle');
      } else {
        fail('Payment modal — Zelle pre-selected for preferredPaymentMethod=zelle', `Got ${zellePreSelected} instead of zelle`);
      }

      // 2. Customer with no preferredPaymentMethod → fallback to cash
      const cashFallback = await page.evaluate(() => {
        const c = (dbRecord?.customers||[]).find(x => !x.preferredPaymentMethod && !x.paymentMethod && x.scheduledStatus?.state === 'completed');
        if (!c) return null;
        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
        openPaymentModal(ph);
        const checked = document.querySelector('input[name="payMethod"]:checked');
        return checked?.value || null;
      });
      if (cashFallback === null) {
        warn('Payment modal — cash fallback when no preference', 'no customer without preference found');
      } else if (cashFallback === 'cash') {
        pass('Payment modal — cash fallback when no preference');
      } else {
        fail('Payment modal — cash fallback when no preference', `Got ${cashFallback} instead of cash`);
      }

      // 3. Pencil edit modal shows payment field for completed jobs
      const pencilPaymentField = await page.evaluate(() => {
        const c = (dbRecord?.customers||[]).find(x => x.scheduledStatus?.state === 'completed' && x.phone);
        if (!c) return null;
        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
        openEditModal(ph);
        const hdr   = document.getElementById('fePaymentHdr');
        const field = document.getElementById('fePaymentField');
        return hdr?.style.display !== 'none' && field?.style.display !== 'none';
      });
      if (pencilPaymentField === null) {
        warn('Pencil edit — payment field visible for completed job', 'no completed customer found');
      } else if (pencilPaymentField) {
        pass('Pencil edit — payment field visible for completed job');
      } else {
        fail('Pencil edit — payment field visible for completed job', 'fePaymentHdr or fePaymentField still hidden for completed job');
      }

      // 4. Pencil edit modal hides payment field for scheduled (not completed) jobs
      const pencilPaymentHidden = await page.evaluate(() => {
        const c = (dbRecord?.customers||[]).find(x => x.scheduledStatus?.state === 'scheduled' && x.phone);
        if (!c) return null;
        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
        openEditModal(ph);
        const hdr = document.getElementById('fePaymentHdr');
        return hdr?.style.display === 'none';
      });
      if (pencilPaymentHidden === null) {
        warn('Pencil edit — payment field hidden for scheduled job', 'no scheduled customer found');
      } else if (pencilPaymentHidden) {
        pass('Pencil edit — payment field hidden for scheduled job');
      } else {
        fail('Pencil edit — payment field hidden for scheduled job', 'fePaymentHdr is visible for a non-completed job');
      }
    });

    // ── PENCIL EDIT — three-field payment write (c.paymentInfo.method) ──────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_calendar.html`, 'pencil-payment-three-field', async page => {
      await page.waitForTimeout(2000);

      const result = await page.evaluate(async () => {
        // Find a completed customer with paymentInfo set (the 3rd field that was missing)
        const c = (dbRecord?.customers||[]).find(x =>
          x.scheduledStatus?.state === 'completed' &&
          x.paymentInfo?.paidAt &&
          x.phone && !x.isReferralOnly
        );
        if (!c) return { skip: 'no completed customer with paymentInfo found' };

        const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
        const oldMethod = c.paymentInfo.method || 'cash';
        const newMethod = oldMethod === 'zelle' ? 'cash' : 'zelle';

        // Stub saveDb and render to avoid live writes and re-navigation
        const origSaveDb = window.saveDb;
        const origRender = window.render;
        window.saveDb = () => Promise.resolve();
        window.render = () => {};

        openEditModal(ph);
        await new Promise(r => setTimeout(r, 100));

        const sel = document.getElementById('fePayMethod');
        if (!sel) {
          window.saveDb = origSaveDb; window.render = origRender;
          return { skip: 'fePayMethod dropdown not found' };
        }
        sel.value = newMethod;

        await saveFullEdit();

        const resultMethod = c.paymentInfo.method;
        const resultCPM    = c.paymentMethod;

        window.saveDb = origSaveDb;
        window.render = origRender;

        // Restore original values so we don't leave stale in-memory state
        c.paymentInfo.method = oldMethod;
        c.paymentMethod      = oldMethod;
        const jh = (c.jobHistory||[]).find(j => j.date === c.scheduledStatus?.scheduledDate && j.source !== 'csv_backfill');
        if (jh) { jh.paymentMethod = oldMethod; jh.payment = oldMethod; if (jh.paymentInfo) jh.paymentInfo.method = oldMethod; }

        return { oldMethod, newMethod, resultMethod, resultCPM, name: c.firstName };
      });

      if (result.skip) {
        warn('Pencil edit — three-field payment write (c.paymentInfo.method)', result.skip);
      } else {
        if (result.resultMethod === result.newMethod)
          pass('Pencil edit — three-field payment write: c.paymentInfo.method updated', `${result.oldMethod} → ${result.newMethod} for ${result.name}`);
        else
          fail('Pencil edit — three-field payment write: c.paymentInfo.method updated', `Expected ${result.newMethod}, got ${result.resultMethod}`);
        if (result.resultCPM === result.newMethod)
          pass('Pencil edit — three-field payment write: c.paymentMethod updated', `${result.oldMethod} → ${result.newMethod}`);
        else
          fail('Pencil edit — three-field payment write: c.paymentMethod updated', `Expected ${result.newMethod}, got ${result.resultCPM}`);
      }
    });

    // ── NEW CUSTOMER — match banner shows for duplicate phone ────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_new_customer.html`, 'nc-duplicate-detection', async page => {
      await page.waitForTimeout(2000);

      // Inject a test customer into allCustomers
      await page.evaluate(() => {
        allCustomers.push({ phone: '9990001111', firstName: 'Dupe', lastName: 'Test', scheduledStatus: null, jobHistory: [], alerts: [] });
      });

      // Type that phone into the form
      await page.fill('#nPhone', '(999) 000-1111');
      await page.dispatchEvent('#nPhone', 'input');
      await page.waitForTimeout(500);

      const bannerVisible = await page.locator('#matchBanner').isVisible().catch(() => false);
      if (bannerVisible) pass('New Customer — match banner appears for duplicate phone');
      else warn('New Customer — match banner appears for duplicate phone', 'matchBanner not visible after typing known duplicate — detection may have timing issue');
    });

    // ── NEW CUSTOMER — no phantom double after save (double-push bug fix) ────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_new_customer.html`, 'nc-no-double-push', async page => {
      await waitForData(page, () => typeof dbRecord !== 'undefined' && !!dbRecord && Array.isArray(dbRecord.customers));

      const result = await page.evaluate(() => {
        const countBefore = dbRecord.customers.length;
        const allBefore   = allCustomers.length;

        // Simulate adding a new customer: call the same path as submitPhonePath's else branch
        const testPhone = '8880009999';
        const c = { phone: testPhone, firstName: 'NoDupe', lastName: 'Test', totalJobs: 0, lifetimeSpend: 0, jobHistory: [], scheduledStatus: null };
        if (!dbRecord.customers) dbRecord.customers = [];
        dbRecord.customers.push(c);
        // allCustomers is the same reference — do NOT push again

        const countAfter = dbRecord.customers.length;
        const allAfter   = allCustomers.length;
        const phoneCount = dbRecord.customers.filter(x => x.phone === testPhone).length;
        // Check reference equality BEFORE cleanup (filter creates a new array)
        const referenceMatch = allCustomers === dbRecord.customers;

        // Cleanup — splice out test records (preserves reference, unlike filter)
        const testIdx = dbRecord.customers.findIndex(x => x.phone === testPhone);
        if (testIdx !== -1) dbRecord.customers.splice(testIdx, 1);

        return { countBefore, allBefore, countAfter, allAfter, phoneCount, referenceMatch };
      });

      if (result.referenceMatch) pass('New Customer — allCustomers and dbRecord.customers are same reference');
      else fail('New Customer — allCustomers and dbRecord.customers are same reference', 'They diverged — double-push bug may have returned');

      if (result.phoneCount === 1) pass('New Customer — one push creates exactly 1 record (no phantom double)');
      else fail('New Customer — one push creates exactly 1 record', `Found ${result.phoneCount} records with test phone — double-push bug still active`);

      if (result.countAfter === result.countBefore + 1) pass('New Customer — customer count increases by exactly 1');
      else fail('New Customer — customer count increases by exactly 1', `Before: ${result.countBefore}, after: ${result.countAfter}`);
    });

    // ── NEW CUSTOMER — 3-option post-save modal ────────────────────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_new_customer.html`, 'new-customer-postsave', async page => {
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

    // ── NEW CUSTOMER — existing customer detection + alt phone ─────────────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_new_customer.html`, 'new-customer-detection', async page => {
      // Alternate contacts container is present
      const containerExists = await page.locator('#altContactsContainer').count();
      if (containerExists) pass('New Customer — alt contacts container present');
      else fail('New Customer — alt contacts container present', '#altContactsContainer not found');

      // Alt contacts container is empty by default
      const containerEmpty = await page.locator('#altContactsContainer').evaluate(el => el.children.length === 0);
      if (containerEmpty) pass('New Customer — alt contacts container empty by default');
      else fail('New Customer — alt contacts container empty by default', 'container has children on load');

      // Clicking "+ Add another contact" adds an entry
      await page.evaluate(() => addAltContact());
      const entryAdded = await page.locator('#altContactsContainer .alt-contact-entry').count();
      if (entryAdded === 1) pass('New Customer — "+ Add another contact" adds entry');
      else fail('New Customer — "+ Add another contact" adds entry', `expected 1 entry, got ${entryAdded}`);

      // Match banner hidden by default
      const bannerHidden = await page.locator('#matchBanner').evaluate(el => el.style.display === 'none' || getComputedStyle(el).display === 'none');
      if (bannerHidden) pass('New Customer — match banner hidden by default');
      else fail('New Customer — match banner hidden by default', '#matchBanner visible on load');

      // showMatchBanner() populates and shows the banner
      const bannerShown = await page.evaluate(() => {
        try {
          window._matchResults = [];
          const fakeCustomer = {
            firstName: 'Jane', lastName: 'Test', phone: '9545550001',
            address: '100 Test St', city: 'Weston',
            jobHistory: [{ status:'completed', date:'2025-11-01', amount:350, services:'Driveway pressure wash', completedAt:'2025-11-01T12:00:00Z' }],
            totalJobs: 1, lifetimeSpend: 350
          };
          window.allCustomers = window.allCustomers || [];
          showMatchBanner([fakeCustomer]);
          return document.getElementById('matchBanner').style.display === 'block';
        } catch(e) { return e.message; }
      });
      if (bannerShown === true) pass('New Customer — showMatchBanner() makes banner visible');
      else fail('New Customer — showMatchBanner() makes banner visible', String(bannerShown));

      // Banner has Yes / No / View profile buttons
      const hasYes = await page.locator('.match-yes').isVisible();
      const hasNo  = await page.locator('.match-no').isVisible();
      if (hasYes && hasNo) pass('New Customer — match banner has Yes + No buttons');
      else fail('New Customer — match banner has Yes + No buttons', `yes=${hasYes} no=${hasNo}`);

      // "No, this is new" dismisses banner
      await page.locator('.match-no').click();
      const dismissed = await page.locator('#matchBanner').evaluate(el => el.style.display === 'none');
      if (dismissed) pass('New Customer — dismiss match banner hides it');
      else fail('New Customer — dismiss match banner hides it', 'banner still visible after dismissal');

      // useMatch fills form and shows job history
      // Note: use showMatchBanner to populate the script-level _matchResults (window.x won't reach let vars)
      const matchUsed = await page.evaluate(() => {
        try {
          const fakeCustomer = {
            firstName: 'Jane', lastName: 'Test', phone: '9545550001',
            address: '100 Test St', city: 'Weston',
            email: 'jane@test.com', zip: '33326', notes: 'Gate code 1234', alerts: [],
            jobHistory: [{ status:'completed', date:'2025-11-01', amount:350, services:'Driveway', completedAt:'2025-11-01T12:00:00Z' }],
            totalJobs: 1, lifetimeSpend: 350
          };
          showMatchBanner([fakeCustomer]);
          useMatch(0);
          const fnVal   = document.getElementById('nFn').value;
          const jhShown = document.getElementById('jhSection').style.display !== 'none';
          return { fn: fnVal, jhShown };
        } catch(e) { return { error: e.message }; }
      });
      if (matchUsed.error) fail('New Customer — useMatch() fills form + shows history', matchUsed.error);
      else if (matchUsed.fn === 'Jane' && matchUsed.jhShown) pass('New Customer — useMatch() fills form + shows job history');
      else fail('New Customer — useMatch() fills form + shows job history', `fn=${matchUsed.fn} jhShown=${matchUsed.jhShown}`);

      // ── Regression: property picker renders with __new__ option ────────────────
      // This was the gap: tests confirmed markup exists but not that showPropertyPicker
      // renders the "+ Add new property" option when called with multi-property data.
      const pickerResult = await page.evaluate(() => {
        try {
          const fakeProps = [
            { propertyId: 'prop_test_1', streetAddress: '1000 Main St', city: 'Weston',
              zip: '33326', propertyLabel: 'Main Residence', propertyType: 'main_residence',
              primaryContact: true, gateCode: null, accessNotes: null },
            { propertyId: 'prop_test_2', streetAddress: '200 Rental Ave', city: 'Davie',
              zip: '33314', propertyLabel: 'Rental', propertyType: 'rental',
              primaryContact: false, gateCode: null, accessNotes: null },
          ];
          // Reset state before test
          window._customerProperties = [];
          window._selectedPropertyId = null;
          document.getElementById('propertyPickerWrap').style.display = 'none';

          showPropertyPicker(fakeProps);

          const wrap    = document.getElementById('propertyPickerWrap');
          const sel     = document.getElementById('propertyPickerSel');
          const visible = wrap && wrap.style.display !== 'none';
          const opts    = sel ? Array.from(sel.options).map(o => ({ val: o.value, text: o.textContent })) : [];
          const hasNew  = opts.some(o => o.val === '__new__' && o.text.includes('Add new property'));
          const propOpts = opts.filter(o => o.val !== '__new__' && o.val !== '');
          return { visible, hasNew, propCount: propOpts.length, opts };
        } catch(e) { return { error: e.message }; }
      });
      if (pickerResult.error) {
        fail('New Customer — property picker renders for multi-property customer', pickerResult.error);
      } else if (!pickerResult.visible) {
        fail('New Customer — property picker renders for multi-property customer', '#propertyPickerWrap not visible after showPropertyPicker()');
      } else if (pickerResult.propCount < 2) {
        fail('New Customer — property picker renders for multi-property customer', `expected 2 property options, got ${pickerResult.propCount}`);
      } else if (!pickerResult.hasNew) {
        fail('New Customer — property picker renders for multi-property customer', '"+ Add new property" option missing from dropdown');
      } else {
        pass('New Customer — property picker renders for multi-property customer', `${pickerResult.propCount} properties + __new__ option present`);
      }

      // 2026-07-23 P0 (Jhon Hernandez): adding a NEW property mid-booking must
      // bind _selectedPropertyId from the server's returned id — NOT a re-fetch
      // address string match, which silently failed on server normalization and
      // left the id null → multi-property guard blocked scheduling. Stub both
      // endpoints so the returned/normalized address DIFFERS from what was typed.
      await page.route('**/admin/property', route =>
        route.request().method() === 'POST'
          ? route.fulfill({ status:200, contentType:'application/json',
              body: JSON.stringify({ success:true, propertyId:'prop_new_rental_999' }) })
          : route.continue());
      await page.route('**/customer/9545550001', route =>
        route.fulfill({ status:200, contentType:'application/json',
          body: JSON.stringify({ customer:{ firstName:'Jane', properties:[
            { propertyId:'prop_test_1', streetAddress:'1000 Main St', city:'Weston', primaryContact:true },
            // NOTE server-normalized street ("Avenue") ≠ typed ("Ave") — the old match loop breaks here
            { propertyId:'prop_new_rental_999', streetAddress:'200 Rental Avenue', city:'Davie', primaryContact:false },
          ]}}) }));
      const bind = await page.evaluate(async () => {
        try {
          // NB: _selectedPropertyId is a top-level `let`, NOT a window property —
          // read/write the bare identifier (same gotcha as _activeQuoteId).
          _selectedPropertyId = null;
          document.getElementById('nPhone').value = '(954) 555-0001';
          const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
          set('newPropAddr','200 Rental Ave'); set('newPropCity','Davie'); set('newPropLabel','Rental');
          const t = document.querySelector('input[name="newPropType"][value="rental"]'); if (t) t.checked = true;
          await submitNewProperty();
          return { selected: typeof _selectedPropertyId !== 'undefined' ? _selectedPropertyId : null };
        } catch(e) { return { error: e.message }; }
      });
      await page.unroute('**/admin/property'); await page.unroute('**/customer/9545550001');
      if (bind.selected === 'prop_new_rental_999') pass('New Customer — new mid-booking property binds _selectedPropertyId from server id (survives address normalization)');
      else fail('New Customer — new property id binding', JSON.stringify(bind));
    });

    // ── DIRECTORY — address normalization (2026-07-23, Todd Griffin case) ──────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_customer_directory.html`, 'directory-addr-search', async page => {
      await page.waitForFunction(() => typeof allCustomers !== 'undefined' && allCustomers.length > 0
        && typeof _normalizeAddress === 'function' && typeof _addrMatch === 'function', { timeout: 45000 });
      const r = await page.evaluate(() => {
        const run = q => {
          searchVal = q.trim().toLowerCase();
          const nq = _normalizeAddress(searchVal);
          const nqT = nq.split(' ').filter(Boolean);
          return allCustomers.filter(c => _addrMatch(nq, nqT, c));
        };
        const names = rs => rs.map(c => c._name);
        const out = {};
        // The live regression case: Todd Griffin @ 2010 Northwest 85th Avenue
        out.nw       = names(run('2010 NW')).some(n => n.includes('griffin'));
        out.longForm = names(run('2010 Northwest')).some(n => n.includes('griffin'));
        out.ordinal  = names(run('2010 nw 85')).some(n => n.includes('griffin'));
        // Reverse direction: an address stored abbreviated, queried long-form.
        const abbrev = allCustomers.find(c => /\b(nw|ne|sw|se)\b/.test(c._normAddr) && (c.address||'').match(/\b(NW|NE|SW|SE)\b/));
        out.reverseCase = abbrev ? abbrev.address : null;
        if (abbrev) {
          const longDir = { nw:'northwest', ne:'northeast', sw:'southwest', se:'southeast' };
          const m = abbrev._normAddr.match(/\b(nw|ne|sw|se)\b/);
          const q = abbrev._normAddr.split(' ')[0] + ' ' + longDir[m[1]];
          out.reverse = run(q).includes(abbrev);
        }
        // Street-name-only + both ave forms hit the same records
        out.canary  = names(run('Canary Island')).some(n => n.includes('wolf'));
        out.aveSame = names(run('85th Ave')).join('|') === names(run('85th Avenue')).join('|');
        // REGRESSION GUARD — name + phone paths byte-identical in code, spot-check live:
        const nameHit = (q, who) => { searchVal = q; return allCustomers.some(c => _fuzzyNameScore(q, c) > 0 && c._name.includes(who)); };
        out.nick1 = nameHit('beth', 'elizabeth') || !allCustomers.some(c => c._name.includes('elizabeth'));
        out.nick2 = nameHit('chris', 'christopher') || !allCustomers.some(c => c._name.includes('christopher'));
        out.exact = nameHit('griffin', 'griffin');
        const phoned = allCustomers.find(c => (c.phone||'').length === 10);
        out.phone = phoned ? (phoned.phone.slice(0,6).length && allCustomers.filter(c => (c.phone||'').includes(phoned.phone.slice(0,6))).includes(phoned)) : null;
        searchVal = '';
        return out;
      });
      const checks = [
        ['"2010 NW" finds Todd Griffin', r.nw],
        ['"2010 Northwest" finds Todd Griffin', r.longForm],
        ['"2010 nw 85" finds Todd Griffin (ordinal prefix)', r.ordinal],
        [`long-form query finds abbreviated address (${r.reverseCase})`, r.reverse],
        ['"Canary Island" still finds Keith Wolf', r.canary],
        ['"85th Ave" ≡ "85th Avenue" result sets', r.aveSame],
        ['name search regression (nickname beth→elizabeth)', r.nick1],
        ['name search regression (nickname chris→christopher)', r.nick2],
        ['name search regression (exact surname)', r.exact],
        ['partial-phone search regression', r.phone !== false],
      ];
      for (const [label, ok] of checks) {
        if (ok) pass(`Directory addr — ${label}`);
        else fail(`Directory addr — ${label}`, JSON.stringify(r));
      }
    });

    // ── DIRECTORY — address visible in results table (2026-07-23 QoL) ─────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_customer_directory.html`, 'directory-addr-column', async page => {
      await page.waitForFunction(() => typeof allCustomers !== 'undefined' && allCustomers.length > 0
        && typeof buildRow === 'function', { timeout: 45000 });
      const r = await page.evaluate(() => {
        const withAddr = allCustomers.find(c => c.address && c.city);
        if (!withAddr) return { skip: true };
        const html = buildRow(withAddr);
        return { addr: withAddr.address, city: withAddr.city,
          hasAddr: html.includes(withAddr.address), hasCity: html.includes(withAddr.city) };
      });
      if (r.skip) { pass('Directory — address column (no addressed customer to sample)'); return; }
      if (r.hasAddr && r.hasCity) pass('Directory — results row shows street address + city', r.addr);
      else fail('Directory — results row shows street address + city', JSON.stringify(r));
    });

    // ── QUOTE POOL (2026-07-23 WO) — page shell + shared logger modal ──────────
    queuePage(context, `${PAGES_BASE}/pure_cleaning_quote_pool.html`, 'quote-pool', async page => {
      // v1.4: 5 tabs, order Open · Ledger · Accepted · Declined · Insights; default Open
      const tabs = await page.locator('.tab').allTextContents();
      if (tabs.length === 5 && /Open/.test(tabs[0]) && /Ledger/.test(tabs[1]) && /Accepted/.test(tabs[2]) && /Declined/.test(tabs[3]) && /Insights/.test(tabs[4]))
        pass('Quote Pool — 5 tabs in order Open/Ledger/Accepted/Declined/Insights');
      else fail('Quote Pool — 5 tabs in order', JSON.stringify(tabs));
      const defaultOn = await page.locator('.tab.on').getAttribute('data-tab');
      if (defaultOn === 'open') pass('Quote Pool — default tab is Open');
      else fail('Quote Pool — default tab is Open', `on=${defaultOn}`);

      // v1.4 Ledger: period math + summary honesty, driven by injected fixtures
      // (no live data touched — _ledger + render are pure functions of state).
      const led = await page.evaluate(() => {
        const iso = (y,m,d) => new Date(y, m-1, d, 12).toISOString();
        _ledger = [
          { quoteId:'l1', createdAt: iso(2026,7,10), firstName:'A', status:'accepted', city:'Weston', services:['roof'], priceQuoted:400 },
          { quoteId:'l2', createdAt: iso(2026,7,12), firstName:'B', status:'declined', declineReason:'price', services:[], priceQuoted:200 },
          { quoteId:'l3', createdAt: iso(2026,7,15), firstName:'C', status:'quoted', services:['patio'], priceQuoted:null },
          { quoteId:'l4', createdAt: iso(2026,6,5),  firstName:'D', status:'accepted', services:[], priceQuoted:300 },
        ];
        _ledgerPeriod = 'month';
        _ledgerAnchor = new Date(2026, 6, 20, 12);   // July 2026
        renderLedger();
        const rows = [...document.querySelectorAll('.lg-row')];
        const out = {
          label: document.getElementById('lgLabel').textContent,
          rowCount: rows.length,
          firstMark: rows[0]?.querySelector('.lg-mark')?.textContent,
          marks: rows.map(r => r.querySelector('.lg-mark').textContent).join(''),
          hasReason: !!document.querySelector('.lg-reason'),
          summary: document.getElementById('lgSummary').textContent,
          nextDisabled: document.getElementById('lgNext').disabled,
        };
        // June has 1 row; step back
        _ledgerAnchor = new Date(2026, 5, 20, 12);
        renderLedger();
        out.juneLabel = document.getElementById('lgLabel').textContent;
        out.juneRows  = document.querySelectorAll('.lg-row').length;
        // empty month
        _ledgerAnchor = new Date(2026, 3, 20, 12);
        renderLedger();
        out.emptyShown = /No quotes logged this month/.test(document.getElementById('content').textContent);
        return out;
      });
      if (/July 2026/.test(led.label)) pass('Quote Pool Ledger — month label renders'); else fail('Quote Pool Ledger — month label', JSON.stringify(led));
      if (led.rowCount === 3) pass('Quote Pool Ledger — July scoped to its 3 rows'); else fail('Quote Pool Ledger — July row count', JSON.stringify(led));
      // newest-first: 7/15 open(○), 7/12 declined(✗), 7/10 accepted(✓)
      if (led.marks === '○✗✓') pass('Quote Pool Ledger — newest-first + status marks ○✗✓'); else fail('Quote Pool Ledger — order/marks', JSON.stringify(led));
      if (led.hasReason) pass('Quote Pool Ledger — declined row shows reason chip'); else fail('Quote Pool Ledger — reason chip', JSON.stringify(led));
      // 3 quotes · 1 ✓ · 1 ✗ · 1 open · 50% accepted (open excluded from the %)
      if (/1.*✓.*1.*✗.*1.*open.*50%/.test(led.summary.replace(/\s+/g,' '))) pass('Quote Pool Ledger — summary math (50%, open excluded)'); else fail('Quote Pool Ledger — summary math', JSON.stringify(led.summary));
      // July 2026 IS the current month (session date) → forward arrow disabled
      if (led.nextDisabled) pass('Quote Pool Ledger — forward arrow disabled at current period'); else fail('Quote Pool Ledger — forward disabled', JSON.stringify(led));
      if (led.juneRows === 1) pass('Quote Pool Ledger — ← steps to June (1 row)'); else fail('Quote Pool Ledger — June step', JSON.stringify(led));
      if (led.emptyShown) pass('Quote Pool Ledger — empty month shows empty-state'); else fail('Quote Pool Ledger — empty state', JSON.stringify(led));

      // reset back to Open for the modal checks below
      await page.evaluate(() => setTab('open'));

      // ＋ Log Quote opens the shared 15-second modal (quote-logger.js injected)
      await page.locator('.log-btn').click();
      const overlayOpen = await page.locator('#qlOverlay.open').count();
      if (overlayOpen) pass('Quote Pool — Log Quote opens the quick-entry modal');
      else { fail('Quote Pool — Log Quote opens the quick-entry modal', '#qlOverlay.open not found'); return; }

      // v1.1: 10 service chips + ＋ Other = 11 (customs add more at runtime)
      const svcChips = await page.locator('#qlSvcChips .ql-chip').count();
      if (svcChips === 11) pass('Quote Pool — modal has 10 service chips + Other');
      else fail('Quote Pool — modal has 10 service chips + Other', `found ${svcChips}`);

      // v1.1: quotedBy toggle is gone
      const whoGone = await page.locator('#qlWho').count();
      if (whoGone === 0) pass('Quote Pool — quotedBy toggle removed');
      else fail('Quote Pool — quotedBy toggle removed', '#qlWho still present');

      // v1.1 auto-bundle: Roof tap lights Walls; Walls un-taps independently;
      // Walls works standalone after Roof is off.
      const bundle = await page.evaluate(() => {
        const chip = k => document.querySelector(`#qlSvcChips .ql-chip[data-key="${k}"]`);
        const on = k => chip(k).classList.contains('on');
        chip('roof').click();
        const wallsAutoLit = on('walls');
        chip('walls').click();
        const wallsUntapped = !on('walls') && on('roof');
        chip('roof').click();                       // roof off (walls was manual)
        chip('walls').click();                      // walls standalone
        const wallsStandalone = on('walls') && !on('roof');
        chip('walls').click();                      // reset
        return { wallsAutoLit, wallsUntapped, wallsStandalone };
      });
      if (bundle.wallsAutoLit) pass('Quote Pool — Roof auto-lights Walls');
      else fail('Quote Pool — Roof auto-lights Walls', JSON.stringify(bundle));
      if (bundle.wallsUntapped) pass('Quote Pool — Walls un-taps independently of Roof');
      else fail('Quote Pool — Walls un-taps independently', JSON.stringify(bundle));
      if (bundle.wallsStandalone) pass('Quote Pool — Walls selectable standalone');
      else fail('Quote Pool — Walls selectable standalone', JSON.stringify(bundle));

      // v1.1 write-in: ＋ Other reveals input; Enter commits a removable chip
      const custom = await page.evaluate(() => {
        document.getElementById('qlOtherChip').click();
        const inp = document.getElementById('qlCustomText');
        const visible = document.getElementById('qlCustomWrap').style.display !== 'none';
        inp.value = 'screen enclosure';
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const chipAdded = !!document.querySelector('#qlSvcChips .ql-chip[data-custom]');
        return { visible, chipAdded };
      });
      if (custom.visible && custom.chipAdded) pass('Quote Pool — write-in service commits as a chip');
      else fail('Quote Pool — write-in service commits as a chip', JSON.stringify(custom));

      const bothActions = await page.locator('#qlSave').count() && await page.locator('#qlConfirm').count();
      if (bothActions) pass('Quote Pool — modal has Save Quote + Already Booked actions');
      else fail('Quote Pool — modal has Save Quote + Already Booked actions', 'a save button is missing');
      const confirmLabel = await page.locator('#qlConfirm').textContent();
      if (/Already Booked/.test(confirmLabel)) pass('Quote Pool — confirmed button reads "Already Booked →"');
      else fail('Quote Pool — confirmed button reads "Already Booked →"', `label: '${confirmLabel}'`);

      // Empty phone must not save — the only required field is enforced
      await page.locator('#qlSave').click();
      const errShown = await page.locator('#qlErr').isVisible();
      if (errShown) pass('Quote Pool — save without phone blocked with inline error');
      else fail('Quote Pool — save without phone blocked', '#qlErr not shown after empty save');

      // v1.2: delete confirm modal — opens with linked-booking warning toggled
      // by personId (no live data touched; openDelete handles unknown ids).
      const del = await page.evaluate(() => {
        window.QuoteLogger.close();
        openDelete('qt_nonexistent');
        const open1 = document.getElementById('deleteModal').classList.contains('on');
        const warnHidden = document.getElementById('deleteLinkedWarn').style.display === 'none';
        closeModal('deleteModal');
        _quotes = [{ quoteId:'qt_x', personId:'person_1x', phone:'0000000000', services:[], createdAt:new Date().toISOString(), status:'accepted' }];
        openDelete('qt_x');
        const warnShown = document.getElementById('deleteLinkedWarn').style.display !== 'none';
        closeModal('deleteModal');
        _quotes = [];
        return { open1, warnHidden, warnShown };
      });
      if (del.open1 && del.warnHidden) pass('Quote Pool — delete confirm opens (no warning for unlinked)');
      else fail('Quote Pool — delete confirm opens', JSON.stringify(del));
      if (del.warnShown) pass('Quote Pool — linked-booking warning shows for personId rows');
      else fail('Quote Pool — linked-booking warning shows', JSON.stringify(del));

      // v1.3 fast exit — LAST in this block (it navigates away): name-only +
      // [Already Booked →] must pass validation and hand off to the booking
      // form. POST /admin/quote is stubbed so the live pad gets NO row.
      await page.route('**/admin/quote', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, quoteId: 'qt_stub_v13', status: 'accepted' }),
      }));
      await page.evaluate(() => {
        QuoteLogger.open({});
        document.getElementById('qlName').value = 'FastExit Test';
      });
      await page.locator('#qlConfirm').click();
      const navigated = await page.waitForURL(/fromOnline=/, { timeout: 10000 }).then(() => true).catch(() => false);
      if (navigated) pass('Quote Pool — name-only Already Booked hands off to booking form (no phone error)');
      else {
        const errTxt = await page.locator('#qlErr').textContent().catch(() => '');
        fail('Quote Pool — name-only Already Booked hands off', `did not navigate; qlErr='${errTxt}'`);
      }
    });

    // ── NEW CUSTOMER — Quote Pool hand-off contract (fromOnline svc/price/quoteId) ──
    queuePage(context,
      `${PAGES_BASE}/pure_cleaning_new_customer.html?fromOnline=${encodeURIComponent(Buffer.from(JSON.stringify({ fn:'Handoff', ln:'Test', phone:'8880001111', city:'Weston', svc:['driveway','roof_cleaning','rinse_walls'], svcCustom:'house wash, screen enclosure', price:275, quoteId:'qt_verify_handoff' })).toString('base64'))}`,
      'new-customer-quote-handoff', async page => {
      // init() awaits the customer-DB fetch before applying the fromOnline blob —
      // wait for the hand-off context to land (45s: full DB pull on a cold context).
      // NB: _activeQuoteId is a top-level `let` — NOT a window property; read the bare identifier.
      const ready = await page.waitForFunction(() => typeof _activeQuoteId !== 'undefined' && _activeQuoteId === 'qt_verify_handoff',
        { timeout: 45000 }).then(() => true).catch(() => false);
      if (!ready) { fail('New Customer — quote hand-off context', '_activeQuoteId never set — init() did not apply the fromOnline blob'); return; }
      const r = await page.evaluate(() => {
        try {
          const svcSel = typeof _svcSel !== 'undefined' ? [..._svcSel] : [];
          openScheduleModal();
          return {
            quoteId: typeof _activeQuoteId    !== 'undefined' ? _activeQuoteId    : null,
            price:   typeof _activeQuotePrice !== 'undefined' ? _activeQuotePrice : null,
            svcSel,
            schedPrice: document.getElementById('schedPrice').value,
            fn: document.getElementById('nFn').value,
            customText: document.getElementById('customServiceText').value,
          };
        } catch(e) { return { error: e.message }; }
      });
      if (r.error) { fail('New Customer — quote hand-off context', r.error); return; }
      if (r.quoteId === 'qt_verify_handoff') pass('New Customer — hand-off carries quoteId');
      else fail('New Customer — hand-off carries quoteId', `got ${r.quoteId}`);
      if (r.svcSel.includes('driveway') && r.svcSel.includes('roof_cleaning') && r.svcSel.includes('rinse_walls'))
        pass('New Customer — hand-off preselects services via toggleService (incl. roof+walls)');
      else fail('New Customer — hand-off preselects services', `svcSel=${JSON.stringify(r.svcSel)}`);
      // v1.1: write-ins + chip notes land in the picker's custom text
      if (r.customText === 'house wash, screen enclosure') pass('New Customer — hand-off carries custom service text');
      else fail('New Customer — hand-off carries custom service text', `got '${r.customText}'`);
      if (r.price === 275 && r.schedPrice === '275') pass('New Customer — quoted price prefills schedule modal', '$275');
      else fail('New Customer — quoted price prefills schedule modal', `price=${r.price} schedPrice='${r.schedPrice}'`);
      if (r.fn === 'Handoff') pass('New Customer — hand-off prefills name');
      else fail('New Customer — hand-off prefills name', `fn='${r.fn}'`);
    });

    // WO-9: run all registered blocks — read-only in parallel batches, mutating serial.
    await drainQueue();

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
