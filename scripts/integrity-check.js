#!/usr/bin/env node
/**
 * Database integrity check for customer_db.
 *
 * Run: node scripts/integrity-check.js
 *      node scripts/integrity-check.js --auto-fix   (safe normalizations only)
 *      npm run integrity
 *      npm run integrity:fix
 *
 * Exit codes: 0 = clean, 1 = failures found
 */

const WORKERS_API = 'https://purecleaning-api.tylerfumero.workers.dev';
const AUTO_FIX    = process.argv.includes('--auto-fix');

// ── Allowed value sets ────────────────────────────────────────────────────
const VALID_PAYMENT_METHODS_NORM = new Set(['zelle', 'check', 'cash', 'venmo']);
const VALID_JH_SOURCES           = new Set(['csv_backfill', 'calendar_completion', 'manual_entry', 'manual_repair', 'manual_referral_add', 'quote_reschedule']);
const VALID_SS_STATES            = new Set(['scheduled', 'completed', 'cancelled', 'needs_scheduling']);
const REFERRAL_PHONE_RE          = /^REFERRAL_/;

// ── Result tracking ───────────────────────────────────────────────────────
const categories = {};
let totalFails = 0, totalWarns = 0, totalPass = 0;

function getCategory(name) {
  if (!categories[name]) categories[name] = { fails: [], warns: [], pass: 0 };
  return categories[name];
}

function fail(cat, label) { getCategory(cat).fails.push(label); totalFails++; }
function warn(cat, label) { getCategory(cat).warns.push(label); totalWarns++; }
function pass(cat)        { getCategory(cat).pass++; totalPass++; }

// ── Helpers ───────────────────────────────────────────────────────────────
function ref(c) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)';
  return `[${c.phone || 'no-phone'}] ${name}`;
}

function isValidDate(s) {
  if (!s || typeof s !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00').getTime());
}

function isValidIso(s) {
  if (!s || typeof s !== 'string') return false;
  return !isNaN(new Date(s).getTime());
}

function isFuture(dateStr) {
  return new Date(dateStr + 'T12:00:00') > new Date();
}

// ── Fetch ─────────────────────────────────────────────────────────────────
async function fetchCustomers() {
  const r = await fetch(`${WORKERS_API}/customers`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from /customers`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data.customers || []);
}

// ── Auto-fix ──────────────────────────────────────────────────────────────
// Returns { patch: {...} } if a fix should be pushed, else null.
// Only fixes: preferredPaymentMethod case normalization.
function autoFixRecord(c) {
  const patch = {};
  const pm = c.preferredPaymentMethod;
  if (pm) {
    const norm = pm.toLowerCase();
    if (norm !== pm && VALID_PAYMENT_METHODS_NORM.has(norm)) {
      patch.preferredPaymentMethod = norm;
    }
  }
  return Object.keys(patch).length ? patch : null;
}

async function pushFix(c, patch) {
  const merged = { ...c, ...patch };
  const r = await fetch(`${WORKERS_API}/customers/${c.phone}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://purecleaningpressurecleaning.com' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) console.error(`  ✗ PATCH failed for ${c.phone}: HTTP ${r.status}`);
  else console.log(`  ✓ Fixed ${ref(c)}: ${JSON.stringify(patch)}`);
}

// ── Assertions ────────────────────────────────────────────────────────────
function checkRequired(c) {
  const cat = 'Required fields';
  let ok = true;
  if (!c.phone || typeof c.phone !== 'string') { fail(cat, `${ref(c)}: phone missing or not string`); ok = false; }
  if (!c.firstName && !c.lastName)              { fail(cat, `${ref(c)}: both firstName and lastName empty`); ok = false; }
  if (ok) pass(cat);
}

function checkTypes(c) {
  const cat = 'Field types';
  let ok = true;
  if (c.totalJobs !== undefined && (typeof c.totalJobs !== 'number' || c.totalJobs < 0))
    { warn(cat, `${ref(c)}: totalJobs=${JSON.stringify(c.totalJobs)} (expected number ≥ 0)`); ok = false; }
  if (c.lifetimeSpend !== undefined && (typeof c.lifetimeSpend !== 'number' || c.lifetimeSpend < 0))
    { warn(cat, `${ref(c)}: lifetimeSpend=${JSON.stringify(c.lifetimeSpend)} (expected number ≥ 0)`); ok = false; }
  if (c.jobHistory !== undefined && !Array.isArray(c.jobHistory))
    { fail(cat, `${ref(c)}: jobHistory is ${typeof c.jobHistory}, expected array`); ok = false; }
  if (c.scheduledStatus !== undefined && (typeof c.scheduledStatus !== 'object' || Array.isArray(c.scheduledStatus)))
    { fail(cat, `${ref(c)}: scheduledStatus is not an object`); ok = false; }
  if (ok) pass(cat);
}

function checkScheduledStatus(c) {
  const cat = 'scheduledStatus';
  const ss = c.scheduledStatus;
  if (!ss) { pass(cat); return; }

  let ok = true;
  if (ss.state && !VALID_SS_STATES.has(ss.state))
    { warn(cat, `${ref(c)}: unknown state="${ss.state}"`); ok = false; }
  if (ss.state === 'completed' && !ss.completedAt)
    { fail(cat, `${ref(c)}: state='completed' but completedAt missing`); ok = false; }
  if (ss.completedAt && !isValidIso(ss.completedAt))
    { fail(cat, `${ref(c)}: completedAt="${ss.completedAt}" is not a valid ISO string`); ok = false; }
  if (ss.scheduledDate && !isValidDate(ss.scheduledDate))
    { warn(cat, `${ref(c)}: scheduledDate="${ss.scheduledDate}" is not YYYY-MM-DD`); ok = false; }
  if (ok) pass(cat);
}

function checkJobHistory(c) {
  const cat = 'jobHistory';
  const jh = c.jobHistory;
  if (!jh || jh.length === 0) { pass(cat); return; }

  let ok = true;
  jh.forEach((j, i) => {
    const loc = `${ref(c)} jh[${i}]`;
    if (!j.date)
      { warn(cat, `${loc}: date missing`); ok = false; }
    else if (!isValidDate(j.date))
      { fail(cat, `${loc}: date="${j.date}" is not valid YYYY-MM-DD`); ok = false; }
    else if (isFuture(j.date))
      { warn(cat, `${loc}: date="${j.date}" is in the future`); ok = false; }

    if (j.amount === undefined || j.amount === null)
      { warn(cat, `${loc}: amount missing`); ok = false; }
    else if (typeof j.amount !== 'number' || j.amount < 0)
      { warn(cat, `${loc}: amount=${JSON.stringify(j.amount)} (expected number ≥ 0)`); ok = false; }

    if (j.source && !VALID_JH_SOURCES.has(j.source))
      { warn(cat, `${loc}: unknown source="${j.source}"`); ok = false; }
  });
  if (ok) pass(cat);
}

function checkPaymentMethod(c) {
  const cat = 'preferredPaymentMethod';
  const pm = c.preferredPaymentMethod;
  if (!pm) { pass(cat); return; }

  const norm = pm.toLowerCase();
  if (!VALID_PAYMENT_METHODS_NORM.has(norm))
    { warn(cat, `${ref(c)}: unrecognised value "${pm}"`); return; }
  if (norm !== pm)
    { warn(cat, `${ref(c)}: wrong case "${pm}" (should be "${norm}")`); return; }
  pass(cat);
}

function checkDateSanity(c) {
  const cat = 'Date sanity';
  let ok = true;
  const cs = c.customerSince;
  const fsd = c.firstServiceDate;
  const ls = c.lastService;

  if (cs && !isValidDate(cs) && !isValidIso(cs))
    { warn(cat, `${ref(c)}: customerSince="${cs}" unparseable`); ok = false; }
  if (fsd && !isValidDate(fsd) && !isValidIso(fsd))
    { warn(cat, `${ref(c)}: firstServiceDate="${fsd}" unparseable`); ok = false; }
  if (ls && !isValidDate(ls) && !isValidIso(ls))
    { warn(cat, `${ref(c)}: lastService="${ls}" unparseable`); ok = false; }

  // Order: customerSince ≤ firstServiceDate ≤ lastService
  if (cs && fsd && new Date(cs) > new Date(fsd))
    { warn(cat, `${ref(c)}: customerSince (${cs}) > firstServiceDate (${fsd})`); ok = false; }
  if (fsd && ls && new Date(fsd) > new Date(ls))
    { warn(cat, `${ref(c)}: firstServiceDate (${fsd}) > lastService (${ls})`); ok = false; }

  if (ok) pass(cat);
}

function checkTotalJobsSync(c) {
  const cat = 'totalJobs vs jobHistory';
  const jh = c.jobHistory || [];
  const total = c.totalJobs ?? 0;
  // Only warn if there are no jobHistory entries but totalJobs > 0 AND it's not a backfill customer
  // (post-backfill, jobHistory is the source of truth — this is informational)
  if (total > 0 && jh.length === 0)
    { warn(cat, `${ref(c)}: totalJobs=${total} but jobHistory is empty`); }
  else
    pass(cat);
}

// ── Uniqueness checks (whole-DB) ──────────────────────────────────────────
function checkUniqueness(customers) {
  const cat = 'Unique phones';
  const seen = new Map();
  let dupes = 0;
  for (const c of customers) {
    // Normalize to digits-only for comparison
    const raw = (c.phone || '').trim();
    const ph  = raw.replace(/\D/g, '');
    if (!ph || REFERRAL_PHONE_RE.test(raw)) continue;
    if (seen.has(ph)) {
      fail(cat, `Duplicate phone ${raw}: ${ref(seen.get(ph))} and ${ref(c)}`);
      dupes++;
    } else {
      seen.set(ph, c);
    }
  }
  if (dupes === 0) pass(cat);
  return seen.size;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔍  Pure Cleaning — Database Integrity Check');
  if (AUTO_FIX) console.log('    Mode: AUTO-FIX (case normalization only)');

  let customers;
  try {
    customers = await fetchCustomers();
  } catch (e) {
    console.error('❌  Failed to fetch customers:', e.message);
    process.exit(1);
  }

  const referralCount = customers.filter(c => REFERRAL_PHONE_RE.test(c.phone || '')).length;
  console.log(`    Customers: ${customers.length.toLocaleString()} (${referralCount} referral placeholders)\n`);

  // Per-record assertions
  const fixes = [];
  for (const c of customers) {
    checkRequired(c);
    checkTypes(c);
    checkScheduledStatus(c);
    checkJobHistory(c);
    checkPaymentMethod(c);
    checkDateSanity(c);
    checkTotalJobsSync(c);

    if (AUTO_FIX) {
      const patch = autoFixRecord(c);
      if (patch) fixes.push({ c, patch });
    }
  }

  // Whole-DB assertions
  const uniquePhoneCount = checkUniqueness(customers);

  // Print per-category results (Unique phones included — no special-casing)
  for (const [name, { fails, warns, pass: p }] of Object.entries(categories)) {
    const total = fails.length + warns.length + p;
    const suffix = name === 'Unique phones' && !fails.length
      ? ` (${uniquePhoneCount.toLocaleString()} unique non-referral phones)`
      : '';
    if (!fails.length && !warns.length) {
      console.log(`✅  ${name}: ${p.toLocaleString()}/${total.toLocaleString()}${suffix}`);
    } else {
      if (fails.length) {
        console.log(`❌  ${name}: ${fails.length} failure${fails.length > 1 ? 's' : ''}, ${warns.length} warning${warns.length > 1 ? 's' : ''}`);
        fails.slice(0, 10).forEach(f => console.log(`    ✗ ${f}`));
        if (fails.length > 10) console.log(`    … and ${fails.length - 10} more`);
      } else {
        console.log(`⚠️   ${name}: ${warns.length} warning${warns.length > 1 ? 's' : ''}`);
        warns.slice(0, 10).forEach(w => console.log(`    ⚠ ${w}`));
        if (warns.length > 10) console.log(`    … and ${warns.length - 10} more`);
      }
    }
  }

  // Auto-fix application
  if (AUTO_FIX && fixes.length) {
    console.log(`\n🔧  Applying ${fixes.length} safe fix${fixes.length > 1 ? 'es' : ''}…`);
    for (const { c, patch } of fixes) await pushFix(c, patch);
  } else if (AUTO_FIX) {
    console.log('\n✅  No auto-fixable issues found.');
  }

  // Summary
  const totalChecked = totalFails + totalWarns + totalPass;
  console.log('\n' + '─'.repeat(60));
  console.log(`    Total assertions: ${totalChecked.toLocaleString()}`);
  console.log(`    ${totalPass.toLocaleString()} pass · ${totalWarns.toLocaleString()} warn · ${totalFails.toLocaleString()} fail`);

  if (totalFails > 0) {
    console.log('\n🚨  Integrity check FAILED');
    process.exit(1);
  } else if (totalWarns > 0) {
    console.log('\n⚠️   Integrity check passed with warnings');
    process.exit(0);
  } else {
    console.log('\n🟢  Integrity check clean');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('integrity-check crashed:', e);
  process.exit(1);
});
