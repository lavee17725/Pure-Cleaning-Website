"""
correct_may11_15_completedat_from_gps.py — ONE-SHOT, DO NOT RE-RUN

Replaces the 21:00 UTC fallback timestamps written by Phase 3
(backfill_may11_15_completedat.py) with GPS-derived actualDeparture
timestamps from the Phase 4 Bouncie validation matcher run.

BACKGROUND:
Phase 3 backfill used scheduledDate + 21:00 UTC (17:00 ET) as a fallback
for 7 records without Bouncie data. Phase 4 validation revealed those
fallbacks were 2-5 hours late — GPS showed trucks departing job sites
between 16:05-18:40 UTC (12:05-2:40 PM ET).

The matcher ran for all 5 dates in parallel during Phase 4, causing a
full-blob write race condition: each parallel date read the same KV
snapshot, modified its own customers, and wrote the full blob back. The
last write won, silently dropping GPS data written by earlier parallel
writes for 3 customers (Andreina Garcia, Debra Pashley, Nidia Tesoriero).

The GPS departure values were captured from Phase 4 report output before
the race condition erased them from KV. They are ground truth from
matched_high results at 27-151 ft proximity — not guesses.

THIS SCRIPT runs sequentially (one full GET→modify→PUT→verify per customer)
to avoid the parallel race condition that affected Phase 4 matcher writes.
Sequential is the safe pattern for full-blob KV writes. Parallel is not.

GPS timestamps used (from Phase 4 matcher report):
  Tanner Huysman  (May 11 rig_3): GPS dep 2026-05-11T17:27:28Z (+3.5h vs fallback)
  Blanca Rapalo   (May 11 rig_1): GPS dep 2026-05-11T18:40:41Z (+2.3h vs fallback)
  Andreina Garcia (May 12 rig_1): GPS dep 2026-05-12T17:06:52Z (+3.9h vs fallback)
  Debra Pashley   (May 12 rig_3): GPS dep 2026-05-12T16:05:17Z (+4.9h vs fallback)
  Amy Caress      (May 14 rig_2): GPS dep 2026-05-14T17:01:35Z (+4.0h vs fallback)
  Nidia Tesoriero (May 15 rig_1): GPS dep 2026-05-15T17:26:23Z (+3.6h vs fallback)

Excluded: Bill Brant (May 11 rig_2) — geocode failed during Phase 4 due to
  missing zip code on customer record. Left at 21:00 UTC fallback until
  zip is added and matcher re-runs naturally.

Both scheduledStatus.completedAt and the jobHistory[] entry created by Phase 3
(source='backfill_may11_15') are updated on each record.

Pre-run snapshot: customer_db_backup_2026-05-17T17-22-54 (1244 customers)
Run result: 6/6 written and verified (May 17 2026).
"""

import subprocess, json, re, time, tempfile, os

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

def get_all():
    return json.loads(subprocess.check_output([
        'curl','-s','-H',f'Authorization: Bearer {token}',
        'https://purecleaning-api.tylerfumero.workers.dev/customers']))

def put_all(customers):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        json.dump({'customers': customers}, f)
        fpath = f.name
    resp = json.loads(subprocess.check_output([
        'curl','-s','-X','PUT',
        '-H',f'Authorization: Bearer {token}',
        '-H','Content-Type: application/json',
        '-d',f'@{fpath}',
        'https://purecleaning-api.tylerfumero.workers.dev/customers']))
    os.unlink(fpath)
    return resp

def get_one(phone):
    r = json.loads(subprocess.check_output([
        'curl','-s','-H',f'Authorization: Bearer {token}',
        f'https://purecleaning-api.tylerfumero.workers.dev/customer/{phone}']))
    return r.get('customer', r)

norm = lambda p: (p or '').replace('+','').replace('-','').replace(' ','').replace('(','').replace(')','')[-10:]

# ── GPS-derived corrections (from Phase 4 matcher report) ────────────────────
# Bill Brant excluded — geocode failure, needs zip on customer record first
CORRECTIONS = [
    ("8632271269","Tanner Huysman",  "2026-05-11","2026-05-11T17:27:28.000Z"),
    ("7543084514","Blanca Rapalo",   "2026-05-11","2026-05-11T18:40:41.000Z"),
    ("9545367977","Andreina Garcia", "2026-05-12","2026-05-12T17:06:52.000Z"),
    ("9546322420","Debra Pashley",   "2026-05-12","2026-05-12T16:05:17.000Z"),
    ("9545510632","Amy Caress",      "2026-05-14","2026-05-14T17:01:35.000Z"),
    ("3054694930","Nidia Tesoriero", "2026-05-15","2026-05-15T17:26:23.000Z"),
]

# ── Step 1: Snapshot ──────────────────────────────────────────────────────────
print("Taking pre-write snapshot...")
snap = json.loads(subprocess.check_output([
    'curl','-s','-X','POST',
    'https://purecleaning-api.tylerfumero.workers.dev/import/snapshot',
    '-H',f'Authorization: Bearer {token}',
    '-H','Content-Type: application/json',
]))
print(f"  Snapshot: {snap.get('key')}  ({snap.get('customerCount')} customers)")
if not snap.get('success'):
    raise SystemExit("Snapshot failed — aborting")

# ── Step 2: Sequential GET→modify→PUT→verify per customer ────────────────────
# IMPORTANT: sequential, not parallel. Parallel full-blob KV writes race —
# the last write wins and silently drops other writers' changes.
results = []

for phone, name, date, gps_dep in CORRECTIONS:
    print(f"\n[{name}]")

    db = get_all()
    customers = db.get('customers', [])
    c = next((x for x in customers if norm(x.get('phone','')) == phone), None)
    if not c:
        print(f"  NOT FOUND — skipping")
        results.append({'name':name,'status':'NOT_FOUND'})
        continue

    ss = c.get('scheduledStatus') or {}
    old_ss = ss.get('completedAt')
    jh_entry = next((j for j in (c.get('jobHistory') or [])
        if j.get('source') == 'backfill_may11_15' and j.get('date') == date), None)
    old_jh = jh_entry.get('completedAt') if jh_entry else 'NO_ENTRY'

    ss['completedAt'] = gps_dep
    c['scheduledStatus'] = ss
    if jh_entry:
        jh_entry['completedAt'] = gps_dep

    print(f"  ss.completedAt: {old_ss}  →  {gps_dep}")
    print(f"  jh.completedAt: {old_jh}  →  {gps_dep if jh_entry else '(no backfill entry)'}")

    resp = put_all(customers)
    if not resp.get('success'):
        print(f"  PUT FAILED: {resp}")
        results.append({'name':name,'status':'PUT_FAILED'})
        continue

    c2 = get_one(phone)
    ss2 = c2.get('scheduledStatus') or {}
    jh2 = next((j for j in (c2.get('jobHistory') or [])
        if j.get('source') == 'backfill_may11_15' and j.get('date') == date), None)

    ss_ok = ss2.get('completedAt') == gps_dep
    jh_ok = (jh2.get('completedAt') == gps_dep) if jh2 else (jh_entry is None)
    ok = ss_ok and jh_ok

    print(f"  verify ss: {ss2.get('completedAt')}  {'✓' if ss_ok else '✗'}")
    print(f"  verify jh: {jh2.get('completedAt') if jh2 else 'NO_ENTRY'}  {'✓' if jh_ok else '✗'}")
    print(f"  → {'PASS' if ok else 'FAIL'}")

    results.append({'name':name,'status':'OK' if ok else 'FAIL'})
    time.sleep(0.2)

# ── Summary ───────────────────────────────────────────────────────────────────
print("\n" + "="*50)
passed = sum(1 for r in results if r['status'] == 'OK')
print(f"RESULT: {passed}/{len(results)} passed")
for r in results:
    print(f"  {'✓' if r['status']=='OK' else '✗'} {r['name']}")
