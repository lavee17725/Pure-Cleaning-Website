#!/usr/bin/env node
/**
 * Post-deploy verification for purecleaningpressurecleaning.com
 *
 * Checks:
 *   1. GitHub Pages HTML files — freshness, expected code markers, CSS contrast
 *   2. Workers API endpoints — reachable, valid JSON
 *   3. Render simulation — data + code trace for most recent incoming request
 *
 * Run: node scripts/verify-deploy.js
 * Or:  npm run deploy:verify
 */

const GITHUB_PAGES = 'https://purecleaningpressurecleaning.com';
const WORKERS_API  = 'https://purecleaning-api.tylerfumero.workers.dev';

// ── HTML files to verify ───────────────────────────────────────────────────
// Each entry: { file, markers: [strings that MUST appear], cssChecks: [{selector, prop, forbidden}] }
const HTML_FILES = [
  {
    file: 'pure_cleaning_incoming.html',
    markers: [
      'req.customer_name',   // name fallback
      'req.address',         // address rendering
      'address && city',     // address/city ternary
      'function buildCard',
      'PCPC_API',
    ],
    cssChecks: [
      // class, color property pattern, forbidden resolved value (white-on-white check)
      { selector: '.req-name', prop: 'color', forbidden: '#fff' },
    ],
  },
  {
    file: 'pure_cleaning_calendar.html',
    markers: ['function renderDayView', 'PCPC_API', 'function promptRevertJob'],
  },
  {
    file: 'pure_cleaning_customer_directory.html',
    markers: ['function applyAll', 'TIER_RANK', 'function filterByTier'],
  },
  {
    file: 'pure_cleaning_customer_profile.html',
    markers: ['const API', 'function buildTimeline', 'function calcChurnRisk'],
  },
  {
    file: 'pure_cleaning_review_hub.html',
    markers: ['function loadHub', 'function daysBadge', 'CUTOFF'],
  },
  {
    file: 'pure_cleaning_bulk_reactivation.html',
    markers: ['function dbRecordToCustomer', 'effectiveLastService'],
  },
];

// ── API endpoints to verify ────────────────────────────────────────────────
// After admin auth: protected endpoints return 401 without a token.
// We verify auth is enforced (expect 401), and use /health for DB sanity.
const API_ENDPOINTS = [
  { path: '/health',              expectKey: 'customerCount', expectPublic: true },
  { path: '/incoming',            expect401: true },   // protected — no token in verify script
  { path: '/customers',           expect401: true },   // protected
  { path: '/admin/reviews-hub',   expect401: true },   // protected
];

// ── CSS variable resolution ────────────────────────────────────────────────
function resolveCssVar(value, cssVars) {
  const m = value.match(/var\(--([^)]+)\)/);
  if (!m) return value.trim();
  return (cssVars[m[1]] || value).trim();
}

function extractCssVars(html) {
  const vars = {};
  const m = html.match(/:root\{([^}]+)\}/);
  if (!m) return vars;
  for (const pair of m[1].split(';')) {
    const [k, v] = pair.split(':');
    if (k && v) vars[k.trim().replace('--', '')] = v.trim();
  }
  return vars;
}

// ── Fetch helper ──────────────────────────────────────────────────────────
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Result tracking ───────────────────────────────────────────────────────
const results = [];
let failures = 0;

function pass(label, detail = '') {
  results.push({ status: 'PASS', label, detail });
}

function fail(label, detail = '') {
  failures++;
  results.push({ status: 'FAIL', label, detail });
}

function warn(label, detail = '') {
  results.push({ status: 'WARN', label, detail });
}

// ── CHECK 1: HTML files ───────────────────────────────────────────────────
async function checkHtmlFile({ file, markers = [], cssChecks = [] }) {
  const url = `${GITHUB_PAGES}/${file}`;
  let html;
  try {
    html = await fetchText(url);
  } catch (e) {
    fail(`${file} — fetch`, e.message);
    return;
  }

  if (html.length < 1000) {
    fail(`${file} — size`, `Only ${html.length} bytes — likely empty/error page`);
    return;
  }
  pass(`${file} — reachable`, `${Math.round(html.length / 1024)}KB`);

  // Marker checks
  for (const marker of markers) {
    if (html.includes(marker)) {
      pass(`${file} — marker: ${marker}`);
    } else {
      fail(`${file} — marker: ${marker}`, 'NOT FOUND in live HTML');
    }
  }

  // CSS contrast checks
  const cssVars = extractCssVars(html);
  for (const { selector, prop, forbidden } of cssChecks) {
    // Pull the CSS rule for this selector
    const escaped = selector.replace('.', '\\.').replace('-', '\\-');
    const ruleMatch = html.match(new RegExp(selector.replace('.', '\\.') + '\\{([^}]+)\\}'));
    if (!ruleMatch) {
      warn(`${file} — CSS ${selector}`, 'Rule not found');
      continue;
    }
    const rule = ruleMatch[1];
    const propMatch = rule.match(new RegExp(prop + ':([^;]+)'));
    if (!propMatch) {
      warn(`${file} — CSS ${selector} ${prop}`, 'Property not found');
      continue;
    }
    const rawValue = propMatch[1].trim();
    const resolved = resolveCssVar(rawValue, cssVars);
    if (resolved === forbidden) {
      fail(
        `${file} — CSS contrast: ${selector} { ${prop}: ${rawValue} }`,
        `Resolves to ${resolved} — matches forbidden value (white-on-white)`
      );
    } else {
      pass(
        `${file} — CSS contrast: ${selector} { ${prop}: ${rawValue} }`,
        `Resolves to ${resolved} ✓`
      );
    }
  }
}

// ── CHECK 2: API endpoints ────────────────────────────────────────────────
async function checkApiEndpoint({ path, expectKey, expect401, expectPublic }) {
  const url = `${WORKERS_API}${path}`;

  if (expect401) {
    // Verify auth is enforced — no token, expect 401
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      fail(`API ${path} — auth check fetch`, e.message);
      return;
    }
    if (r.status === 401) {
      pass(`API ${path} — auth enforced (401 without token)`);
    } else {
      fail(`API ${path} — auth NOT enforced`, `Got HTTP ${r.status}, expected 401`);
    }
    return;
  }

  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    fail(`API ${path} — fetch`, e.message);
    return;
  }

  if (data === null || data === undefined) {
    fail(`API ${path} — response`, 'null/undefined');
    return;
  }

  if (expectKey && typeof data === 'object' && !Array.isArray(data)) {
    if (expectKey in data) {
      pass(`API ${path} — has key "${expectKey}"`, `value: ${JSON.stringify(data[expectKey])}`);
    } else {
      fail(`API ${path} — missing key "${expectKey}"`, `Keys: ${Object.keys(data).join(', ')}`);
    }
  } else {
    pass(`API ${path} — reachable`, Array.isArray(data) ? `${data.length} items` : typeof data);
  }
}

// ── CHECK 3: Render simulation for most recent incoming request ───────────
// NOTE: After admin auth ships, this check requires a valid session token.
// Until VERIFY_TOKEN env var is set, this check is skipped gracefully.
async function checkRenderSimulation() {
  const verifyToken = process.env.VERIFY_TOKEN;
  let data;
  try {
    const headers = verifyToken ? { 'Authorization': `Bearer ${verifyToken}` } : {};
    const r = await fetch(`${WORKERS_API}/incoming`, { headers });
    if (r.status === 401) {
      warn('Render simulation', 'Skipped — set VERIFY_TOKEN env var for authenticated checks');
      return;
    }
    data = await r.json();
  } catch (e) {
    fail('Render simulation — API fetch', e.message);
    return;
  }

  const reqs = (data.requests || []).sort((a, b) =>
    (b.submittedAt || '').localeCompare(a.submittedAt || '')
  );
  if (!reqs.length) {
    warn('Render simulation', 'No incoming requests to simulate');
    return;
  }

  const r = reqs[0];
  const d = r.customerData || {};

  const name = ((d.firstName || '') + ' ' + (d.lastName || '')).trim() || r.customer_name || '';
  const address = d.address || r.address || '';
  const city = d.city || r.city || '';
  const addressLine = address && city ? `${address}, ${city}` : city;
  const phone = d.phone || r.phone || '';

  const submitted = new Date(r.submittedAt);
  const ageHours = ((Date.now() - submitted) / 3600000).toFixed(1);

  if (name) {
    pass('Render sim — name', `"${name}" (submitted ${ageHours}h ago)`);
  } else {
    fail('Render sim — name', `Empty — customerData: ${JSON.stringify({ fn: d.firstName, ln: d.lastName })}, customer_name: ${r.customer_name}`);
  }

  if (addressLine) {
    pass('Render sim — address', `"${addressLine}"`);
  } else {
    fail('Render sim — address', `Empty — d.address: ${d.address}, d.city: ${d.city}`);
  }

  if (phone) {
    pass('Render sim — phone', phone);
  } else {
    warn('Render sim — phone', 'No phone on record');
  }
}

// ── CHECK 4: DB sanity via public /health endpoint ────────────────────────
async function checkDbSanity() {
  let data;
  try {
    data = await fetchJson(`${WORKERS_API}/health`);
  } catch (e) {
    fail('DB sanity — health fetch', e.message);
    return;
  }

  const count = data.customerCount ?? 0;
  if (count < 1000) {
    fail('DB sanity — customer count', `Only ${count} customers via /health — expected 1,000+`);
  } else {
    pass('DB sanity — customer count', `${count.toLocaleString()} customers (from /health)`);
  }

  // Duplicate phone check requires auth — skip gracefully
  const verifyToken = process.env.VERIFY_TOKEN;
  if (!verifyToken) {
    warn('DB sanity — duplicate phones', 'Set VERIFY_TOKEN to enable authenticated DB checks');
    return;
  }
  const r2 = await fetch(`${WORKERS_API}/customers`, { headers: { 'Authorization': `Bearer ${verifyToken}` } });
  if (!r2.ok) { warn('DB sanity — customers fetch', `HTTP ${r2.status}`); return; }
  const custs = (await r2.json()).customers || [];
  const seen = new Set();
  let dupes = 0;
  for (const c of custs) {
    const ph = (c.phone || '').replace(/\D/g, '');
    if (!ph || /^REFERRAL_/.test(c.phone || '')) continue;
    if (seen.has(ph)) dupes++;
    else seen.add(ph);
  }
  if (dupes > 0) warn('DB sanity — duplicate phones', `${dupes} duplicate phone(s) — run npm run integrity for details`);
  else pass('DB sanity — duplicate phones', 'none');
}

// ── CHECK 6: Mobile compatibility ─────────────────────────────────────────
const MOBILE_UAS = [
  {
    name: 'iPhone Safari',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  {
    name: 'Android Chrome',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
];

async function checkOneMobileFile(file) {
  const url = `${GITHUB_PAGES}/${file}`;

  // Fetch once with desktop UA — reuse content for all checks
  let html = '';
  try {
    const r = await fetch(url);
    if (!r.ok) { fail(`${file} — mobile/desktop fetch`, `HTTP ${r.status}`); return; }
    html = await r.text();
  } catch (e) {
    fail(`${file} — mobile/desktop fetch`, e.message);
    return;
  }

  // 1. Viewport meta — FAIL if missing (page zooms out to desktop width on mobile)
  if (!/meta[^>]+name=["']viewport["'][^>]*>/i.test(html) && !/meta[^>]+content=["'][^"']*width=device-width/i.test(html)) {
    fail(`${file} — viewport meta`, 'MISSING — page will render as zoomed-out desktop on mobile');
  } else {
    pass(`${file} — viewport meta`);
  }

  // 2. UA availability — confirm CDN serves same content to mobile UAs (status + content-type)
  for (const { name, ua } of MOBILE_UAS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua } });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        fail(`${file} — ${name}`, `HTTP ${r.status}`);
      } else if (!ct.includes('text/html')) {
        warn(`${file} — ${name}`, `Unexpected content-type: ${ct}`);
      } else {
        pass(`${file} — ${name}`, `HTTP ${r.status} text/html`);
      }
      await r.body?.cancel().catch(() => {});
    } catch (e) {
      fail(`${file} — ${name} fetch`, e.message);
    }
  }

  // CSS analysis — extract inline <style> blocks
  const styleContent = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n');

  // 3. Fixed widths > 400px without a max-width companion (warn — may cause horizontal scroll)
  const wideRules = [];
  const widthRe = /(\.[a-zA-Z][^{]*)\{[^}]*\bwidth\s*:\s*(\d+)px\b[^}]*\}/g;
  let m;
  while ((m = widthRe.exec(styleContent)) !== null) {
    const px = parseInt(m[2]);
    if (px > 400 && !m[0].includes('max-width')) wideRules.push(`${m[1].trim()}: ${px}px`);
  }
  if (wideRules.length > 0) {
    warn(`${file} — fixed wide elements`, `${wideRules.length} class(es) with width >${400}px and no max-width: ${wideRules.slice(0, 3).join('; ')}`);
  }

  // 4. Tap target size — button/input height < 36px
  const smallTargets = [];
  const tapRe = /(?:\.btn|button|input|\.tab)[^{]*\{([^}]*)\}/gi;
  while ((m = tapRe.exec(styleContent)) !== null) {
    const block = m[1];
    const hMatch = block.match(/\bheight\s*:\s*(\d+(?:\.\d+)?)(px|rem)/);
    if (hMatch) {
      const px = hMatch[2] === 'rem' ? parseFloat(hMatch[1]) * 16 : parseFloat(hMatch[1]);
      if (px < 36) smallTargets.push(`${Math.round(px)}px`);
    }
  }
  if (smallTargets.length > 0) {
    warn(`${file} — tap targets`, `${smallTargets.length} element(s) with height < 36px: ${[...new Set(smallTargets)].join(', ')} (Apple HIG recommends 44px min)`);
  }

  // 5. position: fixed without max-width (can break layout on narrow screens)
  const fixedNoMax = [];
  const fixedRe = /(\.[a-zA-Z][^{]*)\{([^}]*position\s*:\s*fixed[^}]*)\}/gi;
  while ((m = fixedRe.exec(styleContent)) !== null) {
    if (!m[2].includes('max-width') && !m[0].includes('max-width')) {
      fixedNoMax.push(m[1].trim().split(/[,\s]/)[0]);
    }
  }
  if (fixedNoMax.length > 0) {
    warn(`${file} — fixed positioning`, `${fixedNoMax.length} class(es) use position:fixed without max-width: ${fixedNoMax.slice(0, 3).join(', ')}`);
  }
}

async function checkMobileCompatibility() {
  await Promise.all(HTML_FILES.map(({ file }) => checkOneMobileFile(file)));
}

// ── CHECK 5: Cron heartbeat ───────────────────────────────────────────────
async function checkCronHeartbeat() {
  let hb;
  try {
    hb = await fetchJson(`${WORKERS_API}/admin/cron-heartbeat`);
  } catch (e) {
    fail('Cron heartbeat — fetch', e.message);
    return;
  }

  if (!hb || hb.status === 'never_run') {
    warn('Cron heartbeat', 'No heartbeat on record — cron has not run yet (expected after first 3 AM ET)');
    return;
  }

  const ranAt = new Date(hb.ranAt);
  const ageHours = (Date.now() - ranAt) / 3600000;
  const ageLabel = ageHours < 1 ? `${Math.round(ageHours * 60)}m ago` : `${ageHours.toFixed(1)}h ago`;

  if (ageHours > 26) {
    fail('Cron heartbeat — staleness', `Last run ${ageLabel} — expected within 26h. Cron may be silently failing.`);
  } else if (hb.status === 'error') {
    warn(
      'Cron heartbeat — status',
      `Ran ${ageLabel} with status:error — errors: ${(hb.errors || []).join('; ') || 'none recorded'}`
    );
  } else {
    pass(
      'Cron heartbeat',
      `${ageLabel} · ${hb.jobsMatched}/${hb.jobsTotal ?? '?'} matched · ${hb.durationMs}ms · status:${hb.status}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔍  Pure Cleaning — Deploy Verification');
  console.log(`    GitHub Pages: ${GITHUB_PAGES}`);
  console.log(`    Workers API:  ${WORKERS_API}`);
  console.log('─'.repeat(60));

  // Run all checks
  await Promise.all(HTML_FILES.map(checkHtmlFile));
  await Promise.all(API_ENDPOINTS.map(checkApiEndpoint));
  await checkRenderSimulation();
  await checkDbSanity();
  await checkCronHeartbeat();
  await checkMobileCompatibility();

  // Print results
  console.log('');
  const width = Math.max(...results.map(r => r.label.length), 40);
  for (const { status, label, detail } of results) {
    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ ';
    const detailStr = detail ? `  ${detail}` : '';
    console.log(`${icon}  ${label}${detailStr}`);
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  console.log('\n' + '─'.repeat(60));
  console.log(`    ${passed} passed · ${warned} warnings · ${failures} failed`);

  if (failures > 0) {
    console.log('\n🚨  DEPLOY VERIFICATION FAILED — do not ship');
    process.exit(1);
  } else {
    console.log('\n🟢  All checks passed');
  }
}

main().catch(e => {
  console.error('verify-deploy crashed:', e);
  process.exit(1);
});
