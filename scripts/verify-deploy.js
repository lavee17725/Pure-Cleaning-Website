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
const API_ENDPOINTS = [
  { path: '/incoming',        expectKey: 'requests' },
  { path: '/customers',       expectKey: null },   // returns array or object
  { path: '/admin/reviews-hub', expectKey: null }, // may return empty array
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
async function checkApiEndpoint({ path, expectKey }) {
  const url = `${WORKERS_API}${path}`;
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
      pass(`API ${path} — has key "${expectKey}"`, `${JSON.stringify(data[expectKey]).length} chars`);
    } else {
      fail(`API ${path} — missing key "${expectKey}"`, `Keys: ${Object.keys(data).join(', ')}`);
    }
  } else {
    pass(`API ${path} — reachable`, Array.isArray(data) ? `${data.length} items` : typeof data);
  }
}

// ── CHECK 3: Render simulation for most recent incoming request ───────────
async function checkRenderSimulation() {
  let data;
  try {
    data = await fetchJson(`${WORKERS_API}/incoming`);
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
