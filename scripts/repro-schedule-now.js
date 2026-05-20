/**
 * Reproduction script: "Schedule it now" flow — does it redirect + what DB state lands?
 * Usage: node scripts/repro-schedule-now.js
 * Cleans up after itself (removes 5555550001 from DB).
 */
'use strict';

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE  = 'https://purecleaningpressurecleaning.com';
const PHONE = '5555550002';

// ── Auth ────────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '../.env.local');
const ADMIN_PW = fs.readFileSync(envPath, 'utf8').match(/ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!ADMIN_PW) { console.error('No ADMIN_PASSWORD in .env.local'); process.exit(1); }

async function apiCall(token, method, path2, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Origin': BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path2}`, opts);
  return r.json();
}

async function getToken() {
  const d = await apiCall(null, 'POST', '/auth/login', { password: ADMIN_PW });
  return d.token;
}

// ── One week from today (YYYY-MM-DD) ────────────────────────────────────────
const targetDate = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
})();

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const token = await getToken();
  console.log(`\nToken:       ${token.slice(0, 8)}...`);
  console.log(`Target date: ${targetDate}`);

  // ── Step 1: take snapshot ──────────────────────────────────────────────────
  const snap = await apiCall(token, 'POST', '/import/snapshot', {});
  console.log(`\nSnapshot:    ${snap.key || 'ERROR'} (${snap.customerCount} customers)`);

  // ── Step 2: browser flow ───────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  // Inject auth into localStorage before any page script runs
  const expiresAt = Date.now() + 86400 * 1000;
  await context.addInitScript(({ tok, exp }) => {
    localStorage.setItem('admin_token', tok);
    localStorage.setItem('admin_token_expires', String(exp));
    // Patch fetch to forward auth header (mirrors the auth gate IIFE)
    const _f = window.fetch;
    window.fetch = function(u, o) {
      o = Object.assign({}, o || {});
      o.headers = Object.assign({ Authorization: 'Bearer ' + tok }, o.headers || {});
      return _f.call(this, u, o);
    };
  }, { tok: token, exp: expiresAt });

  const page = await context.newPage();

  let finalUrl = null;
  let redirected = false;

  // Step 2a: Load new_customer.html
  console.log('\n── Browser flow ──');
  await page.goto(`${BASE}/pure_cleaning_new_customer.html`, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('  [1] Loaded new_customer.html');

  // Step 2b: Fill required fields
  await page.fill('#nFn', 'ScheduleTest');
  await page.fill('#nLn', 'Repro');
  await page.fill('#nAddr', '100 Test Ave');
  await page.fill('#nCity', 'Hollywood');
  // Phone — type raw digits; the input handler formats it
  await page.fill('#nPhone', PHONE);
  await page.dispatchEvent('#nPhone', 'input');

  // Lead source
  await page.selectOption('#nLeadSource', 'didnt_ask');
  await page.dispatchEvent('#nLeadSource', 'change');

  // Service: click Patio row (ground service, no extra subfields required)
  const firstSvc = page.locator('.svc-row').filter({ hasText: 'Patio' }).first();
  await firstSvc.click();
  await page.waitForTimeout(300);
  console.log('  [2] Form filled — name, phone, address, city, lead source, service');

  // Step 2c: Save Customer
  const submitBtn = page.locator('#submitBtn');
  await submitBtn.waitFor({ state: 'enabled', timeout: 5000 }).catch(() => {
    console.log('  [!] submitBtn still disabled — dumping missing fields via checkReq');
  });
  const isEnabled = await submitBtn.isEnabled();
  console.log(`  [3] Save Customer button enabled: ${isEnabled}`);
  if (!isEnabled) {
    const missing = await page.evaluate(() => {
      const el = document.getElementById('reqSummary');
      return el ? el.textContent : 'reqSummary not found';
    });
    console.log(`      Missing: ${missing}`);
    await browser.close();
    process.exit(1);
  }

  await page.click('#submitBtn');
  console.log('  [4] Clicked Save Customer');

  // Wait for any visible modal (whatNext OR matchBanner OR dupCallout OR error)
  await page.waitForTimeout(12000);
  const pageState = await page.evaluate(() => ({
    whatNextVisible:    !document.getElementById('whatNextModal')?.classList.contains('hidden'),
    matchBannerVisible: !document.getElementById('matchBanner')?.classList.contains('hidden'),
    dupCalloutVisible:  !document.getElementById('dupCallout')?.classList.contains('hidden'),
    overlayVisible:     !!document.querySelector('.moverlay:not(.hidden)'),
    toastText:          document.getElementById('toastMsg')?.textContent || '',
    reqSummary:         document.getElementById('reqSummary')?.textContent || '',
  }));
  console.log('  [4b] Page state after save click:', JSON.stringify(pageState));
  await page.screenshot({ path: 'verify-screenshots/repro-after-save.png', fullPage: false });

  if (!pageState.whatNextVisible) {
    console.log('  ❌  whatNextModal did not appear — see verify-screenshots/repro-after-save.png');
    await browser.close();
    process.exit(1);
  }
  console.log('  [5] "Customer saved!" modal visible');

  // Step 2e: Click Schedule it now
  await page.click('button[onclick="openScheduleModal()"]');
  await page.waitForSelector('#schedDateModal:not(.hidden)', { timeout: 5000 });
  console.log('  [6] Schedule date modal visible');

  // Step 2f: Set date, leave notes empty, leave price absent
  await page.fill('#schedDate', targetDate);
  console.log(`  [7] Date set to ${targetDate}`);

  // Step 2g: Click Schedule it — watch for redirect
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      finalUrl = frame.url();
      redirected = true;
    }
  });
  await page.click('button[onclick="submitScheduleNow()"]');
  console.log('  [8] Clicked "📅 Schedule it"');

  // Wait up to 10s for redirect or error
  await page.waitForTimeout(6000);

  const currentUrl = page.url();
  const schedError = await page.$eval('#schedError', el => el.textContent || '').catch(() => '');
  console.log(`  [9] Current URL: ${currentUrl}`);
  if (schedError) console.log(`  [!] schedError visible: "${schedError}"`);

  await browser.close();

  // ── Step 3: fetch DB state for test customer ─────────────────────────────
  console.log('\n── DB state after schedule ──');
  await new Promise(r => setTimeout(r, 1500)); // let worker settle
  const db = await apiCall(token, 'GET', '/customers', null);
  const cust = (db.customers || []).find(c => c.phone === PHONE);

  if (!cust) {
    console.log('  ❌  Customer 5555550001 NOT found in DB');
  } else {
    const ss = cust.scheduledStatus || {};
    console.log(`  scheduledStatus.state:          ${ss.state ?? 'undefined'}`);
    console.log(`  scheduledStatus.scheduledDate:  ${ss.scheduledDate ?? 'undefined'}`);
    console.log(`  scheduledStatus.approvedAmount: ${ss.approvedAmount ?? 'undefined'}`);
    console.log(`  quoteLifecycle:                 ${cust.quoteLifecycle ?? 'undefined'}`);
  }

  // ── Step 4: calendar presence check ─────────────────────────────────────
  console.log('\n── Calendar presence ──');
  const calUrl = `${BASE}/pure_cleaning_calendar.html?date=${encodeURIComponent(targetDate)}`;
  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext();
  await ctx2.addInitScript(({ tok, exp }) => {
    localStorage.setItem('admin_token', tok);
    localStorage.setItem('admin_token_expires', String(exp));
    const _f = window.fetch;
    window.fetch = function(u, o) {
      o = Object.assign({}, o || {});
      o.headers = Object.assign({ Authorization: 'Bearer ' + tok }, o.headers || {});
      return _f.call(this, u, o);
    };
  }, { tok: token, exp: expiresAt });

  const calPage = await ctx2.newPage();
  try {
    await calPage.goto(calUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await calPage.waitForTimeout(3000);
    // Look for the test customer's name in a job card
    const cardText = await calPage.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.job-card, .job-scheduled, .rig-lane, .cal-grid'));
      return cards.map(c => c.innerText || c.textContent || '').join('\n');
    });
    const found = cardText.includes('ScheduleTest') || cardText.includes('Repro');
    console.log(`  Customer appears on calendar (${targetDate}): ${found ? '✅  YES' : '❌  NO'}`);
    if (found) {
      // Check for amount badge
      const hasBadge = cardText.match(/\$\d+/);
      console.log(`  Amount badge visible: ${hasBadge ? `✅  YES (${hasBadge[0]})` : '❌  NO ($0 or blank)'}`);
    }
  } catch (e) {
    console.log(`  Calendar load timed out (${e.message.slice(0, 60)})`);
  }
  await browser2.close();

  // ── Step 5: pre-schedule queue check ────────────────────────────────────
  console.log('\n── Pre-schedule queue ──');
  const needsSched = (db.customers || []).filter(c => {
    const s = c.scheduledStatus?.state;
    return s === 'needs_scheduling' || (s === 'scheduled' && !c.scheduledStatus?.rig);
  });
  const inQueue = needsSched.find(c => c.phone === PHONE);
  console.log(`  Test customer in needs-scheduling queue: ${inQueue ? '❌  YES (bug — should be on calendar)' : '✅  NO'}`);

  // ── Step 6: cleanup ──────────────────────────────────────────────────────
  console.log('\n── Cleanup ──');
  if (cust) {
    const cleaned = { customers: (db.customers || []).filter(c => c.phone !== PHONE) };
    const put = await apiCall(token, 'PUT', '/customers', cleaned);
    console.log(`  Removed 5555550001 — PUT result: ${put.success ? '✅  OK' : '❌  FAILED'}`);
    console.log(`  DB count: ${cleaned.customers.length}`);
  } else {
    console.log('  No test customer to remove.');
  }

  console.log('\nDone.\n');
})().catch(e => { console.error(e); process.exit(1); });
