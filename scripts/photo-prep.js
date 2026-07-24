#!/usr/bin/env node
/* photo-prep — generate the download-ready processed copy for scheduled photos.
 *
 * For each queued (scheduled) photo: sips HEIC/whatever → JPG, longest edge
 * ~2000px (GBP-friendly), re-encode drops most camera metadata. Uploads to R2
 * (gbp-processed/{photoId}.jpg) so the posting-day card can save it. The SEO
 * filename (set server-side by the scheduler) is the download name the card
 * offers. Local step — run after the scheduler assigns slots.
 *
 * GEOTAG SEAM (2026-07-24): geotag injection + full EXIF strip need `exiftool`,
 * which isn't installed. `injectGeotagAndStrip()` is a no-op today; the
 * city-center coords live server-side (_PQ_CITY_COORDS). If exiftool is ever
 * installed, fill in the one function below — nothing else changes.
 *
 * Usage: npm run photo:prep            (all queued, missing-processed)
 *        node scripts/photo-prep.js 6  (limit to N)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT   = path.join(__dirname, '..', 'website-assets');
const API    = 'https://purecleaning-api.tylerfumero.workers.dev';
const ORIGIN = 'https://purecleaningpressurecleaning.com';
const LIMIT  = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const TMP    = fs.mkdtempSync(path.join(os.tmpdir(), 'pcpc-prep-'));

// ── GEOTAG SEAM ──────────────────────────────────────────────────────────────
// No-op until exiftool is available. When it is, this becomes e.g.:
//   execFileSync('exiftool', ['-all=', `-GPSLatitude=${lat}`, `-GPSLongitude=${lng}`,
//     '-GPSLatitudeRef=N', '-GPSLongitudeRef=W', '-overwrite_original', jpgPath]);
// Coords come server-side from _PQ_CITY_COORDS keyed by the tagged city.
function injectGeotagAndStrip(/* jpgPath, city */) { /* seam — exiftool not installed */ }

async function getToken() {
  const pw = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split('\n').find(l => l.startsWith('ADMIN_PASSWORD='))?.split('=')[1]?.trim();
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    body: JSON.stringify({ password: pw }),
  });
  return (await r.json()).token;
}

(async () => {
  const token = await getToken();
  const auth = { 'Authorization': `Bearer ${token}`, 'Origin': ORIGIN };
  const listRes = await fetch(`${API}/admin/photo-queue?status=queued`, { headers: auth });
  const { photos } = await listRes.json();
  const todo = (photos || []).filter(p => !p.processedKey).slice(0, LIMIT);
  console.log(`Prepping ${todo.length} scheduled photos → R2…`);

  let ok = 0, fail = 0;
  for (const p of todo) {
    const src = path.join(ROOT, p.sourcePath);
    if (!fs.existsSync(src)) { fail++; continue; }
    const out = path.join(TMP, `${p.photoId}.jpg`);
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '2000', src, '-o', out], { stdio: 'ignore' });
      injectGeotagAndStrip(out, p.city);   // seam — no-op today
      const bytes = fs.readFileSync(out);
      const put = await fetch(`${API}/admin/photo-queue/processed/${p.photoId}`, {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: bytes,
      });
      if (put.ok) ok++; else fail++;
      fs.unlinkSync(out);
    } catch (e) { fail++; }
    process.stdout.write(`  ${ok + fail}/${todo.length}\r`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nDone. ${ok} processed → gbp-processed/, ${fail} failed/missing.`);
})();
