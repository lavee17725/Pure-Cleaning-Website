#!/usr/bin/env node
/* photo-thumb — generate + upload tagging-grid thumbnails for untagged photos.
 *
 * The originals are local HEIC/JPG the browser can't render. This makes a small
 * JPG (macOS `sips`, HEIC→JPG + downscale) per untagged photo and uploads it to
 * R2 (gbp-thumb/{photoId}.jpg) so the web tagging grid can show it. Local step,
 * run after photo:scan.
 *
 * Usage: npm run photo:thumb           (all untagged, missing-thumb only-ish)
 *        node scripts/photo-thumb.js 20   (limit to N — for a quick sample)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT   = path.join(__dirname, '..', 'website-assets');
const API    = 'https://purecleaning-api.tylerfumero.workers.dev';
const ORIGIN = 'https://purecleaningpressurecleaning.com';
const LIMIT  = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const TMP    = fs.mkdtempSync(path.join(os.tmpdir(), 'pcpc-thumb-'));

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

  const listRes = await fetch(`${API}/admin/photo-queue?status=untagged`, { headers: auth });
  const { photos } = await listRes.json();
  const todo = (photos || []).slice(0, LIMIT);
  console.log(`Thumbnailing ${todo.length} untagged photos → R2…`);

  let ok = 0, fail = 0;
  for (const p of todo) {
    const src = path.join(ROOT, p.sourcePath);
    if (!fs.existsSync(src)) { fail++; continue; }
    const out = path.join(TMP, `${p.photoId}.jpg`);
    try {
      // sips: HEIC/whatever → JPG, longest edge 500px (grid thumb).
      execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '500', src, '-o', out], { stdio: 'ignore' });
      const bytes = fs.readFileSync(out);
      const put = await fetch(`${API}/admin/photo-queue/thumb/${p.photoId}`, {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: bytes,
      });
      if (put.ok) ok++; else fail++;
      fs.unlinkSync(out);
    } catch (e) { fail++; }
    process.stdout.write(`  ${ok + fail}/${todo.length}\r`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nDone. ${ok} thumbnails uploaded, ${fail} failed/missing.`);
})();
