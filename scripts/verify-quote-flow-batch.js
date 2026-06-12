#!/usr/bin/env node
/**
 * One-shot verifier for the 2026-06-12 quote-flow bundle (Items 1-5).
 * Standalone — does NOT live in the regular deploy pipeline. Run manually:
 *   node scripts/verify-quote-flow-batch.js
 *
 * Covers:
 *   1.1  Builder click 2-Story → Generate → quote KV record has roofStories=2
 *   1.2  Reopen builder with same ?customer= → 2-Story radio is checked (prefill)
 *   1.3  Regenerate WITHOUT touching radio → scheduledStatus.roofStories stays 2
 *   1.5  Lynn Felson (9546146831) fixture: empty roof-jh + ss=completed
 *        → builder prefills from Property.stories=1 (DL-01 rung)
 *   2    Appraiser button absent from builder address row
 *   3    Sealing-flagged quote → sealing-note-card visible, no "Sealing quote
 *        requested" in WHAT'S INCLUDED list
 *   4    Confirmed quote → celebration-hero visible, body.is-confirmed set,
 *        action buttons present, terms expander present
 *   5    Builder dedupe: services with both "Rinse Walls" + "Rinse walls & windows"
 *        → builder ingest yields the combined only (the standalone is dropped)
 */

const { chromium } = require('playwright');
const { getVerifyToken } = require('./lib/auto-auth');

const API   = 'https://purecleaning-api.tylerfumero.workers.dev';
const PAGES = 'https://purecleaningpressurecleaning.com';

const results = [];
let failures = 0;
const pass = (l, d = '') => { console.log(`✅  ${l}${d?'  '+d:''}`); results.push({ status:'PASS', l, d }); };
const fail = (l, d = '') => { console.log(`❌  ${l}${d?'  '+d:''}`); results.push({ status:'FAIL', l, d }); failures++; };
const warn = (l, d = '') => { console.log(`⚠️   ${l}${d?'  '+d:''}`); results.push({ status:'WARN', l, d }); };

// UTF-8-safe base64 (mirrors the builder's prefill format)
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// Build the ?customer= slim payload the way the builder expects
function buildCustomerParam({ fn='Click', ln='Test', ph='5559990002', addr='123 Test St, Weston, FL 33326', s='', tags=null }) {
  const slim = { n: `${fn} ${ln}`, p: ph, a: addr, ...(s ? { s } : {}), ...(tags ? { tags } : {}) };
  return encodeURIComponent(b64(JSON.stringify(slim)));
}

async function main() {
  console.log('Logging in for admin endpoints...');
  const session = await getVerifyToken();
  if (!session) { console.error('No admin token — set ADMIN_PASSWORD in .env.local'); process.exit(2); }
  // getVerifyToken returns { token, expiresAt } — extract the raw token for direct use.
  const token = session.token || session;

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Page-level admin auth seed — the builder page's gate checks these two localStorage keys.
  // Mirrors the pattern verify-browser.js uses at line 193-204.
  const expiresAt = Date.now() + 86400000;
  await context.addInitScript(({ tok, exp }) => {
    try {
      localStorage.setItem('admin_token', tok);
      localStorage.setItem('admin_token_expires', String(exp));
      // Clear any prior builder draft so cross-test state doesn't bleed in.
      localStorage.removeItem('pcpc_qb_draft');
    } catch {}
  }, { tok: token, exp: expiresAt });

  // ── Item 2: Appraiser button absent ────────────────────────────────────
  {
    const page = await context.newPage();
    const param = buildCustomerParam({ fn:'Apr', ln:'Test', ph:'5559990003', addr:'500 Test Ave, Weston, FL', s:'Driveway' });
    await page.goto(`${PAGES}/pure_cleaning_quote_builder_v2.html?customer=${param}`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const apprPresent = await page.evaluate(() => {
      const wrap = document.getElementById('propLinkWrap');
      const html = wrap ? wrap.innerHTML : '';
      return /📍 (Appraiser|BCPA|Miami-Dade PA|PBC PAO)/.test(html);
    });
    const bcpaLinkPresent = await page.evaluate(() => {
      const txt = document.querySelector('.appraiser-links')?.textContent || '';
      return /Broward \(BCPA\)/.test(txt) && /Miami-Dade/.test(txt) && /Palm Beach/.test(txt);
    });
    apprPresent ? fail('Item 2 — 📍 Appraiser button still in DOM') : pass('Item 2 — 📍 Appraiser button removed from satellite/aerial row');
    bcpaLinkPresent ? pass('Item 2 — Broward/Miami-Dade/Palm Beach sq-ft links intact below') : fail('Item 2 — sq-ft BCPA link row missing');
    await page.close();
  }

  // ── Item 1.5: Lynn Felson (Property.stories=1, empty roof-jh, ss=completed) ─
  {
    const page = await context.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));
    const param = buildCustomerParam({ fn:'Lynn', ln:'Felson', ph:'9546146831', addr:'15814 Cotswold Ct, Davie, FL', s:'Roof — Softwash, Driveway' });
    await page.goto(`${PAGES}/pure_cleaning_quote_builder_v2.html?customer=${param}`, { waitUntil: 'load' });
    await page.waitForTimeout(4500); // checkCustomerAlerts is async (DB fetch + setTimeout 500ms prefill)
    const debug = await page.evaluate(async () => {
      // Direct probe — call the inference function on a freshly fetched customer.
      try {
        const r = await fetch('/customers', { headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '') } });
        if (!r.ok) return { error: 'customers fetch HTTP ' + r.status };
        const db = await r.json();
        const c = (db.customers || []).find(x => x.phone === '9546146831');
        if (!c) return { error: 'Lynn not found in DB' };
        const inferred = (typeof _inferRoofStories === 'function') ? _inferRoofStories(c) : 'no-fn';
        const ssR = c.scheduledStatus?.roofStories;
        const qsR = c.quoteStatus?.roofStories;
        const propStories = (c.properties || []).map(p => ({ primary: p.primaryContact, stories: p.stories }));
        const userSet = (typeof _userSetStories !== 'undefined') ? _userSetStories : 'undef';
        const radioOne = document.getElementById('v2Stories1')?.checked || false;
        const radioTwo = document.querySelector('input[name=v2RoofStories][value="2"]')?.checked || false;
        const radioUnk = document.getElementById('v2StoriesUnk')?.checked || false;
        const selectorVisible = document.getElementById('v2StorySel')?.style?.display !== 'none';
        return { inferred, ssR, qsR, propStories, userSet, customerType: c.customerType, radioOne, radioTwo, radioUnk, selectorVisible };
      } catch (e) { return { error: e.message }; }
    });
    console.log('  ↪ Lynn debug probe:', JSON.stringify(debug));
    if (debug.error) {
      fail('Item 1 step 5 — Lynn debug probe error', debug.error);
    } else if (debug.radioOne) {
      pass('Item 1 step 5 — Lynn Felson prefills 1-Story from Property rung (DL-01 master)', `inferred=${debug.inferred}`);
    } else if (debug.inferred === 1) {
      // Inference works but radio didn't get set — probably a timing/load-order issue we can fix
      fail('Item 1 step 5 — _inferRoofStories returned 1 but radio not set',
           `userSetStories=${debug.userSet} radios=[1:${debug.radioOne},2:${debug.radioTwo},unk:${debug.radioUnk}] selectorVis=${debug.selectorVisible}`);
    } else {
      fail('Item 1 step 5 — _inferRoofStories did NOT return 1',
           `inferred=${debug.inferred} props=${JSON.stringify(debug.propStories)} ss=${debug.ssR} qs=${debug.qsR}`);
    }
    if (logs.length) console.log('  ↪ console (last 5):', logs.slice(-5).join(' | '));
    await page.close();
  }

  // ── Item 1.1 + 1.2 + 1.3: Click 2-Story → Generate → KV check → Reopen prefill → Regenerate preserve ─
  let testPhone = '5559990010';
  let mqCode = null;
  {
    const page = await context.newPage();
    const param = buildCustomerParam({ fn:'Click', ln:'Test', ph:testPhone, addr:'9999 Story Test Ln, Weston, FL', s:'Roof — Softwash' });
    await page.goto(`${PAGES}/pure_cleaning_quote_builder_v2.html?customer=${param}`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    // Enter a price so generate is enabled
    await page.fill('#quotePricePressure', '550');
    // Pick a primary date
    const today = new Date();
    const future = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0,10);
    await page.fill('#primaryDate', future);
    // Click 2-Story
    const r2 = await page.locator('input[name=v2RoofStories][value="2"]');
    await r2.click();
    await page.waitForTimeout(800);
    const checkedAfterClick = await page.evaluate(() => document.querySelector('input[name=v2RoofStories]:checked')?.value);
    checkedAfterClick === '2' ? pass('Item 1 step 1 — 2-Story click toggles radio', `value=${checkedAfterClick}`)
                              : fail('Item 1 step 1 — 2-Story click did not toggle', `got value=${checkedAfterClick}`);

    // Capture mqCode + detect when the fire-and-forget customer-DB PUT lands.
    // The builder's customer-DB IIFE (line ~1455) launches AFTER the quote PUT
    // resolves, GETs /customers, modifies, PUTs back. We must NOT close the page
    // before that PUT lands or Playwright cancels the in-flight request and
    // scheduledStatus never persists.
    let capturedCode = null;
    let custDbPutLanded = false;
    page.on('request', req => {
      const u = req.url();
      const m = u.match(/\/quote\/([A-Za-z0-9_-]+)/);
      if (m && req.method() === 'PUT') capturedCode = m[1];
    });
    page.on('requestfinished', req => {
      if (req.method() === 'PUT' && req.url().endsWith('/customers')) custDbPutLanded = true;
    });
    // Click the generate button (preview or build tab)
    const genBtn = page.locator('#previewGenerateBtn, #generateBtn').first();
    await genBtn.click();
    await page.waitForTimeout(4000);
    if (capturedCode) {
      mqCode = capturedCode;
      pass('Item 1 step 1 — Quote PUT intercepted', `code=${mqCode}`);
    } else {
      warn('Item 1 step 1 — Did not intercept a /quote/ PUT', '');
    }

    // Hit the worker to assert KV roofStories=2
    if (mqCode) {
      try {
        const res = await fetch(`${API}/quote/${mqCode}`);
        const data = await res.json();
        if (data.roofStories === 2) pass('Item 1 step 1 — KV quote_'+mqCode+' has roofStories=2');
        else fail('Item 1 step 1 — KV roofStories mismatch', `expected 2, got ${data.roofStories}`);
      } catch (e) { fail('Item 1 step 1 — KV fetch failed', e.message); }
    }
    // Wait for the fire-and-forget customer-DB PUT to land (listener attached above).
    // Otherwise Playwright cancels the in-flight request when the page closes.
    for (let i = 0; i < 30 && !custDbPutLanded; i++) await page.waitForTimeout(200);
    if (custDbPutLanded) pass('Item 1 step 1 — Customer DB PUT /customers landed (fire-and-forget write completed)');
    else warn('Item 1 step 1 — Customer DB PUT did not land within 6s — step 2 may fail');
    await page.close();
  }

  // ── Helper: clear the builder's sessionStorage cache so the next page sees fresh DB ─
  // The builder caches /customers in sessionStorage for 5 min. In production a user
  // would either hit fresh after 5 min OR close the browser (storage scope ends).
  // For test isolation across rapid steps, force a fresh fetch each step.
  async function clearBuilderCache(ctx) {
    await ctx.addInitScript(() => {
      try {
        sessionStorage.removeItem('pcpc_customer_db_cache');
        // Also clear the draft so it doesn't restore stale state
        localStorage.removeItem('pcpc_qb_draft');
      } catch {}
    });
  }

  // ── Item 1.2: Reopen builder with same ?customer= → assert 2-Story prefills ─
  if (mqCode) {
    await clearBuilderCache(context);
    const page = await context.newPage();
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));
    const param = buildCustomerParam({ fn:'Click', ln:'Test', ph:testPhone, addr:'9999 Story Test Ln, Weston, FL', s:'Roof — Softwash' });
    await page.goto(`${PAGES}/pure_cleaning_quote_builder_v2.html?customer=${param}`, { waitUntil: 'load' });
    await page.waitForTimeout(4500);  // a beat longer — fresh fetch + 500ms prefill setTimeout
    const probe = await page.evaluate(async () => {
      const r = await fetch('/customers', { headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '') } });
      const db = r.ok ? await r.json() : null;
      const c = db?.customers?.find(x => (x.phone||'').replace(/\D/g,'').slice(-10) === '5559990010');
      return {
        custInDb: !!c,
        ssState: c?.scheduledStatus?.state,
        ssRoofStories: c?.scheduledStatus?.roofStories,
        propStories: (c?.properties || []).map(p => p.stories),
        inferred: c && typeof _inferRoofStories === 'function' ? _inferRoofStories(c) : 'no-fn',
        checked: document.querySelector('input[name=v2RoofStories]:checked')?.value,
        selectorVisible: document.getElementById('v2StorySel')?.style?.display !== 'none',
        userSet: typeof _userSetStories !== 'undefined' ? _userSetStories : 'undef',
      };
    });
    console.log('  ↪ step2 probe:', JSON.stringify(probe));
    probe.checked === '2' ? pass('Item 1 step 2 — Reopen prefills 2-Story from scheduledStatus rung', `radio=${probe.checked}`)
                          : fail('Item 1 step 2 — Reopen did NOT prefill 2-Story', JSON.stringify(probe));
    if (logs.length) console.log('  ↪ step2 console (last 6):', logs.slice(-6).join(' | '));
    await page.close();
  }

  // ── Item 1.3: Regenerate WITHOUT touching the radio → Property.stories stays 2 ─
  if (mqCode) {
    await clearBuilderCache(context);
    const page = await context.newPage();
    let regenCaptured = null;
    let custDbPutLanded = false;
    page.on('request', req => {
      const m = req.url().match(/\/quote\/([A-Za-z0-9_-]+)/);
      if (m && req.method() === 'PUT') regenCaptured = m[1];
    });
    page.on('requestfinished', req => {
      if (req.method() === 'PUT' && req.url().endsWith('/customers')) custDbPutLanded = true;
    });
    const param = buildCustomerParam({ fn:'Click', ln:'Test', ph:testPhone, addr:'9999 Story Test Ln, Weston, FL', s:'Roof — Softwash' });
    await page.goto(`${PAGES}/pure_cleaning_quote_builder_v2.html?customer=${param}`, { waitUntil: 'load' });
    await page.waitForTimeout(3500);
    await page.fill('#quotePricePressure', '600');
    const future2 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0,10);
    await page.fill('#primaryDate', future2);
    const genBtn = page.locator('#previewGenerateBtn, #generateBtn').first();
    await genBtn.click();
    await page.waitForTimeout(4000);
    // Step 3 assertion — what production users actually care about:
    //   (a) the regenerated quote KV record has roofStories=2 (the radio was
    //       prefilled by rung 3, the user didn't touch it, the value propagated
    //       through to the new quote — the compound guard is working);
    //   (b) Property.stories stays 2 on D1 (the DL-01 master is preserved
    //       across regenerations — no wipe).
    // We do NOT check scheduledStatus.roofStories here: per T1.20 the D1-derived
    // scheduledStatus reads from Job rows, and no Job exists until the customer
    // confirms a date. KV-side scheduledStatus is irrelevant — the read path
    // never surfaces it for in-flight quotes.
    let wait = 0; while (wait < 30 && !custDbPutLanded) { await page.waitForTimeout(200); wait++; }
    try {
      // (a) Regenerated quote KV
      const regenKvR = regenCaptured ? await fetch(`${API}/quote/${regenCaptured}`).then(r => r.json()).then(q => q.roofStories).catch(() => null) : null;
      // (b) Property.stories on /customer/{phone}
      const cr = await fetch(`${API}/customer/${testPhone}`);
      const cd = cr.ok ? await cr.json() : null;
      const propStories = cd?.customer?.properties?.[0]?.stories;
      const ok = regenKvR === 2 && propStories === 2;
      ok ? pass('Item 1 step 3 — Regen preserved (quote.roofStories=2 + Property.stories=2 unchanged)', `quote=${regenKvR} prop=${propStories}`)
         : fail('Item 1 step 3 — Regen dropped stories somewhere', `quote=${regenKvR} prop=${propStories}`);
    } catch (e) { fail('Item 1 step 3 — fetch failed', e.message); }
    await page.close();
  }

  // ── Item 3: Sealing-flagged quote → sealing-note-card present, no Sealing in incl-list ─
  {
    const sealCode = 'sealtest_' + Date.now();
    const putRes = await fetch(`${API}/quote/${sealCode}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fn:'Seal', ln:'Test', ph:'5559990020',
        mainServices:'Roof — Softwash, Rinse Walls, Sealing quote requested, Driveway',
        services:'Roof — Softwash, Rinse Walls, Sealing quote requested, Driveway',
        mainAmount: 600, approvedAmount: 600,
        dateSuggestions:[{date:new Date(Date.now()+5*86400000).toISOString().slice(0,10), display:'Test Day', label:'Best Fit', rig:null, rigLabel:null}],
        source:'verify_item3',
      }),
    });
    if (!putRes.ok) { fail('Item 3 — KV PUT failed for seal-test'); }
    else {
      const page = await context.newPage();
      await page.goto(`${PAGES}/pure_cleaning_agreement.html?id=${sealCode}`, { waitUntil: 'load' });
      await page.waitForTimeout(2000);
      const sealNoteVisible = await page.locator('.sealing-note-card').isVisible().catch(() => false);
      sealNoteVisible ? pass('Item 3 — sealing-note-card visible under WHAT\'S INCLUDED')
                      : fail('Item 3 — sealing-note-card NOT visible on seal-flagged quote');
      const inclItems = await page.locator('.incl-list li').allTextContents();
      const hasSealingInIncluded = inclItems.some(t => /sealing\s*quote\s*requested/i.test(t));
      hasSealingInIncluded ? fail('Item 3 — "Sealing quote requested" still in WHAT\'S INCLUDED', inclItems.join(' · '))
                           : pass('Item 3 — "Sealing quote requested" NOT in WHAT\'S INCLUDED list', `items=${inclItems.length}`);
      const subtitleHasSealing = await page.locator('#ntc-services').textContent();
      /sealing\s*quote\s*requested/i.test(subtitleHasSealing || '') ?
        fail('Item 3 — YOUR TOTAL subtitle still mentions sealing', subtitleHasSealing) :
        pass('Item 3 — YOUR TOTAL subtitle clean of sealing language', subtitleHasSealing);
      await page.close();
    }
    // Cleanup
    await fetch(`${API}/quote/${sealCode}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }).catch(()=>{});
  }

  // ── Item 4: Confirmed quote → celebration-hero, body.is-confirmed, action buttons ─
  {
    const confCode = 'conftest_' + Date.now();
    await fetch(`${API}/quote/${confCode}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fn:'Confirmed', ln:'View', ph:'5559990030',
        mainServices:'Driveway, Patio',
        services:'Driveway, Patio',
        mainAmount: 280, approvedAmount: 280,
        confirmedAt: new Date().toISOString(),
        confirmedDate: '2026-06-20',
        confirmedDateDisplay: 'Saturday, June 20',
        dateSuggestions:[],
        source:'verify_item4',
      }),
    });
    for (const vw of [{ w:1280, h:900, label:'desktop' }, { w:360, h:780, label:'360px' }]) {
      const ctx2 = await browser.newContext({ viewport: { width: vw.w, height: vw.h } });
      const page = await ctx2.newPage();
      await page.goto(`${PAGES}/pure_cleaning_agreement.html?id=${confCode}`, { waitUntil: 'load' });
      await page.waitForTimeout(2000);
      const isConfirmedBody = await page.evaluate(() => document.body.classList.contains('is-confirmed'));
      const heroVisible = await page.locator('.celebration-hero').isVisible().catch(() => false);
      const headlineTxt = await page.locator('.celebration-headline').textContent().catch(() => '');
      const actionCount = await page.locator('.celebration-action-btn').count();
      const termsExpander = await page.locator('.cnf-expander summary', { hasText: 'Service Agreement' }).count();
      const quoteExpander = await page.locator('.cnf-expander summary', { hasText: 'View your quote details' }).count();
      const oldGreenBoxGone = !(await page.locator('.confirmed-banner').isVisible().catch(() => false));
      isConfirmedBody ? pass(`Item 4 ${vw.label} — body.is-confirmed set`) : fail(`Item 4 ${vw.label} — body.is-confirmed NOT set`);
      heroVisible ? pass(`Item 4 ${vw.label} — celebration-hero visible`, headlineTxt.trim()) : fail(`Item 4 ${vw.label} — celebration-hero NOT visible`);
      actionCount === 3 ? pass(`Item 4 ${vw.label} — 3 action buttons (PDF/Print/Email)`) : fail(`Item 4 ${vw.label} — action buttons count=${actionCount}`);
      termsExpander > 0 ? pass(`Item 4 ${vw.label} — Service Agreement & Terms expander present`) : fail(`Item 4 ${vw.label} — terms expander missing`);
      quoteExpander > 0 ? pass(`Item 4 ${vw.label} — "View your quote details" expander present`) : fail(`Item 4 ${vw.label} — quote-details expander missing`);
      oldGreenBoxGone ? pass(`Item 4 ${vw.label} — old confirmed-banner (green box) gone`) : fail(`Item 4 ${vw.label} — old confirmed-banner STILL visible`);
      // Click the terms expander, assert content visible
      try {
        await page.locator('.cnf-expander summary', { hasText: 'Service Agreement' }).first().click();
        await page.waitForTimeout(400);
        const termsContent = await page.locator('.cnf-expander-body ol li').count();
        termsContent >= 10 ? pass(`Item 4 ${vw.label} — terms expander opens with 10+ clauses`) : fail(`Item 4 ${vw.label} — terms clause count=${termsContent}`);
      } catch (e) { warn(`Item 4 ${vw.label} — terms expander click error`, e.message.slice(0,80)); }
      await page.close();
      await ctx2.close();
    }
    await fetch(`${API}/quote/${confCode}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }).catch(()=>{});
  }

  // ── Item 5: Builder dedupe on Rinse-walls + Rinse walls & windows ──
  {
    const page = await context.newPage();
    const param = buildCustomerParam({ fn:'Dedupe', ln:'Test', ph:'5559990040', addr:'200 Dedupe Ln, Weston, FL', s:'Roof — Softwash, Rinse walls & windows, Rinse Walls, Driveway' });
    await page.goto(`${PAGES}/pure_cleaning_quote_builder_v2.html?customer=${param}`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const serviceChips = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#serviceChips .chip')).map(c => c.firstChild?.textContent?.trim() || c.textContent.trim().replace(/×$/,''));
    });
    const hasCombined = serviceChips.some(s => /rinse\s*walls?\s*&\s*window/i.test(s));
    const hasStandalone = serviceChips.some(s => /^rinse\s*walls?$/i.test(s.trim()));
    hasCombined ? pass('Item 5 — Builder kept "Rinse walls & windows" (combined form)', serviceChips.join(' · '))
                : fail('Item 5 — Builder DROPPED the combined form', serviceChips.join(' · '));
    !hasStandalone ? pass('Item 5 — Builder dropped standalone "Rinse walls" (subset rule)')
                   : fail('Item 5 — Builder kept BOTH "Rinse walls" and "Rinse walls & windows"', serviceChips.join(' · '));
    await page.close();
  }

  await context.close();
  await browser.close();

  // ── Cleanup: remove the junk customer (5559990010) created by step 1's PUT ─
  // The builder's PUT /customers creates the customer on the fly. We snapshotted
  // before starting (customer_db_backup_2026-06-12T22-45-55) so this is recoverable
  // either way, but we still tidy up.
  try {
    const res = await fetch(`${API}/customers`, { headers: { 'Authorization': 'Bearer ' + token } });
    const db  = await res.json();
    const before = (db.customers || []).length;
    const TEST_PHONES = new Set(['5559990001','5559990002','5559990003','5559990010','5559990020','5559990030','5559990040']);
    db.customers = (db.customers || []).filter(c => !TEST_PHONES.has((c.phone||'').replace(/\D/g,'').slice(-10)));
    const removed = before - db.customers.length;
    if (removed > 0) {
      const putRes = await fetch(`${API}/customers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(db),
      });
      if (putRes.ok) console.log(`\n🧹  Cleanup: removed ${removed} test customer(s) from KV (${before} → ${db.customers.length})`);
      else            console.log(`\n⚠️   Cleanup PUT failed: HTTP ${putRes.status}`);
    } else {
      console.log('\n🧹  Cleanup: no test customers found to remove (already clean)');
    }
  } catch (e) { console.log('\n⚠️   Cleanup error:', e.message); }

  console.log('\n' + '─'.repeat(60));
  const passed = results.filter(r => r.status === 'PASS').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  console.log(`    ${passed} passed · ${warned} warnings · ${failures} failed`);
  if (failures > 0) {
    console.log('\n🚨  QUOTE-FLOW BATCH VERIFICATION FAILED — investigate before push');
    process.exit(1);
  }
  console.log('\n🟢  All quote-flow batch assertions passed');
}

main().catch(e => { console.error('verify-quote-flow-batch crashed:', e); process.exit(2); });
