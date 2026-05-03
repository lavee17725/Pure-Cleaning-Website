// migrate.js — JSONbin → Cloudflare KV migration
import fs from 'fs/promises';
import path from 'path';

const JSONBIN_MASTER_KEY = '$2a$10$CPlkZPaDq7IChEHDKrwWBeF5ltP4WsR1XQgcachhQUdf2Penp7f/i';
const WORKER_URL = 'https://purecleaning-api.tylerfumero.workers.dev';
const BACKUP_DIR = `./backups/${new Date().toISOString().split('T')[0]}`;

const BINS = [
  {
    name: 'customers',
    binId: '69f2d8b6856a6821898c3bfb',
    workerPath: '/customers',
    arrayField: 'customers'
  },
  {
    name: 'incoming',
    binId: '69f39ce0856a682189900bdc',
    workerPath: '/incoming',
    arrayField: 'requests'
  },
  {
    name: 'events',
    binId: '69f41bfdaaba8821975a74fa',
    workerPath: '/events',
    arrayField: 'events'
  },
  {
    name: 'links',
    binId: '69f427af856a682189929e8c',
    workerPath: '/links',
    arrayField: 'links'
  }
];

async function migrate() {
  const startTime = Date.now();

  await fs.mkdir(BACKUP_DIR, { recursive: true });
  console.log(`Backup directory: ${path.resolve(BACKUP_DIR)}\n`);

  const results = [];

  for (const bin of BINS) {
    console.log(`=== Migrating ${bin.name} ===`);

    try {
      // 1. Fetch from JSONbin
      const jsonbinUrl = `https://api.jsonbin.io/v3/b/${bin.binId}/latest`;
      const response = await fetch(jsonbinUrl, {
        headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
      });

      if (!response.ok) {
        throw new Error(`JSONbin fetch failed: ${response.status} ${response.statusText}`);
      }

      const jsonbinData = await response.json();

      // 2. Backup raw response
      const backupPath = path.join(BACKUP_DIR, `${bin.name}.json`);
      await fs.writeFile(backupPath, JSON.stringify(jsonbinData, null, 2));
      console.log(`  Backup saved: ${backupPath}`);

      // 3. Extract payload
      const payload = jsonbinData.record;
      const sourceCount = payload[bin.arrayField]?.length ?? 0;
      console.log(`  Source: ${sourceCount} ${bin.arrayField}`);

      // 4. PUT to Worker
      const putResponse = await fetch(`${WORKER_URL}${bin.workerPath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!putResponse.ok) {
        const body = await putResponse.text();
        throw new Error(`Worker PUT failed: ${putResponse.status} — ${body}`);
      }

      // 5. GET back from Worker to verify
      const verifyResponse = await fetch(`${WORKER_URL}${bin.workerPath}`);
      if (!verifyResponse.ok) {
        throw new Error(`Worker GET verify failed: ${verifyResponse.status}`);
      }
      const verifyData = await verifyResponse.json();
      const targetCount = verifyData[bin.arrayField]?.length ?? 0;
      console.log(`  Target: ${targetCount} ${bin.arrayField}`);

      // 6. Compare counts
      if (sourceCount === targetCount) {
        console.log(`  PASS — ${sourceCount} entries migrated\n`);
        results.push({ name: bin.name, status: 'success', count: sourceCount });
      } else {
        console.log(`  MISMATCH — source ${sourceCount} vs target ${targetCount}\n`);
        results.push({ name: bin.name, status: 'mismatch', sourceCount, targetCount });
      }

    } catch (err) {
      console.error(`  FAILED — ${err.message}\n`);
      results.push({ name: bin.name, status: 'failed', error: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('=== MIGRATION SUMMARY ===');
  console.log(`Backups: ${path.resolve(BACKUP_DIR)}`);
  console.log(`Duration: ${elapsed}s\n`);

  for (const r of results) {
    if (r.status === 'success') {
      console.log(`  OK  ${r.name}: ${r.count} entries`);
    } else if (r.status === 'mismatch') {
      console.log(`  MISMATCH  ${r.name}: source ${r.sourceCount} vs target ${r.targetCount}`);
    } else {
      console.log(`  FAIL  ${r.name}: ${r.error}`);
    }
  }

  const allGood = results.every(r => r.status === 'success');
  console.log(`\n${allGood ? 'ALL BINS MIGRATED SUCCESSFULLY' : 'MIGRATION HAS ISSUES — REVIEW ABOVE'}`);

  if (!allGood) process.exit(1);
}

migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
