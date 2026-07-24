#!/usr/bin/env node
/* photo-scan — register NEW photos from website-assets/ into the D1 PhotoQueue.
 *
 * The 5.5GB website-assets/ folder is local + gitignored; the Worker can't read
 * it, so this runs locally when Tyler drops a new Drive batch. photoId is a
 * deterministic hash of the relative path, so the worker's INSERT-if-absent
 * makes this idempotent: rescan adds ONLY new files, existing rows (and their
 * tags/status) are untouched.
 *
 * Usage: npm run photo:scan   (or: node scripts/photo-scan.js)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT   = path.join(__dirname, '..', 'website-assets');
const API    = 'https://purecleaning-api.tylerfumero.workers.dev';
const ORIGIN = 'https://purecleaningpressurecleaning.com';
const IMG_EXT = new Set(['.heic', '.jpg', '.jpeg', '.png']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;                 // .DS_Store etc.
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (IMG_EXT.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

// Weak auto-inference from the path (investigation: city ≈ 0% auto, service ~2%;
// the web grid does the real tagging — this is just a head start).
function inferService(rel) {
  const s = rel.toLowerCase();
  if (/\broof\b/.test(s))            return 'roof';
  if (/seal|sand/.test(s))           return 'seal';
  if (/driveway/.test(s))            return 'driveway';
  if (/patio|pool\s*deck/.test(s))   return 'patio';
  return null;
}
function inferType(rel) {
  const s = rel.toLowerCase();
  // Only trust an explicit "before"/"after" token in the filename, not the
  // umbrella "before-after" folder (which holds both).
  const base = path.basename(s);
  if (/\bbefore\b/.test(base)) return 'before';
  if (/\bafter\b/.test(base))  return 'after';
  return 'general';
}
function inferBatchDate(rel) {
  const m = rel.match(/(20\d{2})(0[1-9]|1[0-2])([0-3]\d)/);   // drive-download-YYYYMMDD…
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function getToken() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const pw = fs.readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('ADMIN_PASSWORD='))?.split('=')[1]?.trim();
  if (!pw) throw new Error('ADMIN_PASSWORD not found in .env.local');
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    body: JSON.stringify({ password: pw }),
  });
  const d = await r.json();
  if (!d.token) throw new Error('login failed');
  return d.token;
}

(async () => {
  if (!fs.existsSync(ROOT)) { console.error('website-assets/ not found at', ROOT); process.exit(1); }
  console.log('Scanning', ROOT, '…');
  const files = walk(ROOT);
  console.log(`Found ${files.length} image files.`);

  const photos = files.map(full => {
    const rel = path.relative(ROOT, full);
    return {
      photoId:    crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16),
      sourcePath: rel,
      ext:        path.extname(full).slice(1).toLowerCase(),
      batchDate:  inferBatchDate(rel),
      service:    inferService(rel),
      photoType:  inferType(rel),
    };
  });

  const token = await getToken();
  const CHUNK = 500;
  let added = 0, skipped = 0;
  for (let i = 0; i < photos.length; i += CHUNK) {
    const batch = photos.slice(i, i + CHUNK);
    const r = await fetch(`${API}/admin/photo-queue/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN, 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ photos: batch }),
    });
    const d = await r.json();
    if (!r.ok || !d.success) { console.error('  batch failed:', d.error || r.status); process.exit(1); }
    added += d.added; skipped += d.skipped;
    process.stdout.write(`  ${Math.min(i + CHUNK, photos.length)}/${photos.length}\r`);
  }
  console.log(`\nDone. Added ${added} new, ${skipped} already-known (untouched).`);
})();
