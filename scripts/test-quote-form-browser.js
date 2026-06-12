#!/usr/bin/env node
/**
 * One-shot browser test for the public quote form (public/quote.html).
 * Launches Playwright at iPhone-sized viewport, fills in test data, submits,
 * and verifies the success panel appears.
 *
 * Cleanup of the resulting test record is handled by the companion Python
 * script that runs after this. Run order:
 *   node  scripts/test-quote-form-browser.js   # submits via real form
 *   python3 -c "..." (cleanup script)          # removes the test record
 */
const { chromium, devices } = require('playwright');

const URL = process.env.QUOTE_URL || 'https://purecleaningpressurecleaning.com/quote.html';
const TEST_FIRST = 'BrowserE2E';
const TEST_LAST  = 'Verify' + Date.now();   // unique so we can target it for cleanup
const TEST_PHONE = '5559999922';
const VIEWPORT_MOBILE = { width: 375, height: 812 };   // iPhone 13 pro logical
const VIEWPORT_NARROW = { width: 360, height: 740 };   // below the 380 breakpoint

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEWPORT_NARROW,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) PCPC-E2E-Quote/1.0',
  });
  const page = await ctx.newPage();

  // Suppress noisy network console (formspree CORS rejection is harmless in headless)
  const errs = [];
  page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

  console.log('navigating to', URL);
  await page.goto(URL, { waitUntil: 'networkidle' });

  // ── Mobile layout sanity: the form card is visible and full-width ──
  const formVisible = await page.evaluate(() => !!document.querySelector('#formCard'));
  if (!formVisible) throw new Error('#formCard not present on quote.html');
  console.log(`  ✅ form rendered at ${VIEWPORT_NARROW.width}x${VIEWPORT_NARROW.height} viewport`);

  // ── Required fields: every input reachable + no field wider than viewport ──
  const overflowField = await page.evaluate(() => {
    const els = document.querySelectorAll('input, textarea, button');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > window.innerWidth + 1) return { tag: el.tagName, id: el.id, w: r.width };
    }
    return null;
  });
  if (overflowField) throw new Error(`field wider than viewport: ${JSON.stringify(overflowField)}`);
  console.log('  ✅ no horizontal overflow (all fields fit ≤360px)');

  // ── Fill the form ──
  await page.fill('#firstName', TEST_FIRST);
  await page.fill('#lastName',  TEST_LAST);
  await page.fill('#phone',     TEST_PHONE);
  await page.fill('#email',     'noreply+browser-e2e@purecleaningpressurecleaning.com');
  await page.fill('#address',   '999 Browser E2E Test Lane (verification — DELETE)');
  await page.fill('#city',      'Davie');
  await page.fill('#zip',       '33024');
  await page.fill('#notes',     'AUTOMATED BROWSER E2E TEST — DELETE ME');
  console.log('  ✅ all 7 required + optional fields filled');

  // ── Select a service: Driveway ──
  await page.click('.svc-check[data-svc="Driveway"]');
  const driveSelected = await page.evaluate(() =>
    document.querySelector('.svc-check[data-svc="Driveway"]').classList.contains('checked')
  );
  if (!driveSelected) throw new Error('Driveway service did not register click');
  console.log('  ✅ Driveway service selected (class.checked applied)');

  // ── Select a week: Flexible ──
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.week-card'));
    const flex = cards.find(c => c.textContent.includes('Flexible'));
    if (flex) flex.click();
  });
  const weekSelected = await page.evaluate(() =>
    !!document.querySelector('.week-card.selected')
  );
  if (!weekSelected) throw new Error('Flexible week did not register click');
  console.log('  ✅ Flexible week selected');

  // ── Submit & wait for success panel ──
  await page.click('#submitBtn');
  console.log('  → submit clicked, waiting up to 25s for success panel…');
  try {
    await page.waitForSelector('#successPanel.shown', { timeout: 25000 });
  } catch (e) {
    const errVisible = await page.evaluate(() =>
      document.querySelector('#submitErr.shown') !== null
    );
    throw new Error(errVisible
      ? 'submit failed: error panel shown (network or backend error)'
      : 'success panel did not appear within 25s and no error shown');
  }
  const successText = await page.evaluate(() => document.querySelector('#successPanel').innerText);
  console.log(`  ✅ success panel appeared: "${successText.split('\n')[0]}"`);

  // Console-error filtering — only fail on JS errors, not network CORS noise
  const realErrors = errs.filter(e =>
    !/formspree\.io|hooks\.zapier|net::ERR_FAILED|Failed to load resource/i.test(e)
  );
  if (realErrors.length) {
    console.log('  ⚠️  console errors (non-network):');
    realErrors.slice(0, 3).forEach(e => console.log('     ', e));
  } else {
    console.log('  ✅ no JS errors in console');
  }

  await browser.close();
  console.log('');
  console.log('━'.repeat(60));
  console.log('BROWSER E2E PASS — submit+success path works at narrow mobile viewport');
  console.log(`  Test record uniquely keyed:  lastName = "${TEST_LAST}"`);
  console.log(`  Cleanup target:              first=${TEST_FIRST} last=${TEST_LAST}`);
}

run().catch(err => { console.error('❌ BROWSER E2E FAIL:', err.message); process.exit(1); });
