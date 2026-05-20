#!/usr/bin/env python3
"""
Expanded audit — read-only.
1. Scheduled-date drift: KV scheduledStatus.scheduledDate vs D1 Job.scheduledDate
2. Missing jobHistory scope: completed scheduledStatus with no matching jh entry
"""

import json, subprocess, sys, re
from pathlib import Path
from collections import defaultdict

BASE_DIR     = Path(__file__).parent.parent
WRANGLER_CFG = str(BASE_DIR / "cloudflare-worker" / "wrangler.toml")
D1_DB_NAME   = "pure-cleaning-crm-v1"
API_BASE     = "https://purecleaning-api.tylerfumero.workers.dev"
ORIGIN       = "https://purecleaningpressurecleaning.com"

def curl_post(path, body, token=None):
    headers = ["-H", f"Origin: {ORIGIN}", "-H", "Content-Type: application/json"]
    if token:
        headers += ["-H", f"Authorization: Bearer {token}"]
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", f"{API_BASE}{path}"] + headers + ["-d", json.dumps(body)],
        capture_output=True, text=True
    )
    return json.loads(r.stdout)

def curl_get(path, token):
    r = subprocess.run(
        ["curl", "-s", f"{API_BASE}{path}",
         "-H", f"Origin: {ORIGIN}",
         "-H", f"Authorization: Bearer {token}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout)

def get_token():
    env_file = BASE_DIR / ".env.local"
    pw = ""
    for line in env_file.read_text().splitlines():
        if line.startswith("ADMIN_PASSWORD="):
            pw = line.split("=", 1)[1].strip()
    d = curl_post("/auth/login", {"password": pw})
    tok = d.get("token", "")
    if not tok:
        sys.exit(f"❌  Auth failed: {d}")
    return tok

def d1_query(sql):
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB_NAME,
         "--remote", "--config", WRANGLER_CFG, "--command", sql],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    if result.returncode != 0:
        print("D1 error:", result.stderr[:300])
        return []
    rows = re.findall(r'\{[^{}]+\}', result.stdout)
    out = []
    for r in rows:
        try:
            parsed = json.loads(r)
            if "sql_duration_ms" in parsed or "served_by" in parsed:
                continue
            out.append(parsed)
        except Exception:
            pass
    return out

def norm_phone(p):
    return re.sub(r'\D', '', p or '')[-10:]

def person_id(ph10):
    return f"person_1{ph10}"

def date_gap_days(d1, d2):
    """Return abs(d1 - d2) in days, or None if either is missing."""
    try:
        from datetime import date
        a = date.fromisoformat(d1[:10])
        b = date.fromisoformat(d2[:10])
        return abs((a - b).days)
    except Exception:
        return None

def main():
    print("Loading KV customers…")
    token = get_token()
    customers = curl_get("/customers", token).get("customers", [])
    print(f"  {len(customers)} customers\n")

    # ── Load ALL D1 completed jobs (non-csv, state=completed) ─────────────────
    print("Loading D1 completed non-csv jobs…")
    d1_jobs = d1_query(
        "SELECT jobId, payerId, scheduledDate, state, amount, source, completedAt "
        "FROM Job WHERE state='completed' "
        "AND source != 'csv_backfill' AND source NOT LIKE 'csv_backfill_%'"
    )
    print(f"  {len(d1_jobs)} rows\n")

    # Index: payerId → list of D1 jobs (sorted DESC by scheduledDate)
    d1_by_payer = defaultdict(list)
    for j in d1_jobs:
        d1_by_payer[j["payerId"]].append(j)
    for v in d1_by_payer.values():
        v.sort(key=lambda j: j.get("scheduledDate") or "", reverse=True)

    # ─────────────────────────────────────────────────────────────────────────
    # AUDIT 1: Scheduled-date drift
    # For customers with completed scheduledStatus AND non-empty jobHistory,
    # compare KV.scheduledStatus.scheduledDate vs D1.Job.scheduledDate for
    # the most-recent matching job.
    # ─────────────────────────────────────────────────────────────────────────
    drift_match   = []   # (name, ph, kv_date, d1_date, gap=0)
    drift_mismatch = []  # (name, ph, kv_date, d1_date, gap)
    drift_no_d1   = []   # (name, ph, kv_date) — no D1 job at all

    for c in customers:
        if not c or c.get("deleted"):
            continue
        ph  = norm_phone(c.get("phone", ""))
        if not ph or len(ph) != 10:
            continue
        ss  = c.get("scheduledStatus") or {}
        jh  = c.get("jobHistory") or []

        # Only customers with a completed scheduledStatus AND non-empty jobHistory
        if ss.get("state") not in ("completed", "paid"):
            continue
        if not jh:
            continue

        kv_date = (ss.get("scheduledDate") or "")[:10]
        if not kv_date:
            continue

        pid = person_id(ph)
        d1_for_payer = d1_by_payer.get(pid, [])

        name = f"{c.get('firstName','')} {c.get('lastName','')}".strip()

        if not d1_for_payer:
            drift_no_d1.append((name, ph, kv_date))
            continue

        # Find the D1 job whose scheduledDate is closest to kv_date
        best = min(d1_for_payer, key=lambda j: date_gap_days(kv_date, j.get("scheduledDate") or "9999") or 9999)
        d1_date = (best.get("scheduledDate") or "")[:10]
        gap = date_gap_days(kv_date, d1_date)

        if gap == 0:
            drift_match.append((name, ph, kv_date, d1_date, 0))
        else:
            drift_mismatch.append((name, ph, kv_date, d1_date, gap))

    drift_mismatch.sort(key=lambda x: x[4], reverse=True)  # largest gap first

    print("═══ AUDIT 1: Scheduled-date drift ═══\n")
    print(f"Scope: customers with completed scheduledStatus + non-empty jobHistory")
    print(f"  Dates match (gap=0):           {len(drift_match)}")
    print(f"  Dates differ:                  {len(drift_mismatch)}")
    print(f"  No D1 completed job at all:    {len(drift_no_d1)}\n")

    if drift_mismatch:
        print(f"── Sample mismatches (top 10 by gap) ──")
        for name, ph, kv, d1, gap in drift_mismatch[:10]:
            print(f"  {name:<35s} ({ph}) | KV={kv} | D1={d1} | gap={gap}d")

    if drift_no_d1:
        print(f"\n── Customers with completed ss but NO D1 non-csv job ──")
        for name, ph, kv in drift_no_d1[:10]:
            print(f"  {name:<35s} ({ph}) | KV ss_date={kv}")
        if len(drift_no_d1) > 10:
            print(f"  … and {len(drift_no_d1)-10} more")

    # Gap distribution
    if drift_mismatch:
        from collections import Counter
        buckets = Counter()
        for _, _, _, _, gap in drift_mismatch:
            if gap <= 3:    buckets["1-3d"] += 1
            elif gap <= 7:  buckets["4-7d"] += 1
            elif gap <= 14: buckets["8-14d"] += 1
            else:           buckets["15d+"] += 1
        print(f"\n── Gap distribution ──")
        for k in ["1-3d","4-7d","8-14d","15d+"]:
            print(f"  {k}: {buckets[k]}")

    # ─────────────────────────────────────────────────────────────────────────
    # AUDIT 2: Completed scheduledStatus with no matching jobHistory entry
    # ─────────────────────────────────────────────────────────────────────────
    no_jh_match = []   # (name, ph, ss_date, jh_dates)

    for c in customers:
        if not c or c.get("deleted"):
            continue
        ph  = norm_phone(c.get("phone", ""))
        if not ph or len(ph) != 10:
            continue
        ss  = c.get("scheduledStatus") or {}
        jh  = c.get("jobHistory") or []

        if ss.get("state") not in ("completed", "paid"):
            continue

        ss_date = (ss.get("scheduledDate") or "")[:10]
        if not ss_date:
            continue

        name = f"{c.get('firstName','')} {c.get('lastName','')}".strip()

        # Filter to non-csv jh entries
        non_csv_jh = [j for j in jh if j and not (j.get("source") or "").startswith("csv_backfill")]
        non_csv_dates = [(j.get("date") or j.get("scheduledDate") or "")[:10] for j in non_csv_jh]

        if ss_date not in non_csv_dates:
            jh_all_dates = [(j.get("date") or j.get("scheduledDate") or "")[:10] for j in jh if j]
            no_jh_match.append((name, ph, ss_date, non_csv_dates, len(jh)))

    print(f"\n\n═══ AUDIT 2: Completed ss with no matching non-csv jh entry ═══\n")
    print(f"Total customers:  {len(no_jh_match)}\n")

    # Bucket: has jobHistory at all vs completely empty
    has_jh     = [(n,p,sd,nd,jl) for n,p,sd,nd,jl in no_jh_match if jl > 0]
    no_jh_at_all = [(n,p,sd,nd,jl) for n,p,sd,nd,jl in no_jh_match if jl == 0]
    print(f"  Has some jh (csv_backfill only or date mismatch): {len(has_jh)}")
    print(f"  jobHistory completely empty:                      {len(no_jh_at_all)}")

    print(f"\n── Sample 10: has jh but no non-csv entry for ss_date ──")
    for name, ph, ss_date, non_csv_dates, jl in has_jh[:10]:
        nd_str = str(non_csv_dates[:3]) if non_csv_dates else "[]"
        print(f"  {name:<35s} ({ph}) | ss={ss_date} | non-csv-jh={nd_str} | total_jh={jl}")

    print(f"\n── Sample 10: completely empty jobHistory ──")
    for name, ph, ss_date, _, jl in no_jh_at_all[:10]:
        print(f"  {name:<35s} ({ph}) | ss_date={ss_date}")

    # ── Yolanda specific check ────────────────────────────────────────────────
    print(f"\n\n═══ Yolanda Armalen data integrity check ═══\n")
    for c in customers:
        nm = f"{c.get('firstName','')} {c.get('lastName','')}".strip().lower()
        if "yolanda" in nm:
            ph  = norm_phone(c.get("phone",""))
            ss  = c.get("scheduledStatus") or {}
            jh  = c.get("jobHistory") or []
            print(f"  FOUND: phone={ph} name={c.get('firstName','')} {c.get('lastName','')}")
            print(f"    ss: state={ss.get('state')} scheduledDate={ss.get('scheduledDate')}")
            print(f"    jh: {len(jh)} entries")
            for j in jh[-3:]:
                print(f"      {j.get('date')} {j.get('status')} ${j.get('amount')} src={j.get('source')}")

    print(f"\n\n═══ Summary ═══")
    print(f"  Audit 1 — date drift mismatches: {len(drift_mismatch)}")
    print(f"  Audit 1 — no D1 completed job:   {len(drift_no_d1)}")
    print(f"  Audit 2 — no matching jh entry:  {len(no_jh_match)}")
    print(f"\n  → STOP. Report to Tyler before any writes.")

if __name__ == "__main__":
    main()
