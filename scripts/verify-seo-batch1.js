#!/usr/bin/env node
/**
 * One-shot post-deploy verifier for SEO Phase 2 Batch 1.
 * Runs Playwright against the 3 new live pages at desktop + 360px:
 *   - hero renders (h1 visible)
 *   - every big-cta href is /quote.html and visible
 *   - before/after sliders respond to pointermove (Weston, Paver Sealing)
 *   - FAQ <details> expanders open (Weston, Paver Sealing)
 *   - footer internal links resolve to local paths
 * Run: node scripts/verify-seo-batch1.js
 */
const { chromium } = require('playwright');

const BASE = 'https://purecleaningpressurecleaning.com';
const PAGES = [
  { url: '/pressure-cleaning-weston.html', expectBA: true, expectFAQ: true },
  { url: '/paver-sealing.html',            expectBA: true, expectFAQ: true },
  { url: '/about.html',                    expectBA: false, expectFAQ: false },
];
const VIEWPORTS = [
  { w: 1280, h: 900,  label: 'desktop' },
  { w: 360,  h: 780,  label: '360px'  },
];

const results = [];
let failures = 0;
const pass = (l) => { console.log(`✅  ${l}`); results.push({s:'P',l}); };
const fail = (l, d='') => { console.log(`❌  ${l} ${d}`); results.push({s:'F',l,d}); failures++; };

async function main() {
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      for (const p of PAGES) {
        const page = await ctx.newPage();
        try {
          await page.goto(BASE + p.url, { waitUntil: 'load', timeout: 30000 });
          await page.waitForTimeout(600);

          const h1Visible = await page.locator('h1').first().isVisible().catch(() => false);
          h1Visible ? pass(`${vp.label} ${p.url} — H1 visible`) : fail(`${vp.label} ${p.url} — H1 not visible`);

          // Every big-cta href is /quote.html and visible
          const ctas = await page.locator('a.big-cta').all();
          if (ctas.length === 0) fail(`${vp.label} ${p.url} — no .big-cta found`);
          for (let i = 0; i < ctas.length; i++) {
            const href = await ctas[i].getAttribute('href');
            const visible = await ctas[i].isVisible();
            if (href === '/quote.html' && visible) {
              // ok
            } else {
              fail(`${vp.label} ${p.url} — big-cta[${i}] href=${href} visible=${visible}`);
            }
          }
          if (ctas.length > 0) pass(`${vp.label} ${p.url} — ${ctas.length} big-cta(s) → /quote.html (all visible)`);

          // Before/after sliders — verify structure + that the move() listener
          // is wired. We synthesise a real PointerEvent in-page (Playwright's
          // mouse.move can be flaky against pointermove handlers in headless).
          if (p.expectBA) {
            const sliderCount = await page.locator('.ba-slider').count();
            if (sliderCount === 0) fail(`${vp.label} ${p.url} — expected B/A sliders, found 0`);
            else {
              const probe = await page.evaluate(() => {
                const s = document.querySelector('.ba-slider');
                if (!s) return { ok: false, reason: 'no .ba-slider' };
                const hasBefore = !!s.querySelector('img.img-before');
                const hasAfter  = !!s.querySelector('img.img-after');
                const hasHandle = !!s.querySelector('.handle');
                if (!(hasBefore && hasAfter && hasHandle)) return { ok: false, reason: 'missing img/handle' };
                const r = s.getBoundingClientRect();
                const ev = new PointerEvent('pointermove', {
                  clientX: r.left + r.width * 0.75,
                  clientY: r.top  + r.height * 0.5,
                  bubbles: true, cancelable: true, pointerType: 'mouse',
                });
                s.dispatchEvent(ev);
                const pos = s.style.getPropertyValue('--pos');
                return { ok: true, pos };
              });
              if (probe.ok && probe.pos && probe.pos !== '50%') pass(`${vp.label} ${p.url} — B/A slider wired + responds to pointermove (pos=${probe.pos}, ${sliderCount} sliders)`);
              else fail(`${vp.label} ${p.url} — B/A slider probe: ${JSON.stringify(probe)}`);
            }
          }

          // FAQ details expanders open on click
          if (p.expectFAQ) {
            const detailsCount = await page.locator('.faq details').count();
            if (detailsCount === 0) fail(`${vp.label} ${p.url} — expected FAQ details, found 0`);
            else {
              // Find a closed one (skip the open-by-default first item)
              const closedSummary = page.locator('.faq details:not([open]) summary').first();
              const closedCount = await page.locator('.faq details:not([open])').count();
              if (closedCount === 0) {
                pass(`${vp.label} ${p.url} — FAQ has ${detailsCount} details (all open by default — ok)`);
              } else {
                await closedSummary.click();
                await page.waitForTimeout(150);
                const nowOpen = await page.locator('.faq details[open]').count();
                if (nowOpen >= 1) pass(`${vp.label} ${p.url} — FAQ details expander opens on click (${detailsCount} total)`);
                else fail(`${vp.label} ${p.url} — FAQ details did not open on click`);
              }
            }
          }

          // Footer internal links resolve (have local /paths)
          const footerLinks = await page.locator('footer a[href^="/"]').all();
          if (footerLinks.length === 0) fail(`${vp.label} ${p.url} — no footer internal links`);
          else {
            const hrefs = new Set();
            for (const fl of footerLinks) {
              const h = await fl.getAttribute('href');
              if (h) hrefs.add(h);
            }
            const required = ['/about.html', '/paver-sealing.html', '/pressure-cleaning-weston.html', '/quote.html'];
            const missing = required.filter(r => !hrefs.has(r));
            if (missing.length === 0) pass(`${vp.label} ${p.url} — footer carries all 4 required internal links`);
            else fail(`${vp.label} ${p.url} — footer missing links: ${missing.join(', ')}`);
          }
        } catch (e) {
          fail(`${vp.label} ${p.url} — page error`, e.message.slice(0,80));
        } finally {
          await page.close();
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  console.log('\n' + '─'.repeat(60));
  const passed = results.filter(r => r.s === 'P').length;
  console.log(`    ${passed} passed · ${failures} failed`);
  if (failures > 0) { console.log('\n🚨  SEO Batch 1 verification failed'); process.exit(1); }
  console.log('\n🟢  All SEO Batch 1 assertions passed');
}

main().catch(e => { console.error('verify-seo-batch1 crashed:', e); process.exit(2); });
