// cleanup-test-data.js — Remove test records before launch
// Run: node cleanup-test-data.js
// Requires confirmation before any deletion.

import readline from 'readline';
import fs from 'fs';
import path from 'path';

const WORKER_BASE = 'https://purecleaning-api.tylerfumero.workers.dev';
const BACKUP_DIR  = path.join(process.cwd(), 'backups', '2026-05-01');

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p || '—';
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function get(path) {
  const r = await fetch(`${WORKER_BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return r.json();
}

async function put(path, body) {
  const r = await fetch(`${WORKER_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} → HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Is a test record? ─────────────────────────────────────────────────────────
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

function isTestTarget(c) {
  const last  = (c.lastName  || '').toLowerCase().trim();
  const first = (c.firstName || '').toLowerCase().trim();

  const isFumero         = last === 'fumero';
  const isStephanieLeyva = first === 'stephanie' && last === 'leyva';
  if (!isFumero && !isStephanieLeyva) return false;

  // Safety filters — ALL must be true to qualify for deletion
  const noSpend      = !c.lifetimeSpend || c.lifetimeSpend === 0;
  const noJobs       = !c.totalJobs     || c.totalJobs === 0;
  const noService    = !c.lastService;
  const noJobHistory = !c.jobHistory    || c.jobHistory.length === 0;

  if (!noSpend || !noJobs || !noService || !noJobHistory) return false;

  // Records with a recent createdAt → clearly test records
  if (c.createdAt && new Date(c.createdAt) > THREE_DAYS_AGO) return true;

  // Records with NO createdAt AND no history → also test records.
  // Real customers from the CSV always have lifetimeSpend/totalJobs set.
  // A name-matching record with zero history and no createdAt was created manually during testing.
  if (!c.createdAt) return true;

  return false;
}

function isNameMatch(c) {
  const last  = (c.lastName  || '').toLowerCase().trim();
  const first = (c.firstName || '').toLowerCase().trim();
  return last === 'fumero' || (first === 'stephanie' && last === 'leyva');
}

function hasHistory(c) {
  return (c.lifetimeSpend && c.lifetimeSpend > 0)
      || (c.totalJobs     && c.totalJobs > 0)
      || !!c.lastService
      || (c.jobHistory    && c.jobHistory.length > 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  PURE CLEANING — TEST DATA CLEANUP       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── Step 1: Fetch customers ─────────────────────────────────────────────────
  console.log('⏳ Fetching customer DB from Worker…');
  const db = await get('/customers');
  const allCustomers = db.customers || [];
  console.log(`   Loaded ${allCustomers.length} customers.\n`);

  // ── Step 2: Classify ────────────────────────────────────────────────────────
  const toDelete   = allCustomers.filter(isTestTarget);
  const preserved  = allCustomers.filter(c => isNameMatch(c) && !isTestTarget(c) && hasHistory(c));
  const unclear    = allCustomers.filter(c => isNameMatch(c) && !isTestTarget(c) && !hasHistory(c));

  // ── Step 3: Pre-flight report ───────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`RECORDS TO DELETE (${toDelete.length}):`);
  if (toDelete.length === 0) {
    console.log('   (none found matching all safety criteria)');
  } else {
    toDelete.forEach((c, i) => {
      const created = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-US') : 'no createdAt';
      console.log(`   ${i+1}. ${c.firstName || '?'} ${c.lastName || '?'} — ${fmtPhone(c.phone)} — created ${created} — no history`);
    });
  }

  console.log('');
  console.log(`REAL CUSTOMERS PRESERVED (name matched but has history) (${preserved.length}):`);
  if (preserved.length === 0) {
    console.log('   (none)');
  } else {
    preserved.forEach(c => {
      console.log(`   ✓ ${c.firstName || '?'} ${c.lastName || '?'} — ${fmtPhone(c.phone)} — ${c.totalJobs||0} jobs, $${c.lifetimeSpend||0} lifetime`);
    });
  }

  // Count duplicates (same phone appears more than once in toDelete)
  const phoneCounts = {};
  toDelete.forEach(c => { phoneCounts[c.phone] = (phoneCounts[c.phone] || 0) + 1; });
  const dupePhones = Object.entries(phoneCounts).filter(([,n]) => n > 1);
  if (dupePhones.length > 0) {
    console.log('');
    console.log(`ℹ️  Duplicate phone numbers in deletion set (will all be removed):`);
    dupePhones.forEach(([ph, n]) => console.log(`   ${fmtPhone(ph)} appears ${n}× — all copies removed`));
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Total to delete:   ${toDelete.length}`);
  console.log(`Total preserved:   ${preserved.length}`);
  console.log(`Remaining after:   ${allCustomers.length - toDelete.length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (toDelete.length === 0) {
    console.log('Nothing to delete. Exiting.');
    process.exit(0);
  }

  // ── Step 4: Confirm ─────────────────────────────────────────────────────────
  const answer = await ask('Type YES to confirm deletion, NO to abort: ');
  if (answer.toUpperCase() !== 'YES') {
    console.log('\nAborted. No data was changed.');
    process.exit(0);
  }

  // ── Step 5: Backup ──────────────────────────────────────────────────────────
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, 'test-records-deleted.json');
  const backupPayload = {
    deletedAt:            new Date().toISOString(),
    deletionCriteria:     'lastName=fumero OR (firstName=stephanie AND lastName=leyva), no history, createdAt within 3 days',
    totalCustomersBefore: allCustomers.length,
    deletedRecords:       toDelete,
    preservedRealRecords: preserved,
    unclearRecords:       unclear,
  };
  fs.writeFileSync(backupPath, JSON.stringify(backupPayload, null, 2));
  console.log(`\n✅ Backup saved: ${backupPath}`);

  // ── Step 6: Delete from customer DB ─────────────────────────────────────────
  const deletedPhones = new Set(toDelete.map(c => c.phone));
  const cleanedCustomers = allCustomers.filter(c => !deletedPhones.has(c.phone));
  const cleanedDb = { ...db, customers: cleanedCustomers, lastUpdated: new Date().toISOString() };

  console.log(`\n⏳ Writing cleaned customer DB (${cleanedCustomers.length} records)…`);
  await put('/customers', cleanedDb);
  console.log('   ✅ Customer DB updated.');

  // ── Step 7: Clean /incoming ──────────────────────────────────────────────────
  console.log('\n⏳ Cleaning /incoming…');
  try {
    const incoming = await get('/incoming');
    const origRequests = incoming.requests || [];
    const cleanedRequests = origRequests.filter(r => {
      const phone = (r.customerData?.phone || r.phone || '').replace(/\D/g, '');
      return !deletedPhones.has(phone);
    });
    if (cleanedRequests.length < origRequests.length) {
      await put('/incoming', { ...incoming, requests: cleanedRequests });
      console.log(`   ✅ Removed ${origRequests.length - cleanedRequests.length} incoming request(s).`);
    } else {
      console.log('   ✓ No test records found in /incoming.');
    }
  } catch(e) {
    console.warn(`   ⚠️  Could not clean /incoming: ${e.message}`);
  }

  // ── Step 8: Clean /events ────────────────────────────────────────────────────
  console.log('\n⏳ Cleaning /events…');
  try {
    const events = await get('/events');
    const origEvents = events.events || [];
    const cleanedEvents = origEvents.filter(e => {
      const phone = (e.customerPhone || '').replace(/\D/g, '');
      return !deletedPhones.has(phone);
    });
    if (cleanedEvents.length < origEvents.length) {
      await put('/events', { ...events, events: cleanedEvents });
      console.log(`   ✅ Removed ${origEvents.length - cleanedEvents.length} event(s).`);
    } else {
      console.log('   ✓ No test events found in /events.');
    }
  } catch(e) {
    console.warn(`   ⚠️  Could not clean /events: ${e.message}`);
  }

  // ── Step 9: Clean quote KV entries ──────────────────────────────────────────
  console.log('\n⏳ Checking for quote KV entries tied to test records…');
  const quoteCodes = toDelete.flatMap(c => c.linkCode ? [c.linkCode] : []);
  if (quoteCodes.length > 0) {
    let deleted = 0;
    for (const code of quoteCodes) {
      try {
        const r = await fetch(`${WORKER_BASE}/quote/${code}`, { method: 'DELETE' });
        if (r.ok) { deleted++; console.log(`   ✅ Deleted /quote/${code}`); }
      } catch(e) { console.warn(`   ⚠️  Could not delete /quote/${code}: ${e.message}`); }
    }
    if (deleted === 0) console.log('   ✓ No quote entries found.');
  } else {
    console.log('   ✓ No linkCodes on deleted records — nothing to remove.');
  }

  // ── Step 10: Verify ──────────────────────────────────────────────────────────
  console.log('\n⏳ Verifying…');
  const verifyDb = await get('/customers');
  const verifyAll = verifyDb.customers || [];
  const remaining = verifyAll.filter(isNameMatch);

  console.log(`   Total customers now: ${verifyAll.length}`);
  if (remaining.length === 0) {
    console.log('   ✅ No test records remaining.');
  } else {
    console.log(`   ⚠️  ${remaining.length} name-matching record(s) still present (these were preserved intentionally):`);
    remaining.forEach(c => console.log(`      - ${c.firstName} ${c.lastName} ${fmtPhone(c.phone)}`));
  }

  // Spot-check 3 random customers
  console.log('\n   Spot-check (3 random records):');
  for (let i = 0; i < 3; i++) {
    const c = verifyAll[Math.floor(Math.random() * verifyAll.length)];
    console.log(`      ${c.firstName || '?'} ${c.lastName || '?'} | ${fmtPhone(c.phone)} | jobs:${c.totalJobs||0} | $${c.lifetimeSpend||0}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  CLEANUP COMPLETE                         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`   Records deleted:     ${toDelete.length}`);
  console.log(`   Real records kept:   ${preserved.length}`);
  console.log(`   Final customer count: ${verifyAll.length}`);
  console.log(`   Backup:              ${backupPath}`);
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
