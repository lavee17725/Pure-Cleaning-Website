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
      'altContactName',         // WO-H 2a: lead's alt contact carried into the convert→new_customer link
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
      'tomorrow in the',                                  // Regression: night-prior confirmation SMS uses "tomorrow in the {window}"
      "'morning'",                                        // Regression: slot key 'morning' (not '~9-10am')
      'tapSchedStorySel',                                 // Regression: story selector in tap-schedule modal
      'fullEditModal',                                    // Regression: full edit modal present
      'saveFullEdit',                                     // Regression: full edit save function
      'fePhone',                                          // Regression: phone field in full edit modal
      'DAY_DRAG_PX',                                      // Regression: day-by-day drag constant
      "state === 'completed'",                            // Regression: drag guard on completed jobs
      'jhEntry.rigId = ss.rig',                           // Regression: pencil edit updates jobHistory.rigId
      'jhEntry.rig = ss.rig',                             // Regression: pencil edit also updates jobHistory.rig (render field)
      '_lastCommittedDays',                               // Regression: continuous drag commits mid-drag
      'renderRigCommuteBanners',                          // Regression: home commute banners per rig
      'rig-commute-banner',                               // Regression: commute banner CSS class
      'window.location.href',                             // Regression: Day Route opens in same tab
      // 2026-06-23 Revert path (Section-9 trigger fix, DL-03 / T1.21):
      "j.source === 'rig_segment'",                       // Regression: revert purge includes rig_segment children (Bug 4)
      "j.source === 'day_segment'",                       // Regression: revert purge includes day_segment children (Bug 4)
      "completedAt: null, paidAt: null, paymentStatus: 'unpaid'",  // Regression: revert PATCH clears D1 completion fields; paymentStatus='unpaid' because Job.paymentStatus NOT NULL (Bug 3 + cowork addendum)
      // 2026-06-23 WO1 / Task #26 — fire-and-forget saveDb() hardening (T1.20):
      // primary/only-write callers now await + surface failure; residual KV-sync
      // callers now log instead of swallowing. If any of these revert to a silent
      // .catch(()=>{}), the marker disappears and this check goes red.
      '[undoAction] KV revert failed',          // Fix B: undoAction logs + warns on KV revert failure
      '[requestPayment] KV save failed',         // Fix F: requestPayment logs + toasts (non-blocking)
      '[dismissMiniQuote] KV save failed',       // Fix G: dismissMiniQuote awaits + reverts state on failure
      'Could not assign rig',                    // Fix A: applyRigPick legacy branch awaits + reverts rig
      '[handleDropToPool] KV sync failed',       // Residual: drag-to-pool KV sync logged
      '[_doCompleteJob] KV sync failed',         // Residual: completion KV sync logged
      // 2026-06-23 WO-3 — Full Proposal for split (Pressure Clean/Sand/Seal) jobs:
      'function printFullProposal',              // entry point on split cards
      'function _fullProposalBody',              // multi-phase line-items print body
      'Total — All Phases',                      // combined-total label (proves all-phase rollup)
      'function _renderAltContacts',             // WO-2: alt-contacts render on card + full-details modal (T1.21 read surface)
      'js-num-lbl',                              // WO-H: labeled Main/Alternative numbers on the print job sheet
      'fePhaseScope',                            // WO-C: per-job/day scope capture field (full-edit modal)
      'ss.phaseScope ||',                        // WO-C: day sheet renders scope first, not generic phase label
    ],
  },
  {
    file: 'pure_cleaning_customer_directory.html',
    markers: ['function _normalizeAddress', 'function _addrMatch',   // 2026-07-23 address normalization (Todd Griffin case)
              'function applyAll', 'TIER_RANK', 'function _segmentOf', 'function _displayName',
              '_dirAltContacts',   // WO-2: alternate-contacts render on directory card + row (T1.21 read surface)
              'dir-sat-thumb', '_dirMapsUrl'],  // satellite thumbnail → opens Google Maps (superseded WO-B lightbox)
  },
  {
    file: 'pure_cleaning_customer_profile.html',
    markers: ['const API', 'function buildTimeline', 'function renderServiceHistory',
              '_altContactRows'],  // WO-2: alternate-contacts render in profile contact zone (T1.21 read surface)
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
      // 2026-06-23 WO1 / Task #26 — fire-and-forget saveDatabase() hardening (T1.20):
      'Could not save customer — check connection',  // Fix I: submitAddCustomer awaits + rolls back on failure
      '[markPhoneDisconnected] DB save failed',       // Fix J: markPhone* awaits + reverts phoneStatus on failure
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
      'matchBanner',           // Existing customer detection — rich match banner
      'altContactsContainer',  // Alternate contacts container
      'addAltContact',         // Add alternate contact function
      'buildAltContacts',      // Build alternateContacts array
      'restoreAltContacts',    // Restore alt contacts on edit
      'showMatchBanner',       // Match banner JS function
      'useMatch',              // "Yes, use existing" handler
      'onNameInput',           // Name detection debounce trigger
      'onAddressInput',        // Address detection debounce trigger
      'showJobHistory',        // Job history section renderer
      'jhSection',             // Job history container
      'alternateContacts',     // alternateContacts persisted to customer record
      'existing_customer_updated', // audit event on existing customer update
      'alt-contacts PATCH',        // WO-H 2b: new_customer persists alt contacts to D1 Person (T1.22 write path)
      // (2026-07-23: the former Fix-H marker 'Customer not saved — check
      //  connection' was digital-path code; the send-a-link path was retired
      //  by the Quote Pool WO, so the marker retired with it.)
      // 2026-07-23 Quote Pool WO — booking flow reached via Log Confirmed
      // Quote / pool Accept; these guard the hand-off contract:
      '_activeQuoteId',            // quote-context global (link-back + price carry)
      'quote link-back',           // personId PATCH onto the Quote row after save
      'data.svc',                  // fromOnline blob carries service preselects
      'qsvc',                      // ?phone= hand-off carries service preselects
      '_applyQuoteCustomText',     // v1.1: write-ins + chip notes → customServiceText
      'qcustom',                   // v1.1: ?phone= hand-off carries custom text
      '_PICKER_TO_CHIP',           // v1.3: booking data backfills the Quote row (fast exit)
      'quote price backfill',      // v1.3: schedule-modal price PATCHes onto the row
      'setPath() removed',         // toggle stays dead — digital path must not resurrect
    ],
  },
  {
    file: 'pure_cleaning_quote_pool.html',
    markers: [
      'quote-logger.js',           // shared 15-second entry modal loaded
      'acceptedUnbooked',          // safety strip: accepted-not-booked can't vanish
      'MIN_SAMPLE',                // insights honesty floor (no % from tiny samples)
      'declineModal',              // 4-chip decline reason picker
      'handoffUrl',                // Accept → existing booking flow, pre-filled
      'openDelete',                // v1.2: 🗑️ soft delete on every card mode
      'deleteLinkedWarn',          // v1.2: linked-booking warning in confirm
      'function renderLedger',     // v1.4: chronological ledger view
      'function _periodRange',     // v1.4: week/month period math (year-ready)
      'openLedgerDetail',          // v1.4: ledger row → action sheet
    ],
  },
  // (js/quote-logger.js is exercised via the pages that load it — HTML_FILES
  //  entries run mobile/viewport checks that only make sense for HTML.)
  {
    file: 'pure_cleaning_admin.html',
    markers: [
      'quote-pool-badge',          // hub tile open-count badge
      'openQuoteLogger',           // ＋ Log Quote tile action
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
  { path: '/admin/quotes',        expect401: true },   // protected — Quote Pool (2026-07-23)
  // ── Rule 10 tripwire: redirect-shadowing ───────────────────────────────────
  // /reviews is a public worker API (admin review-count widget). On 2026-06-11
  // a `/reviews → /` entry was added to the worker's legacyRedirects dict,
  // shadowing the API and 301-redirecting every GET/PUT before the handler ran.
  // The bug hid behind a 24h edge cache.
  //
  // This check goes red if /reviews ever returns 3xx (no JSON) again.
  // ANY future public API endpoint with a short single-segment name (e.g.
  // /links, /events) that ALSO appears in legacyRedirects should be added below
  // — the cost of one extra HTTP check is trivial compared to another silent
  // collision incident.
  { path: '/reviews',             expectKey: 'count', expectPublic: true },
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

// Network-resilient fetch — retries ONLY on thrown errors (undici "fetch failed", DNS/
// connection blips), up to 3 attempts with backoff + a 20s per-attempt abort. HTTP responses
// (including non-2xx) pass straight through, so every caller's `if (!r.ok)` status check is
// unchanged and real regressions still fail. Stops false-fails from connection jitter only.
async function fetchRetry(url, opts = {}, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(20000) }); }
    catch (e) { lastErr = e; if (i < attempts) await new Promise(r => setTimeout(r, 400 * i)); }
  }
  throw lastErr;
}

async function fetchText(url, opts = {}) {
  const r = await fetchRetry(url, { ...CACHE_BUST, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function fetchJson(url) {
  const r = await fetchRetry(url);
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

  // Marker checks — with a bounded re-fetch for edge-propagation lag.
  // 2026-07-23 (T2.11): three consecutive deploys red-flagged freshly-added
  // markers that WERE live on a manual re-check seconds later — the Cloudflare
  // edge serves the prior HTML for a few seconds after upload. Re-fetch up to
  // 4× (≈2s + 4s + 6s) ONLY while some marker is missing; a marker that never
  // appears still fails, so a real regression is not masked — only the lag is.
  let missing = markers.filter(m => !html.includes(m));
  for (let attempt = 1; missing.length && attempt <= 4; attempt++) {
    await new Promise(r => setTimeout(r, 2000 * attempt));
    try { html = await fetchText(url); } catch (e) { break; }
    missing = markers.filter(m => !html.includes(m));
  }
  for (const marker of markers) {
    if (html.includes(marker)) pass(`${file} — marker: ${marker}`);
    else fail(`${file} — marker: ${marker}`, 'NOT FOUND in live HTML (after propagation retries)');
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
      r = await fetchRetry(url);
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
    const r = await fetchRetry(`${WORKERS_API}/incoming`, { headers });
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
  const r2 = await fetchRetry(`${WORKERS_API}/customers`, { headers: { 'Authorization': `Bearer ${verifyToken}` } });
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
    const r = await fetchRetry(`${WORKERS_API}/admin/backup/last_run`, {
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
    const r = await fetchRetry(`${WORKERS_API}/admin/google-drive/status`, {
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

  // GBP (Business Profile) token/permission health — DL-08 (Phase 0). WARN-only so it
  // never blocks a deploy: 'failed' before re-consent is expected until business.manage
  // is granted; 'degraded' means scope OK but account/location not resolved yet.
  const gbp = data.gbp;
  if (gbp) {
    if (gbp.status === 'healthy') {
      pass('GBP Business Profile health', `scope granted · ${gbp.locationName}`);
    } else if (gbp.status === 'degraded') {
      warn('GBP Business Profile — not resolved', 'Scope OK. Run GET /admin/gbp/resolve to cache account + location.');
    } else {
      warn('GBP Business Profile — token/permission', `${gbp.lastError || 'accounts.list failed'}. Re-consent at /oauth/google/start (business.manage) + enable the GBP APIs in GCP.`);
    }
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
    const r = await fetchRetry(`${WORKERS_API}/admin/errors?since=24h`, {
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

// ── Edit-modal write-path registry (2026-06-22 Phase 1 guardrail) ──────────
// Every field exposed in an admin edit modal must have a documented write
// path: a scoped PATCH endpoint that persists the value. Without this check,
// fields silently "save" to KV-only dead writes (the c.sqFt / c.notes pattern
// we just untangled). For each registry entry, the live deployed page must
// contain BOTH the field's DOM id AND the endpoint prefix it routes through.
//
// Adding a new edit field? Add the {file, fieldId, endpoint} row here in the
// same commit, or the deploy fails. Removing a field? Drop the row.
const EDIT_MODAL_WRITES = [
  // ── calendar.html — full edit modal (saveFullEdit, D1-native + KV paths) ──
  { file: 'pure_cleaning_calendar.html', fieldId: 'feSqFt',        endpoint: '/admin/property/',   target: 'Property.sqft' },
  // Note: revert path doesn't surface a DOM edit-modal field — the regression
  // markers above (rig_segment / day_segment / completedAt:null) cover it.
  { file: 'pure_cleaning_calendar.html', fieldId: 'feRoofType',    endpoint: '/admin/job/',        target: 'Job.roofType → Property.roofType' },
  { file: 'pure_cleaning_calendar.html', fieldId: 'feRoofStories', endpoint: '/admin/job/',        target: 'Job.roofStories' },
  { file: 'pure_cleaning_calendar.html', fieldId: 'fePayMethod',   endpoint: '/admin/job/',        target: 'Job.paymentMethod' },
  { file: 'pure_cleaning_calendar.html', fieldId: 'feEmail',       endpoint: '/admin/person/',     target: 'Person.email' },
  { file: 'pure_cleaning_calendar.html', fieldId: 'fePropLabel',   endpoint: '/admin/person-property', target: 'PersonProperty.propertyLabel' },
  // ── customer_profile.html — inline edits ──────────────────────────────────
  { file: 'pure_cleaning_customer_profile.html', fieldId: 'heroEmailInput', endpoint: '/admin/person/', target: 'Person.email' },
  { file: 'pure_cleaning_customer_profile.html', fieldId: 'noteTextarea',   endpoint: '/admin/person/', target: 'Person.profileNotesJson (via /note)' },
  // ── customer_directory.html — quick edit modal ────────────────────────────
  { file: 'pure_cleaning_customer_directory.html', fieldId: 'editFn',  endpoint: '/admin/person/', target: 'Person.firstName' },
  { file: 'pure_cleaning_customer_directory.html', fieldId: 'editLn',  endpoint: '/admin/person/', target: 'Person.lastName' },
  { file: 'pure_cleaning_customer_directory.html', fieldId: 'editBn',  endpoint: '/admin/person/', target: 'Person.businessName' },
  { file: 'pure_cleaning_customer_directory.html', fieldId: 'editEm',  endpoint: '/admin/person/', target: 'Person.email' },
];

async function checkEditModalWrites() {
  // Group registry by file so we fetch each HTML once.
  const byFile = {};
  for (const entry of EDIT_MODAL_WRITES) {
    if (!byFile[entry.file]) byFile[entry.file] = [];
    byFile[entry.file].push(entry);
  }
  for (const [file, entries] of Object.entries(byFile)) {
    let html = '';
    try {
      const r = await fetchRetry(`${GITHUB_PAGES}/${file}`, CACHE_BUST);
      if (!r.ok) { fail(`Edit-modal writes — ${file}`, `HTTP ${r.status}`); continue; }
      html = await r.text();
    } catch (e) { fail(`Edit-modal writes — ${file}`, e.message); continue; }
    for (const { fieldId, endpoint, target } of entries) {
      // Field's input/select MUST exist — match id= (single input) or name=
      // (radio group, e.g. feRoofStories has three radios sharing the name).
      const fieldRe = new RegExp(`(?:id|name)=["']${fieldId}["']`);
      if (!fieldRe.test(html)) {
        fail(`Edit-modal writes — ${file}: field "${fieldId}"`, `DOM id/name missing — registry says it writes ${target}`);
        continue;
      }
      // Endpoint prefix MUST appear in the same file's JS
      if (!html.includes(endpoint)) {
        fail(`Edit-modal writes — ${file}: field "${fieldId}"`, `endpoint ${endpoint} missing — saves would not reach ${target}`);
        continue;
      }
      pass(`Edit-modal write — ${fieldId} → ${target}`);
    }
  }
}

async function checkCustomerFlows() {
  for (const file of CUSTOMER_PAGES) {
    const url = `${GITHUB_PAGES}/${file}`;
    let html = '';
    try {
      const r = await fetchRetry(url);
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
      const r = await fetchRetry(`${WORKERS_API}${path}`);
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
    const r = await fetchRetry(`${WORKERS_API}/incoming`, {
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
    const r = await fetchRetry(`${WORKERS_API}/incoming`, {
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
    const r = await fetchRetry(url);
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
      const r = await fetchRetry(url, { headers: { 'User-Agent': ua } });
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
    const r = await fetchRetry(`${WORKERS_API}/admin/cron-heartbeat`, {
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
    const r = await fetchRetry(`${WORKERS_API}/customers`, {
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
    const r = await fetchRetry(`${base}/pure_cleaning_calendar.html`, { headers: { 'Cache-Control': 'no-cache' } });
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
    const r = await fetchRetry(`${base}/static/js/main.faff34a1.js`, { headers: { 'Cache-Control': 'no-cache' } });
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
  await checkEditModalWrites();
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
