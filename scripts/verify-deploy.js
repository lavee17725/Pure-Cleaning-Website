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

const { getVerifyToken } = require('./lib/auto-auth');

// Token is fetched once at startup and reused across all authenticated checks.
// null = no credentials configured → authenticated checks warn+skip gracefully.
let _cachedAuth = null; // { token, expiresAt } | null
async function getToken() {
  if (_cachedAuth) return _cachedAuth.token;
  _cachedAuth = await getVerifyToken().catch(e => { throw e; }); // propagate auth errors
  return _cachedAuth ? _cachedAuth.token : null;
}

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
      'submitConfirmSchedule',  // Regression: Confirm & Schedule still works for queued entries
      'quoteLifecycle',         // Regression: lifecycle tracking still present
    ],
    cssChecks: [
      // class, color property pattern, forbidden resolved value (white-on-white check)
      { selector: '.req-name', prop: 'color', forbidden: '#fff' },
    ],
  },
  {
    file: 'pure_cleaning_calendar.html',
    markers: [
      'function renderDayView', 'PCPC_API', 'function promptRevertJob',
      '_weekNavDrag',                                     // Regression: drag-to-navigate handler
      'job-scheduled,.win-lane-hdr,.rig-hdr,button',      // Regression: .day-hdr NOT in exclusion (drag from header works)
      'suppressClick',                                    // Regression: click suppressor after week nav
      '_isDuplicate',                                      // Regression: source-agnostic idempotency guard present
      'dayAge < 60',                                      // Regression: recent csv_backfill guard for Tanner-class bug
      'js-eta-btn',                                       // Regression: inline ETA button on each job card
      'getCardEtaSlot',                                   // Regression: ETA slot derived from _estTimeMap or ss.window
      'rig-empty-label',                                  // Regression: always-visible empty swimlane placeholder
      'openRigPickModal',                                 // Regression: click-to-assign rig picker
      'categorizeService(_autoSvc)',                      // Regression: auto-assign Chevy on new roof/softwash jobs
      'wasDragging = false',                              // Regression: initSortables resets wasDragging to fix SortableJS interference
      'openDayRouteView',                                 // Regression: Day Route button in topbar
      'story-badge',                                      // Regression: roof story badge in job cards
      'friendlyServiceDesc',                              // Regression: ETA text uses natural-language service description
      'tomorrow around',                                  // Regression: ETA message hardcoded "tomorrow" for night-before send
      "'morning'",                                        // Regression: slot key 'morning' (not '~9-10am')
      'tapSchedStorySel',                                 // Regression: story selector in tap-schedule modal
      'checkUnschRoof',                                   // Regression: story selector in add-unscheduled modal
      'fullEditModal',                                    // Regression: full edit modal present
      'saveFullEdit',                                     // Regression: full edit save function
      'fePhone',                                          // Regression: phone field in full edit modal
      'DAY_DRAG_PX',                                      // Regression: day-by-day drag constant
    ],
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
    file: 'pure_cleaning_worker_hours.html',
    markers: ['admin/worker-hours', 'worker-card', 'detailTable', 'fromDate'],
  },
  {
    file: 'pure_cleaning_day_route.html',
    markers: ['admin/day-route', 'renderRigColumn', 'col_rig_1',
              'tab-week', 'tab-avg', 'loadWeek', 'loadAverages', 'renderWeekCell', 'renderAveragesCards',
              'roofStories', 'storyBadge'],
  },
  {
    file: 'pure_cleaning_review_hub.html',
    markers: ['function loadHub', 'function daysBadge', 'CUTOFF'],
    cssChecks: [
      { selector: '.card-name', prop: 'color', forbidden: '#fff' },
    ],
  },
  {
    file: 'pure_cleaning_bulk_reactivation.html',
    markers: [
      'function dbRecordToCustomer',
      'effectiveLastService',
      // Law 8 guard: const tc must exist in renderTable .map() callback.
      // If dropped again, ${tc} causes ReferenceError → silent empty list.
      'const tc         = tierClass(c.tier)',
      // Law 9 guards: page-init catch blocks must forward to error tracker.
      '_fwdError(\'bulk_reactivation_init\'',
      '_fwdError(\'bulk_reactivation_renderTable\'',
      // Regression: Both Due tab visible on DB-load (not just CSV-load path)
      'svcTabs',                               // tab HTML must be present
      'svcTabs\').classList.add(\'show\')',     // must be shown in DB-load path
      // Regression: svc section tabs rendered
      'svcTabBoth',
      'svcTabGround',
      'svcTabRoof',
      // Regression: monthsSince sort defaults descending (not ascending)
      'monthsSince:false,',
      // Regression: getMonths() helper for section-aware sort
      'getVal(a, col)',
      // Regression: categorizeService shared function (Law 11)
      'function categorizeService',
      // Regression: eligibility uses date-object null check, not monthsSince !== null
      'lastGroundDateObj !== null',
      'lastRoofDateObj   !== null',
      // Verbal quote lifecycle: DNS tab + sendDnsText + chip CSS + customerToDbRecord preserves new fields
      'setPoolTab(\'dns\')',
      'function sendDnsText',
      'dns-chip-followup',
      'quoteLifecycle: c.quoteLifecycle',
      'quoteHistory:   c.quoteHistory',
    ],
  },
  {
    file: 'pure_cleaning_new_customer.html',
    markers: [
      'buildLeadSource',       // lead source capture on form submit
      'nLeadSource',           // lead source dropdown element
      'didnt_ask',             // Regression: "Didn't ask" option present
      'whatNextModal',         // Regression: 3-option post-save modal present
      'addToQueue',            // Regression: Incoming Queue option present
      'submitScheduleNow',     // Regression: Schedule it now option present
      'openScheduleModal',     // Regression: date picker for Option A
    ],
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

// Deep var() resolution with cycle protection.
function resolveCssVar(value, cssVars) {
  const m = value.match(/var\(--([^)]+)\)/);
  if (!m) return value.trim();
  return (cssVars[m[1]] || value).trim();
}

function resolveVarDeep(val, vars, depth = 0) {
  if (!val || depth > 8) return (val || '').trim();
  const m = val.match(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\s*\)/);
  if (!m) return val.trim();
  const resolved = (vars[m[1]] || (m[2] && m[2].trim()) || val).trim();
  return resolveVarDeep(resolved, vars, depth + 1);
}

// Normalize any CSS color expression to lowercase 6-char hex (or the raw value
// if it's not a recognizable white variant). Returns '' for nullish input.
function hexNorm(c) {
  if (!c) return '';
  c = c.trim().toLowerCase().replace(/\s+/g, '');
  if (c === 'white' || c === '#fff') return '#ffffff';
  const h3 = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (h3) return `#${h3[1]}${h3[1]}${h3[2]}${h3[2]}${h3[3]}${h3[3]}`;
  return c;
}

function extractCssVars(html) {
  const vars = {};
  // Handle both minified (:root{...}) and spaced (:root { ... }) CSS
  const m = html.match(/:root\s*\{([^}]+)\}/);
  if (!m) return vars;
  for (const pair of m[1].split(';')) {
    const i = pair.indexOf(':');
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k.startsWith('--')) {
      vars[k] = v;            // keyed as --name (with dashes) for resolveVarDeep
      vars[k.slice(2)] = v;   // also keyed without -- for the old resolveCssVar callers
    }
  }
  return vars;
}

// ── Universal CSS contrast scanner ───────────────────────────────────────────
// Runs on every HTML file. Two tiers:
//   FAIL  — same CSS rule declares both color and background that both resolve to #fff
//            (definitively invisible — no context needed)
//   WARN  — color resolves to #fff but no background in the same rule, AND
//            the file defines at least one white card/background CSS variable
//            (likely invisible on a white card; may be a false positive if the
//            element appears inside a dark parent not expressed in the same rule)
//
// Intentional white-on-dark patterns (e.g. buttons, toasts) are excluded via
// a denylist of selector fragments. To suppress a false positive, add
//   /* contrast-ok */
// anywhere in the CSS rule.
function scanUniversalContrast(html, filename) {
  const vars = extractCssVars(html);
  const issues = [];

  // Collect all <style> blocks
  const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
    .map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n');

  // Does this file define any white card/background variable?
  const hasWhiteCardBg = Object.entries(vars).some(([k, v]) =>
    (k.includes('card') || k.includes('bg') || k.includes('white')) &&
    hexNorm(resolveVarDeep(v, vars)) === '#ffffff'
  );

  // Parse CSS rules: selector { declarations }
  // Handles minified and formatted CSS; skips @rules and comments.
  const seen = new Set();
  const ruleRe = /([^{}@\n\/][^{}]*?)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css)) !== null) {
    const sel  = m[1].trim();
    const decls = m[2];
    if (!sel || sel.includes('@') || !decls.includes('color')) continue;
    if (decls.includes('contrast-ok')) continue; // explicit allowlist escape hatch

    const colorRaw = (decls.match(/(?:^|;)\s*color\s*:\s*([^;!]+)/) || [])[1]?.trim();
    const bgRaw    = (decls.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/) || [])[1]?.trim();

    if (!colorRaw) continue;
    if (hexNorm(resolveVarDeep(colorRaw, vars)) !== '#ffffff') continue;

    const key = `${filename}::${sel}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (bgRaw) {
      const resolvedBg = hexNorm(resolveVarDeep(bgRaw, vars));
      if (resolvedBg === '#ffffff') {
        // Definitive: same-rule white text on white background
        issues.push({ sel, colorRaw, bgRaw, severity: 'critical' });
      }
      // Non-white bg in same rule → intentional white-on-dark, skip
      continue;
    }

    // White text, no background in this rule.
    // Exclude known UI chrome that inherently lives on dark backgrounds.
    const s = sel.toLowerCase();
    const isDarkChrome =
      s.includes('btn') || s.includes('button') ||
      s.includes('badge') || s.includes('toast') ||
      s.includes('overlay') || s.includes('backdrop') ||
      s.includes('indicator') || s.includes('dot') ||
      s.includes('chip') || s.includes('win-heavy') ||
      s.includes('tier-') || s.includes('tab-badge') ||
      s.includes(':hover') || s.includes(':active') ||
      s.includes('::before') || s.includes('::after') ||
      // Calendar & shared nav elements that appear on dark (--navy / --navy2) backgrounds.
      // Their parent containers declare the dark background in a different CSS rule.
      s.includes('topbar') || s.includes('-logo') || s.includes('hdr-logo') ||
      s.includes('header-logo') || s.includes('week-label') ||
      s.includes('dh-date') || s.includes('dh-rev') ||
      s.includes('pf-total') || s.includes('rig-hdr') ||
      s.includes('day-rig-hdr') || s.includes('modal-title');

    if (!isDarkChrome && hasWhiteCardBg) {
      issues.push({ sel, colorRaw, bgRaw: null, severity: 'warning' });
    }
  }

  return issues;
}

// ── Fetch helper ──────────────────────────────────────────────────────────
// Cache-busting timestamp — forces CDN/edge to serve a fresh copy, not a stale cached page.
// GitHub Pages Fastly CDN respects Cache-Control: no-cache on the request.
const CACHE_BUST = { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } };

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { ...CACHE_BUST, ...opts });
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

  // Per-file regression guards (specific known-bad classes → FAIL if they regress)
  const cssVars = extractCssVars(html);
  for (const { selector, prop, forbidden } of cssChecks) {
    const ruleMatch = html.match(new RegExp(selector.replace('.', '\\.') + '\\{([^}]+)\\}'));
    if (!ruleMatch) { warn(`${file} — CSS ${selector}`, 'Rule not found'); continue; }
    const rule = ruleMatch[1];
    const propMatch = rule.match(new RegExp(prop + ':([^;]+)'));
    if (!propMatch) { warn(`${file} — CSS ${selector} ${prop}`, 'Property not found'); continue; }
    const rawValue = propMatch[1].trim();
    const resolved = resolveCssVar(rawValue, cssVars);
    if (resolved === forbidden) {
      fail(`${file} — CSS contrast: ${selector} { ${prop}: ${rawValue} }`,
           `Resolves to ${resolved} — matches forbidden value (white-on-white)`);
    } else {
      pass(`${file} — CSS contrast: ${selector} { ${prop}: ${rawValue} }`,
           `Resolves to ${resolved} ✓`);
    }
  }

  // Law 9 — catch-block forwarding lint
  // Scan for } catch( blocks that lack sendBeacon or errors/log forwarding.
  // Skip blocks with /* err-tracker-ok */ suppression comment.
  const scriptContent = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [])
    .map(s => s.replace(/<\/?script[^>]*>/gi, '')).join('\n');
  const catchBlocks = [...scriptContent.matchAll(/\}\s*catch\s*\([^)]*\)\s*\{/g)];
  let uncoveredCatches = 0;
  for (const m of catchBlocks) {
    const after = scriptContent.slice(m.index, m.index + 600);
    const hasForwarding = /sendBeacon|errors\/log|_fwdError/.test(after);
    const isSuppressed  = /err-tracker-ok/.test(after);
    const isTrivial     = /\/\*.*\*\/|console\.(warn|log)|return;/.test(after.slice(0, 80)); // tiny one-liners
    if (!hasForwarding && !isSuppressed && !isTrivial) uncoveredCatches++;
  }
  if (uncoveredCatches === 0) {
    pass(`${file} — Law 9 catch-block lint`, 'All catch blocks forward errors or are marked /* err-tracker-ok */');
  } else {
    warn(`${file} — Law 9 catch-block lint`,
         `${uncoveredCatches} catch block(s) lack sendBeacon forwarding and /* err-tracker-ok */ suppression`);
  }

  // Universal contrast scan — catches NEW white-on-white bugs across all selectors
  const contrastIssues = scanUniversalContrast(html, file);
  const criticals = contrastIssues.filter(i => i.severity === 'critical');
  const warnings  = contrastIssues.filter(i => i.severity === 'warning');
  if (criticals.length === 0 && warnings.length === 0) {
    pass(`${file} — universal contrast scan`, 'No white-on-white issues detected');
  } else {
    for (const { sel, colorRaw, bgRaw } of criticals) {
      fail(`${file} — contrast CRITICAL: ${sel}`,
           `color:${colorRaw} and background:${bgRaw} both resolve to #ffffff (invisible text)`);
    }
    if (warnings.length > 0) {
      const selList = warnings.map(w => w.sel).join(', ');
      warn(`${file} — contrast WARN: ${warnings.length} selector(s) use color:#fff with no explicit background`,
           `Selectors: ${selList} — verify each appears on a dark background or add /* contrast-ok */ to suppress`);
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
  const verifyToken = await getToken();
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
  const verifyToken = await getToken();
  if (!verifyToken) {
    warn('DB sanity — duplicate phones', 'Add ADMIN_PASSWORD to .env.local to enable authenticated DB checks');
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

// ── CHECK 6: Backup health ────────────────────────────────────────────────
async function checkBackupHealth() {
  // /admin/backup/last_run is a protected endpoint; skip if no token
  const verifyToken = await getToken();
  if (!verifyToken) {
    warn('Backup health', 'Add ADMIN_PASSWORD to .env.local to enable backup health checks');
    return;
  }
  let hb;
  try {
    const r = await fetch(`${WORKERS_API}/admin/backup/last_run`, {
      headers: { 'Authorization': `Bearer ${verifyToken}` },
    });
    if (!r.ok) { warn('Backup health', `HTTP ${r.status}`); return; }
    hb = await r.json();
  } catch (e) {
    warn('Backup health — fetch', e.message);
    return;
  }

  if (!hb || hb.status === 'never_run') {
    warn('Backup health', 'No backup has run yet — expected after first 4 AM UTC cron or manual trigger');
    return;
  }

  const ageHours  = (Date.now() - new Date(hb.ranAt)) / 3600000;
  const ageLabel  = ageHours < 1 ? `${Math.round(ageHours * 60)}m ago` : `${ageHours.toFixed(1)}h ago`;

  if (ageHours > 26) {
    fail('Backup health — staleness', `Last backup ${ageLabel} — expected within 26h. Cron may be failing.`);
  } else if (hb.status === 'error') {
    const errMsg = (hb.errors || []).join('; ') || 'unknown';
    if (errMsg.includes('R2 bucket not bound')) {
      warn('Backup health — R2 not configured', 'Create pure-cleaning-backups bucket and uncomment [[r2_buckets]] in wrangler.toml');
    } else {
      warn('Backup health — status:error', `Ran ${ageLabel}: ${errMsg}`);
    }
  } else {
    pass('Backup health', `${ageLabel} · ${(hb.sizeBytes / 1048576).toFixed(1)}MB · status:${hb.status}`);
  }
}

// ── CHECK 6b: Google Drive export status ─────────────────────────────────
async function checkGoogleExportStatus() {
  const verifyToken = await getToken();
  if (!verifyToken) {
    warn('Google export health', 'Add ADMIN_PASSWORD to .env.local to enable Google export checks');
    return;
  }
  let data;
  try {
    const r = await fetch(`${WORKERS_API}/admin/google-drive/status`, {
      headers: { Authorization: `Bearer ${verifyToken}` },
    });
    if (!r.ok) { warn('Google export health', `HTTP ${r.status}`); return; }
    data = await r.json();
  } catch(e) {
    warn('Google export health — fetch', e.message);
    return;
  }
  if (!data.authorized) {
    warn('Google export health — not authorized', 'Visit /oauth/google/start to authorize Google Drive access');
    return;
  }
  if (!data.folderId) {
    warn('Google export health — folder not set', 'POST /admin/google-drive/set-folder with { folderId } from Drive URL');
    return;
  }
  const last = data.lastExport;
  if (!last) {
    warn('Google export health — never run', 'Trigger a manual test: POST /admin/export-weekly');
    return;
  }
  const ageHours = (Date.now() - new Date(last.ranAt)) / 3600000;
  const ageLabel = ageHours < 24 ? `${Math.round(ageHours)}h ago` : `${(ageHours / 24).toFixed(1)}d ago`;
  if (last.success) {
    pass('Google export health', `Last export ${ageLabel} · ${(last.filesWritten || []).length} files written`);
  } else {
    warn('Google export health — last export had errors', `${ageLabel}: ${(last.errors || []).map(e => e.error).join('; ')}`);
  }
}

// ── CHECK 7: Error monitoring — spike detection ───────────────────────────
async function checkErrorSpike() {
  // Requires auth (admin/errors is a protected endpoint)
  const verifyToken = await getToken();
  if (!verifyToken) {
    warn('Error spike check', 'Add ADMIN_PASSWORD to .env.local to enable error monitoring checks');
    return;
  }
  let data;
  try {
    const r = await fetch(`${WORKERS_API}/admin/errors?since=24h`, {
      headers: { 'Authorization': `Bearer ${verifyToken}` },
    });
    if (!r.ok) { warn('Error spike check', `HTTP ${r.status}`); return; }
    data = await r.json();
  } catch (e) {
    warn('Error spike check — fetch', e.message);
    return;
  }
  const total  = data.total  || 0;
  const errors = data.errors || [];
  const client = errors.filter(e => e.source === 'client').length;
  const worker = errors.filter(e => e.source === 'worker').length;
  if (total > 200) {
    fail('Error spike', `${total} errors in last 24h (${client} client, ${worker} worker) — something is seriously broken`);
  } else if (total > 50) {
    warn('Error spike', `${total} errors in last 24h (${client} client, ${worker} worker) — investigate`);
  } else {
    pass('Error monitoring', `${total} errors in last 24h (${client} client, ${worker} worker)`);
  }
}

// ── CHECK 8: Customer-facing flow smoke tests ─────────────────────────────
//
// Simulates what an unauthenticated customer experiences.
// ANY 401 from a customer page's API call = deploy-blocker.
//
// Also scans HTML for fetch() calls and flags any that hit protected endpoints.

const CUSTOMER_PAGES = [
  'index.html',
  'q.html',
  'pure_cleaning_quote.html',
  'pure_cleaning_customer_quote.html',
  'pure_cleaning_agreement.html',
  'pure_cleaning_receipt.html',
];

// Mirrors isPublic in cloudflare-worker/src/index.js
const PUBLIC_API_PATHS = new Set([
  'health', 'auth/login', 'auth/logout',
  'incoming', 'errors/log', 'links',
  'blocked-weeks', 'reviews', 'events',
  'calendar/blocked-dates',
  'dates/suggest', 'service-frequency', 'addons-config',
]);
const PUBLIC_API_PREFIXES = [
  'quote', 'agreement', 'appointment', 'receipt', 'customer',
];

function isKnownPublicPath(rawPath) {
  // Strip query string and leading/trailing slashes
  const p = rawPath.split('?')[0].replace(/^\/+|\/+$/g, '');
  if (!p) return true;
  if (PUBLIC_API_PATHS.has(p)) return true;
  // Prefix match (with or without trailing slash)
  return PUBLIC_API_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'));
}

function extractApiPaths(html) {
  const paths = new Set();
  // Template literals: ${PCPC_API}/path  ${API}/path  ${API_CQ}/path
  const tplRe = /\$\{[A-Z_]+(?:_CQ)?\}\/([a-zA-Z0-9_\-/]+)/g;
  let m;
  while ((m = tplRe.exec(html)) !== null) paths.add(m[1].split('?')[0].split('{')[0]);
  // String concat: API + '/path'
  const concatRe = /[A-Z_]+\s*\+\s*['"]\/([a-zA-Z0-9_\-/]+)['"]/g;
  while ((m = concatRe.exec(html)) !== null) paths.add(m[1].split('?')[0]);
  // Absolute URL
  const absRe = /purecleaning-api\.tylerfumero\.workers\.dev\/([a-zA-Z0-9_\-/]+)/g;
  while ((m = absRe.exec(html)) !== null) paths.add(m[1].split('?')[0].replace(/\/$/, ''));
  return paths;
}

async function checkCustomerFlows() {
  for (const file of CUSTOMER_PAGES) {
    const url = `${GITHUB_PAGES}/${file}`;
    let html = '';
    try {
      const r = await fetch(url);
      if (!r.ok) { fail(`Customer flow — ${file}`, `HTTP ${r.status}`); continue; }
      html = await r.text();
      pass(`Customer flow — ${file} reachable`);
    } catch (e) {
      fail(`Customer flow — ${file}`, e.message);
      continue;
    }

    // Auth gate check: customer pages must NOT have the auth gate redirect
    if (file !== 'login.html' && html.includes('/login.html?return=') && html.includes('localStorage.getItem(\'admin_token\')')) {
      // Only fail if this is NOT known to be admin-only
      const knownAdmin = ['pure_cleaning_calendar', 'pure_cleaning_customer_directory',
        'pure_cleaning_incoming', 'pure_cleaning_review_hub', 'pure_cleaning_bulk_reactivation',
        'pure_cleaning_admin', 'pure_cleaning_errors', 'pure_cleaning_backups', 'pure_cleaning_worker_hours',
        'pure_cleaning_day_route',
      ].some(a => file.includes(a));
      if (!knownAdmin) {
        fail(`Customer flow — ${file} has auth gate`, 'Customer page redirects to login — customers would be locked out');
      }
    }

    // Extract and audit all API paths called from this customer page
    const apiPaths = extractApiPaths(html);
    const unknown = [];
    for (const p of apiPaths) {
      // Skip external services
      if (p.startsWith('http') || p.includes('jsonbin') || p.includes('formspree') || p.includes('zapier')) continue;
      if (!isKnownPublicPath(p)) unknown.push(p);
    }
    if (unknown.length > 0) {
      fail(`Customer flow — ${file} calls protected endpoint(s)`,
        unknown.map(p => `/${p}`).join(', ') + ' — add to isPublic or create scoped endpoint');
    } else if (apiPaths.size > 0) {
      pass(`Customer flow — ${file} API paths all public`, `(${apiPaths.size} calls verified)`);
    }
  }

  // Live endpoint smoke test for the critical customer path
  const criticalGetEndpoints = [
    { path: '/links',             desc: 'q.html link resolver' },
    { path: '/service-frequency', desc: 'quote form services list' },
    { path: '/addons-config',     desc: 'quote form add-ons' },
    { path: '/dates/suggest',     desc: 'quote form date suggestions' },
  ];

  for (const { path, desc } of criticalGetEndpoints) {
    try {
      const r = await fetch(`${WORKERS_API}${path}`);
      if (r.status === 401) {
        fail(`Customer API — ${path}`, `Returns 401 without auth — ${desc} is broken for customers`);
      } else {
        pass(`Customer API — ${path}`, `HTTP ${r.status} (${desc})`);
      }
      await r.body?.cancel().catch(() => {});
    } catch (e) {
      fail(`Customer API — ${path} fetch`, e.message);
    }
  }

  // POST /incoming — validation check (invalid data → 400, does NOT save to KV)
  try {
    const r = await fetch(`${WORKERS_API}/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerData: { firstName: 'X', lastName: 'Y', phone: '123', city: '' } }),
    });
    if (r.status === 400) {
      pass('Customer API — POST /incoming validation', 'Invalid submission correctly rejected (400)');
    } else if (r.status === 401) {
      fail('Customer API — POST /incoming validation', 'Returns 401 — public endpoint is broken for customers');
    } else {
      warn('Customer API — POST /incoming validation', `Expected 400 for invalid data, got ${r.status}`);
    }
    await r.body?.cancel().catch(() => {});
  } catch (e) {
    fail('Customer API — POST /incoming validation fetch', e.message);
  }

  // POST /incoming — honeypot check (honeypot filled → 200 silently, does NOT save to KV)
  try {
    const r = await fetch(`${WORKERS_API}/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ website: 'http://example.com', customerData: { firstName: 'Bot', lastName: 'Test', phone: '9543891234', city: 'Weston' } }),
    });
    if (r.status === 200) {
      pass('Customer API — POST /incoming honeypot', 'Honeypot-filled submission silently accepted (200, not saved)');
    } else {
      warn('Customer API — POST /incoming honeypot', `Expected 200 for honeypot, got ${r.status}`);
    }
    await r.body?.cancel().catch(() => {});
  } catch (e) {
    fail('Customer API — POST /incoming honeypot fetch', e.message);
  }
}

// ── CHECK 7: Mobile compatibility ─────────────────────────────────────────
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
  const verifyToken = await getToken();
  if (!verifyToken) {
    warn('Cron heartbeat', 'Add ADMIN_PASSWORD to .env.local to enable cron heartbeat check');
    return;
  }
  let hb;
  try {
    const r = await fetch(`${WORKERS_API}/admin/cron-heartbeat`, {
      headers: { 'Authorization': `Bearer ${verifyToken}` },
    });
    if (!r.ok) { warn('Cron heartbeat', `HTTP ${r.status}`); return; }
    hb = await r.json();
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

// ── CHECK 13: Job history integrity (Law 13 — generalized variant detection) ──
// Scans ALL customers for three bug classes, not just the specific instances fixed.
async function checkJobHistoryIntegrity() {
  const verifyToken = await getToken();
  if (!verifyToken) {
    warn('Job history integrity', 'Add ADMIN_PASSWORD to .env.local to enable job history checks');
    return;
  }

  let custs;
  try {
    const r = await fetch(`${WORKERS_API}/customers`, {
      headers: { Authorization: `Bearer ${verifyToken}`, ...CACHE_BUST.headers },
    });
    if (!r.ok) { warn('Job history integrity — fetch', `HTTP ${r.status}`); return; }
    custs = (await r.json()).customers || [];
  } catch (e) {
    warn('Job history integrity — fetch', e.message);
    return;
  }

  // Word-overlap Jaccard similarity for service description comparison
  function descSimilarity(a, b) {
    const words = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
    const setA = words(a), setB = words(b);
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return union ? intersection / union : 0;
  }

  const collisionRisks   = [];
  const dupCompletions   = [];
  const undefinedSources = [];

  for (const c of custs) {
    if (c.deleted) continue;
    const jh   = c.jobHistory || [];
    const ss   = c.scheduledStatus;
    const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.phone;

    // ── Class A: csv_backfill collision risk ───────────────────────────────
    // Detects: same-date, near-date+similar-service (≤14d, >80% match),
    //          or same-service-different-date (>95% match any date distance)
    if (ss && (ss.state === 'scheduled' || ss.state === 'in_progress')) {
      const backfillEntries = jh.filter(j => j.source === 'csv_backfill' || !j.source);
      for (const j of backfillEntries) {
        if (!j.date || !ss.scheduledDate) continue;
        const dayDiff = Math.abs(
          (new Date(ss.scheduledDate + 'T12:00:00') - new Date(j.date + 'T12:00:00')) / 86400000
        );
        const sim = descSimilarity(ss.jobNotes, j.services);
        if (dayDiff === 0) {
          collisionRisks.push({ name, phone: c.phone, type: 'same-date', dayDiff, sim: sim.toFixed(2) });
        } else if (dayDiff <= 14 && sim >= 0.8) {
          collisionRisks.push({ name, phone: c.phone, type: 'near-date+similar-svc', dayDiff, sim: sim.toFixed(2) });
        } else if (sim >= 0.95 && dayDiff <= 60) {
          // dayDiff > 60 excluded: legitimate repeat customers often book the same recurring services
          // (e.g., Erik Chafin — same services, 434 days apart = annual repeat, not a collision)
          collisionRisks.push({ name, phone: c.phone, type: 'same-svc-diff-date', dayDiff, sim: sim.toFixed(2) });
        }
      }
    }

    // ── Class B: duplicate completion entries ──────────────────────────────
    // Detects: multiple completed entries on same date with amount within $5
    const byDate = {};
    for (const j of jh) {
      if (j.status === 'completed' && j.date) {
        (byDate[j.date] = byDate[j.date] || []).push(j);
      }
    }
    for (const [date, entries] of Object.entries(byDate)) {
      if (entries.length < 2) continue;
      for (let i = 0; i < entries.length; i++) {
        for (let k = i + 1; k < entries.length; k++) {
          if (Math.abs((entries[i].amount || 0) - (entries[k].amount || 0)) <= 5) {
            dupCompletions.push({
              name, phone: c.phone, date,
              sources: [entries[i].source || 'undefined', entries[k].source || 'undefined'],
            });
          }
        }
      }
    }

    // ── Class C: source:undefined entries ─────────────────────────────────
    // Detects legacy pre-schema entries or code paths that forgot to set source
    for (const j of jh) {
      if (j.date && j.status === 'completed' && !j.source) {
        undefinedSources.push({ name, phone: c.phone, date: j.date });
      }
    }
  }

  // Report Class A
  if (collisionRisks.length === 0) {
    pass('Job history — csv_backfill collision risk (Class A)', 'No collision risks in active scheduled jobs');
  } else if (collisionRisks.length <= 5) {
    warn('Job history — csv_backfill collision risk (Class A)',
      `${collisionRisks.length} risk(s): ${collisionRisks.map(r => `${r.name}(${r.type},${r.dayDiff}d,sim=${r.sim})`).join('; ')}`);
  } else {
    fail('Job history — csv_backfill collision risk (Class A)',
      `${collisionRisks.length} risks — exceeds threshold of 5. Data may be corrupted. Run npm run integrity.`);
  }

  // Report Class B
  if (dupCompletions.length === 0) {
    pass('Job history — duplicate completions (Class B)', 'No near-duplicate completion entries');
  } else {
    const detail = dupCompletions.slice(0, 5).map(d => `${d.name} ${d.date}(src:${d.sources.join('/')})`).join('; ');
    warn('Job history — duplicate completions (Class B)',
      `${dupCompletions.length} duplicate(s): ${detail}`);
  }

  // Report Class C
  if (undefinedSources.length === 0) {
    pass('Job history — source field integrity (Class C)', 'All completed entries have source field set');
  } else {
    warn('Job history — source field integrity (Class C)',
      `${undefinedSources.length} entries with source:undefined (likely pre-schema legacy entries)`);
  }
}

// ── Cache-Control headers ─────────────────────────────────────────────────
async function checkCacheHeaders() {
  const base = process.env.PAGES_BASE || WORKERS_API;

  // HTML files must have no-cache headers
  try {
    const r = await fetch(`${base}/pure_cleaning_calendar.html`, { headers: { 'Cache-Control': 'no-cache' } });
    const cc = r.headers.get('cache-control') || '';
    if (cc.includes('no-cache') || cc.includes('no-store')) {
      pass('Cache headers — HTML no-cache', `calendar.html: ${cc}`);
    } else {
      fail('Cache headers — HTML no-cache', `calendar.html Cache-Control: "${cc}" — expected no-cache`);
    }
  } catch (e) {
    fail('Cache headers — HTML no-cache', `fetch failed: ${e.message}`);
  }

  // Hashed JS bundles must have immutable long-lived cache headers
  try {
    const r = await fetch(`${base}/static/js/main.faff34a1.js`, { headers: { 'Cache-Control': 'no-cache' } });
    const cc = r.headers.get('cache-control') || '';
    if (cc.includes('max-age=31536000') || cc.includes('immutable')) {
      pass('Cache headers — JS bundle immutable', `main.faff34a1.js: ${cc}`);
    } else {
      fail('Cache headers — JS bundle immutable', `main.faff34a1.js Cache-Control: "${cc}" — expected max-age=31536000`);
    }
  } catch (e) {
    fail('Cache headers — JS bundle immutable', `fetch failed: ${e.message}`);
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
  await checkBackupHealth();
  await checkGoogleExportStatus();
  await checkErrorSpike();
  await checkJobHistoryIntegrity(); // Law 13: generalized csv_backfill collision + idempotency scanner
  await checkCustomerFlows();
  await checkMobileCompatibility();
  await checkCacheHeaders();

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
