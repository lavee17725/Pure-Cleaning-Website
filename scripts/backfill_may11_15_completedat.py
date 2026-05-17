"""
backfill_may11_15_completedat.py — ONE-SHOT, DO NOT RE-RUN

Backfills scheduledStatus.completedAt and a synthetic jobHistory[] entry
for 10 KV customer records completed May 11-15 2026 that were missing
completedAt due to a cached pre-May-8 calendar build.

Root cause (Phase 1 of 4 diagnostic, May 17 2026):
  _doCompleteJob only wrote completedAt to jobHistory[].completedAt, not to
  scheduledStatus.completedAt. Jobs completed on devices with the May 7
  cached calendar got state='completed' but no timestamp anywhere accessible
  to the D1 migration, Bouncie matcher, review queue, or reactivation cooldowns.

Phase 2 fix (commit 9288a8e) added ss.completedAt to _doCompleteJob going
forward. This script backfills the 10 historical records.

Timestamp sources:
  Group A (3 records) — Bouncie GPS actualDeparture already on scheduledStatus
    from the May 16 bouncieJobDurationMatcher run.
  Group B (7 records) — scheduledDate + T21:00:00.000Z (17:00 ET, typical
    job-completion window).

Excluded:
  Carl Casagrande, Yolanda Armalen — rescheduled to 2026-05-18, not completed.
  Felicia Schwartz stale D1 row (May 11 rig_1) — KV already points to real
    May 13 rig_2 completion; stale D1 row left for Day 2 reconciliation.

Pre-run snapshot: customer_db_backup_2026-05-17T16-39-42 (1244 customers)
Run result: 10/10 written and verified (May 17 2026).
"""

import subprocess, json, re, math

# ── Auth ──────────────────────────────────────────────────────────────────────
pw = re.search(r'ADMIN_PASSWORD=(.+)',
    open('/Users/tylerfumero/Pure-Cleaning-Website/.env.local').read()
).group(1).strip()

token = json.loads(subprocess.check_output([
    'curl','-s','-X','POST',
    'https://purecleaning-api.tylerfumero.workers.dev/auth/login',
    '-H','Content-Type: application/json',
    '-d', json.dumps({'password': pw}),
]))['token']

def curl_get(url):
    return json.loads(subprocess.check_output([
        'curl','-s','-H', f'Authorization: Bearer {token}', url]))

def curl_put_file(url, filepath):
    return json.loads(subprocess.check_output([
        'curl','-s','-X','PUT',
        '-H', f'Authorization: Bearer {token}',
        '-H', 'Content-Type: application/json',
        '-d', f'@{filepath}', url]))

# ── Working list ──────────────────────────────────────────────────────────────
# (phone_10digit, display_name, group, fallback_ts_or_None)
# Group A: completedAt = ss.actualDeparture (Bouncie GPS)
# Group B: completedAt = fallback_ts (scheduledDate + T21:00:00.000Z)
RECORDS = [
    ("9544945616", "Felicia Schwartz", "A", None),
    ("3053210132", "Oscar Perez",      "A", None),
    ("9548038318", "ED Mendez",        "A", None),
    ("8632271269", "Tanner Huysman",   "B", "2026-05-11T21:00:00.000Z"),
    ("7543084514", "Blanca Rapalo",    "B", "2026-05-11T21:00:00.000Z"),
    ("9545933959", "Bill Brant",       "B", "2026-05-11T21:00:00.000Z"),
    ("9545367977", "Andreina Garcia",  "B", "2026-05-12T21:00:00.000Z"),
    ("9546322420", "Debra Pashley",    "B", "2026-05-12T21:00:00.000Z"),
    ("9545510632", "Amy Caress",       "B", "2026-05-14T21:00:00.000Z"),
    ("3054694930", "Nidia Tesoriero",  "B", "2026-05-15T21:00:00.000Z"),
]

norm = lambda p: (p or '').replace('+','').replace('-','').replace(' ','').replace('(','').replace(')','')[-10:]

# ── Step 1: Snapshot ──────────────────────────────────────────────────────────
print("Taking pre-write snapshot...")
snap = json.loads(subprocess.check_output([
    'curl','-s','-X','POST',
    'https://purecleaning-api.tylerfumero.workers.dev/import/snapshot',
    '-H', f'Authorization: Bearer {token}',
    '-H', 'Content-Type: application/json',
]))
print(f"  Snapshot: {snap.get('key')}  ({snap.get('customerCount')} customers)")
if not snap.get('success'):
    raise SystemExit("Snapshot failed — aborting")

# ── Step 2: Load full DB ──────────────────────────────────────────────────────
print("Loading customer DB...")
db = curl_get('https://purecleaning-api.tylerfumero.workers.dev/customers')
customers = db.get('customers', [])
print(f"  Loaded {len(customers)} customers.")

# ── Step 3: Apply mutations in memory ────────────────────────────────────────
results = []
for phone, name, group, fallback_ts in RECORDS:
    c = next((x for x in customers if norm(x.get('phone','')) == phone), None)
    if not c:
        results.append({'phone': phone, 'name': name, 'status': 'NOT_FOUND'})
        continue

    ss = c.get('scheduledStatus') or {}
    completed_at = ss.get('actualDeparture') if group == 'A' else fallback_ts
    if group == 'A' and not completed_at:
        results.append({'phone': phone, 'name': name, 'status': 'SKIP_NO_BOUNCIE'})
        continue

    completed_date = ss.get('scheduledDate') or completed_at[:10]
    amount = ss.get('approvedAmount') or 0

    jh = c.get('jobHistory') or []
    duplicate = any(
        j.get('date') == completed_date and j.get('status') == 'completed'
        and abs((j.get('amount') or 0) - amount) <= 5
        for j in jh
    )
    if duplicate:
        results.append({'phone': phone, 'name': name, 'status': 'SKIP_DUPLICATE',
                        'detail': f'jobHistory for {completed_date} already exists'})
        continue

    jh_entry = {
        'jobId':       f"{phone}_{completed_date}_{math.floor(amount*100)}_backfill_may1115",
        'date':        completed_date,
        'services':    ss.get('jobNotes') or '',
        'amount':      amount,
        'rig':         ss.get('rig') or None,
        'rigId':       ss.get('rig') or None,
        'city':        c.get('city') or None,
        'address':     c.get('address') or None,
        'status':      'completed',
        'completedAt': completed_at,
        'crew':        ss.get('crew') or [],
        'source':      'backfill_may11_15',
        'roofStories': ss.get('roofStories') or None,
    }

    ss['completedAt'] = completed_at
    c['scheduledStatus'] = ss
    c.setdefault('jobHistory', []).append(jh_entry)

    results.append({
        'phone': phone, 'name': name, 'group': group, 'status': 'MODIFIED',
        'completedAt': completed_at, 'date': completed_date,
        'rig': ss.get('rig'), 'amount': amount,
        'ts_source': 'bouncie_actualDeparture' if group == 'A' else 'fallback_1700ET',
    })

modified = [r for r in results if r['status'] == 'MODIFIED']
print(f"\nApplying {len(modified)} modifications...")
for r in modified:
    print(f"  [{r['group']}] {r['name']:<25} {r['date']} {r['rig']:<8} {r['completedAt']} ({r['ts_source']})")

# ── Step 4: Write back ────────────────────────────────────────────────────────
payload_path = '/tmp/customers_backfill_may1115.json'
with open(payload_path, 'w') as f:
    json.dump({'customers': customers}, f)

resp = curl_put_file('https://purecleaning-api.tylerfumero.workers.dev/customers', payload_path)
if not resp.get('success'):
    raise SystemExit(f"PUT failed: {resp}")
print(f"\nPUT response: {resp}")

# ── Step 5: Verify ────────────────────────────────────────────────────────────
print("\nVerifying...")
any_fail = False
for r in modified:
    c2 = curl_get(f"https://purecleaning-api.tylerfumero.workers.dev/customer/{r['phone']}")
    c2 = c2.get('customer', c2)
    ss2 = c2.get('scheduledStatus') or {}
    jh2 = [j for j in (c2.get('jobHistory') or [])
           if j.get('date') == r['date'] and j.get('status') == 'completed']
    ok = ss2.get('completedAt') == r['completedAt'] and len(jh2) >= 1
    if not ok:
        any_fail = True
    print(f"  {'✓' if ok else '✗'} {r['name']:<25} ss.completedAt={ss2.get('completedAt','MISSING')} jh_entries={len(jh2)}")

print()
if any_fail:
    print("FAILURES DETECTED — investigate before committing")
else:
    print(f"All {len(modified)} records verified. Backfill complete.")
