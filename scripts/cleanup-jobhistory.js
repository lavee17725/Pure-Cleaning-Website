#!/usr/bin/env node
/**
 * cleanup-jobhistory.js — One-time Class A/B/C jobHistory cleanup
 *
 * Class A: Remove 15 csv_backfill ghost entries that collide with active scheduled jobs
 * Class B: Remove 7 duplicate completion pairs (keep real calendar_completion, delete csv_backfill)
 * Class C: Backfill source:'calendar_completion' on remaining undefined-source completed entries
 *
 * SAFETY: Snapshot must be taken before running this script.
 * Run: node scripts/cleanup-jobhistory.js [--dry-run] [--commit]
 *   --dry-run  (default) Show what WOULD change, no writes
 *   --commit   Actually write changes to KV
 */

const { getVerifyToken } = require('./lib/auto-auth');

const API    = 'https://purecleaning-api.tylerfumero.workers.dev';
const ORIGIN = 'https://purecleaningpressurecleaning.com';

const DRY_RUN = !process.argv.includes('--commit');
const MODE    = DRY_RUN ? '[DRY RUN]' : '[COMMIT]';

// ── Class A targets: phone → { scheduledDate, collisionJhDate }
const CLASS_A_TARGETS = {
  '9546877537': { name: 'Darin & Jessica Karp',      schedDate: '2026-05-07' },
  '9545474309': { name: 'Yolanda Armalen',            schedDate: '2026-05-13' },
  '9543041313': { name: 'Carl Casagrande',            schedDate: '2026-05-12' },
  '9546297618': { name: 'Angel Junguera',             schedDate: '2026-05-28' },
  '9548823339': { name: 'Lissette Lorenzo',           schedDate: '2026-05-07' },
  '8632271269': { name: 'Tanner Huysman',             schedDate: null, jhDate: '2026-05-07' }, // near-date
  '7543084514': { name: 'Blanca Rapalo',              schedDate: '2026-05-11' },
  '9545933959': { name: 'Bill Brant',                 schedDate: '2026-05-11' },
  '9544945616': { name: 'Felicia & Richard Schwartz', schedDate: '2026-05-11' },
  '9545367977': { name: 'Andreina Garcia',            schedDate: '2026-05-12' },
  '9546322420': { name: 'Debra Pashley',              schedDate: '2026-05-12' },
  '3053210132': { name: 'Oscar Perez',                schedDate: '2026-05-13' },
  '9545510632': { name: 'Amy Caress',                 schedDate: '2026-05-14' },
  '3054694930': { name: 'Nidia Tesoriero',            schedDate: '2026-05-15' },
  '9543268175': { name: 'Cara',                       schedDate: '2026-05-06' },
};

// ── Class B targets: phone → instructions
const CLASS_B_TARGETS = {
  '9542493300': { name: 'Kristina Seeber',         date: '2026-05-05', amount: 300,  deleteSource: 'csv_backfill', alsoDeleteSecondMissing: true },
  '9546843614': { name: 'Keith Wolf',              date: '2026-05-06', amount: 375,  deleteSource: 'csv_backfill' },
  '9548259696': { name: 'Maria Correnti',          date: '2026-05-04', amount: 450,  deleteSource: 'csv_backfill' },
  '9542604048': { name: 'Keith Beckler',           date: '2026-05-04', amount: 100,  deleteSource: 'csv_backfill' },
  '9548183338': { name: 'Tara & Aldo Rodriguez',   date: '2026-05-05', amount: 350,  deleteSource: 'csv_backfill' },
  '9546326630': { name: 'Jim New',                 date: '2026-05-06', amount: 1700, deleteSource: 'csv_backfill' },
};

function log(...args) { console.log(...args); }
function warn(...args) { console.warn('  ⚠️ ', ...args); }

function descWords(s) {
  return new Set((s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>2));
}
function descSim(a, b) {
  const sa = descWords(a), sb = descWords(b);
  const inter = [...sa].filter(w=>sb.has(w)).length;
  const union = new Set([...sa,...sb]).size;
  return union ? inter/union : 0;
}

async function main() {
  log(`\n🧹  jobHistory cleanup  ${MODE}`);
  log('─'.repeat(60));
  if (DRY_RUN) log('  Pass --commit to write changes. This run is read-only.\n');

  const auth = await getVerifyToken();
  if (!auth) { console.error('No auth — check .env.local'); process.exit(1); }

  // Pull full DB
  const r = await fetch(`${API}/customers`, {
    headers: { Authorization: `Bearer ${auth.token}`, Origin: ORIGIN }
  });
  if (!r.ok) { console.error('GET /customers failed:', r.status); process.exit(1); }
  const db = await r.json();
  const customers = db.customers || [];
  log(`  Loaded ${customers.length} customers from DB\n`);

  let classADeleted = 0, classBDeleted = 0, classCPatched = 0;
  const changeLog = [];

  for (const c of customers) {
    if (c.deleted) continue;
    const phone = c.phone;
    const jh    = c.jobHistory || [];
    const ss    = c.scheduledStatus || {};
    let modified = false;

    // ── CLASS A ───────────────────────────────────────────────────────────
    const aTarget = CLASS_A_TARGETS[phone];
    if (aTarget) {
      const targetDate = aTarget.jhDate || aTarget.schedDate; // use explicit jhDate for Tanner
      const before = jh.length;

      // Find the csv_backfill entry to delete: matches targetDate, source=csv_backfill
      const toDelete = jh.filter(j =>
        j.source === 'csv_backfill' &&
        j.date === targetDate
      );

      if (toDelete.length === 0) {
        warn(`Class A — ${aTarget.name}: no matching csv_backfill entry on ${targetDate} (may already be clean)`);
      } else if (toDelete.length > 1) {
        warn(`Class A — ${aTarget.name}: ${toDelete.length} csv_backfill entries on ${targetDate} — deleting all`);
      }

      if (toDelete.length > 0) {
        const toDeleteSet = new Set(toDelete.map(j => j.jobId || JSON.stringify({d:j.date,s:j.source,svc:j.services})));
        c.jobHistory = jh.filter(j => {
          const key = j.jobId || JSON.stringify({d:j.date,s:j.source,svc:j.services});
          return !toDeleteSet.has(key);
        });
        toDelete.forEach(j => {
          const msg = `Deleted csv_backfill entry for ${aTarget.name} (${phone}) dated ${j.date} — "${(j.services||'').slice(0,60)}"`;
          log(`  ✂️  Class A: ${msg}`);
          changeLog.push(msg);
          classADeleted++;
        });
        modified = true;
      }
    }

    // ── CLASS B ───────────────────────────────────────────────────────────
    const bTarget = CLASS_B_TARGETS[phone];
    if (bTarget) {
      const { date, amount, deleteSource, alsoDeleteSecondMissing } = bTarget;

      // Find the csv_backfill entry to delete
      const csvEntry = c.jobHistory.find(j =>
        j.source === deleteSource &&
        j.date === date &&
        Math.abs((j.amount||0) - amount) <= 5
      );

      if (csvEntry) {
        const key = csvEntry.jobId || JSON.stringify({d:csvEntry.date,s:csvEntry.source,a:csvEntry.amount});
        c.jobHistory = c.jobHistory.filter(j => {
          const k = j.jobId || JSON.stringify({d:j.date,s:j.source,a:j.amount});
          return k !== key;
        });
        const msg = `Deleted ${deleteSource} entry for ${bTarget.name} (${phone}) dated ${date} $${amount}`;
        log(`  ✂️  Class B: ${msg}`);
        changeLog.push(msg);
        classBDeleted++;
        modified = true;
      } else {
        warn(`Class B — ${bTarget.name}: no ${deleteSource} entry on ${date} $${amount} found (may already be clean)`);
      }

      // Seeber special case: also delete second MISSING-source entry
      if (alsoDeleteSecondMissing) {
        const missingEntries = c.jobHistory
          .filter(j => !j.source && j.date === date && Math.abs((j.amount||0) - amount) <= 5)
          .sort((a, b) => (a.jobId||'').localeCompare(b.jobId||'')); // earlier jobId = keep

        if (missingEntries.length >= 2) {
          const toRemove = missingEntries[missingEntries.length - 1]; // keep first, remove last
          const key = toRemove.jobId || JSON.stringify({d:toRemove.date,s:toRemove.source,a:toRemove.amount,c:toRemove.completedAt});
          c.jobHistory = c.jobHistory.filter(j => {
            const k = j.jobId || JSON.stringify({d:j.date,s:j.source,a:j.amount,c:j.completedAt});
            return k !== key;
          });
          const msg = `Deleted duplicate calendar_completion for Seeber (${phone}) dated ${date} — kept earlier jobId`;
          log(`  ✂️  Class B (double-fire): ${msg}`);
          changeLog.push(msg);
          classBDeleted++;
          modified = true;
        } else if (missingEntries.length === 1) {
          log(`  ✓  Class B (Seeber double-fire): only 1 MISSING entry remains — already clean`);
        } else {
          warn(`Class B — Seeber: no MISSING-source entries on ${date} — already clean`);
        }
      }
    }

    // ── CLASS C ───────────────────────────────────────────────────────────
    // After A+B cleanup, backfill source on remaining undefined-source completed entries.
    // Only entries with hasJobId (written by _doCompleteJob) get patched.
    for (const j of (c.jobHistory || [])) {
      if (!j.source && j.status === 'completed' && j.jobId) {
        if (!DRY_RUN) {
          j.source = 'calendar_completion';
        }
        const msg = `Set source='calendar_completion' on ${(c.firstName||'')} ${(c.lastName||'')} (${phone}) entry ${j.date}`;
        log(`  🏷️  Class C: ${msg}${DRY_RUN ? ' [dry]' : ''}`);
        changeLog.push(msg);
        classCPatched++;
        modified = true;
      }
    }
  }

  log(`\n${'─'.repeat(60)}`);
  log(`  Class A deleted:  ${classADeleted}  (csv_backfill ghost entries)`);
  log(`  Class B deleted:  ${classBDeleted}  (duplicate completion entries)`);
  log(`  Class C patched:  ${classCPatched}  (source field backfilled)`);
  log(`  Total changes:    ${classADeleted + classBDeleted + classCPatched}`);

  if (DRY_RUN) {
    log(`\n  Dry run complete — no changes written.`);
    log(`  Re-run with --commit to apply.\n`);
    return;
  }

  // ── Write back ───────────────────────────────────────────────────────────
  log(`\n  Writing ${customers.length} customers back to KV...`);
  const put = await fetch(`${API}/customers`, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      Origin:         ORIGIN,
    },
    body: JSON.stringify({ customers }),
  });

  if (!put.ok) {
    const body = await put.text().catch(() => '');
    console.error(`\n❌  PUT /customers failed: HTTP ${put.status}  ${body.slice(0,200)}`);
    process.exit(1);
  }

  const putData = await put.json().catch(() => ({}));
  log(`  ✅  PUT /customers OK — ${putData.customerCount ?? customers.length} customers saved`);

  // ── Spot-check: re-read 3 affected customers ──────────────────────────────
  log(`\n  Spot-checking 3 affected customers...`);
  for (const phone of ['9546877537', '9542493300', '9546326630']) {
    const r2 = await fetch(`${API}/customer/${phone}`, {
      headers: { Authorization: `Bearer ${auth.token}`, Origin: ORIGIN }
    });
    if (!r2.ok) { warn(`Could not re-read ${phone}: HTTP ${r2.status}`); continue; }
    const { customer: c2 } = await r2.json();
    const jhAfter = (c2.jobHistory || []);
    const ghostsRemain = jhAfter.filter(j =>
      j.source === 'csv_backfill' &&
      (CLASS_A_TARGETS[phone] || CLASS_B_TARGETS[phone]) &&
      (CLASS_A_TARGETS[phone]?.schedDate === j.date || CLASS_B_TARGETS[phone]?.date === j.date)
    );
    const undefinedSrc = jhAfter.filter(j => !j.source && j.status === 'completed');
    const name = `${c2.firstName||''} ${c2.lastName||''}`.trim();
    log(`  ${name} (${phone}): ${jhAfter.length} jh entries, ${ghostsRemain.length} collision entries remain, ${undefinedSrc.length} undefined-source remain`);
  }

  log(`\n✅  Cleanup complete.\n`);
  log('Change log:');
  changeLog.forEach(m => log('  •', m));
}

main().catch(e => { console.error('Cleanup crashed:', e); process.exit(1); });
