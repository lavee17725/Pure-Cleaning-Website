#!/usr/bin/env python3
"""
Fix 21 D1 Job rows where scheduledDate = completion date instead of original scheduled date.

Modes:
  --check    : precision check only (default)
  --execute  : run the 21 UPDATEs after snapshot confirmation
"""

import json, subprocess, sys, re
from pathlib import Path
from collections import defaultdict
from datetime import date as dt_date

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
         "-H", f"Origin: {ORIGIN}", "-H", f"Authorization: Bearer {token}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout)

def get_token():
    pw = ""
    for line in (BASE_DIR / ".env.local").read_text().splitlines():
        if line.startswith("ADMIN_PASSWORD="):
            pw = line.split("=", 1)[1].strip()
    d = curl_post("/auth/login", {"password": pw})
    tok = d.get("token", "")
    if not tok:
        sys.exit(f"❌  Auth failed: {d}")
    return tok

def d1_query(sql):
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB_NAME,
         "--remote", "--config", WRANGLER_CFG, "--command", sql],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    if r.returncode != 0:
        print("D1 error:", r.stderr[:300])
        return []
    rows = re.findall(r'\{[^{}]+\}', r.stdout)
    out = []
    for row in rows:
        try:
            p = json.loads(row)
            if "sql_duration_ms" in p or "served_by" in p:
                continue
            out.append(p)
        except Exception:
            pass
    return out

def d1_execute(sql, label):
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB_NAME,
         "--remote", "--config", WRANGLER_CFG, "--command", sql],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    ok = r.returncode == 0 and "error" not in r.stdout.lower()[:100]
    if not ok:
        print(f"  ❌  {label} FAILED")
        print("  stderr:", r.stderr[:300])
        print("  stdout:", r.stdout[:300])
    return ok

def norm_phone(p):
    return re.sub(r'\D', '', p or '')[-10:]

def person_id(ph10):
    return f"person_1{ph10}"

def days_apart(d1, d2):
    try:
        a = dt_date.fromisoformat(d1[:10])
        b = dt_date.fromisoformat(d2[:10])
        return abs((a - b).days)
    except Exception:
        return None

# ── Build the 21-customer fix plan from live data ────────────────────────────
def build_fix_plan(customers, d1_jobs_by_payer):
    plan = []  # {name, ph, pid, kv_date, job_id, d1_date, completed_at, state}

    for c in customers:
        if not c or c.get("deleted"):
            continue
        ph = norm_phone(c.get("phone", ""))
        if not ph or len(ph) != 10:
            continue
        ss = c.get("scheduledStatus") or {}
        jh = c.get("jobHistory") or []

        if ss.get("state") not in ("completed", "paid"):
            continue
        if not jh:
            continue

        kv_date = (ss.get("scheduledDate") or "")[:10]
        if not kv_date:
            continue

        pid = person_id(ph)
        d1_jobs = d1_jobs_by_payer.get(pid, [])
        if not d1_jobs:
            continue

        # Find closest D1 job by date
        best = min(d1_jobs, key=lambda j: days_apart(kv_date, j.get("scheduledDate") or "9999") or 9999)
        d1_date = (best.get("scheduledDate") or "")[:10]
        gap = days_apart(kv_date, d1_date)

        if gap and gap > 0:
            name = f"{c.get('firstName','')} {c.get('lastName','')}".strip()
            plan.append({
                "name":         name,
                "ph":           ph,
                "pid":          pid,
                "kv_date":      kv_date,
                "job_id":       best["jobId"],
                "d1_date":      d1_date,
                "completed_at": best.get("completedAt") or "",
                "state":        best.get("state") or "",
                "gap":          gap,
            })

    plan.sort(key=lambda x: x["kv_date"])
    return plan

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    execute_mode = "--execute" in sys.argv

    print("Loading KV customers…")
    token = get_token()
    customers = curl_get("/customers", token).get("customers", [])
    print(f"  {len(customers)} customers\n")

    print("Loading D1 completed non-csv jobs…")
    d1_jobs = d1_query(
        "SELECT jobId, payerId, scheduledDate, state, amount, source, completedAt "
        "FROM Job WHERE state='completed' "
        "AND source != 'csv_backfill' AND source NOT LIKE 'csv_backfill_%'"
    )
    print(f"  {len(d1_jobs)} rows\n")

    d1_by_payer = defaultdict(list)
    for j in d1_jobs:
        d1_by_payer[j["payerId"]].append(j)

    plan = build_fix_plan(customers, d1_by_payer)
    print(f"Fix plan: {len(plan)} customers with scheduledDate drift\n")

    # ── Precision check ────────────────────────────────────────────────────────
    print("═══ Precision Check ═══\n")
    cleared  = []
    flagged  = []

    for row in plan:
        # Check 1: state must be 'completed'
        if row["state"] != "completed":
            flagged.append((row, f"state='{row['state']}' (not completed)"))
            continue

        # Check 2: completedAt must be present
        if not row["completed_at"]:
            flagged.append((row, "completedAt is missing"))
            continue

        # Check 3: D1 scheduledDate must match completedAt date (confirms the bug pattern)
        ca_date = row["completed_at"][:10]
        if ca_date != row["d1_date"]:
            flagged.append((row, f"completedAt date {ca_date} ≠ D1 scheduledDate {row['d1_date']} — unexpected"))
            continue

        cleared.append(row)

    print(f"  Cleared for UPDATE: {len(cleared)}")
    print(f"  Flagged (skip):     {len(flagged)}\n")

    for row in cleared:
        check3 = "✅ completedAt=" + row["completed_at"][:10] + " matches D1 scheduledDate"
        print(f"  ✅ {row['name']:<35s} ({row['ph']}) | KV={row['kv_date']} → D1={row['d1_date']} (gap={row['gap']}d) | {check3}")

    if flagged:
        print(f"\n  FLAGGED (manual review needed):")
        for row, reason in flagged:
            print(f"  ⚠️  {row['name']:<35s} ({row['ph']}) — {reason}")

    if not execute_mode:
        print("\n\n⏸  Check mode — no writes made.")
        print("   Run with --execute to apply UPDATEs after snapshot.")
        return

    # ── EXECUTE MODE ──────────────────────────────────────────────────────────
    if not cleared:
        print("\n✅  Nothing to update after precision check.")
        return

    # Snapshot
    print("\n\n── Snapshot before writes ──")
    snap = curl_post("/import/snapshot", {}, token)
    snap_key = snap.get("key", "ERROR")
    snap_ct  = snap.get("customerCount", "?")
    if snap_key == "ERROR":
        sys.exit(f"❌  Snapshot failed: {snap}")
    print(f"  Snapshot: {snap_key} ({snap_ct} customers)\n")

    # Execute UPDATEs sequentially
    print("── Executing UPDATEs ──\n")
    errors = []
    for i, row in enumerate(cleared, 1):
        job_id  = row["job_id"].replace("'", "''")   # escape single quotes
        new_date = row["kv_date"]
        sql = f"UPDATE Job SET scheduledDate='{new_date}' WHERE jobId='{job_id}'"

        ok = d1_execute(sql, f"UPDATE {row['name']}")
        if not ok:
            errors.append(row)
            print(f"\n❌  STOPPED at row {i} — {row['name']} ({row['ph']}). Errors above.")
            sys.exit(1)

        # Verify
        check = d1_query(f"SELECT scheduledDate, completedAt, state FROM Job WHERE jobId='{job_id}'")
        if check and check[0].get("scheduledDate") == new_date:
            print(f"  {i:>2}/{len(cleared)} ✅  {row['name']:<35s} scheduledDate now {new_date}  (completedAt={row['completed_at'][:10]})")
        else:
            print(f"  {i:>2}/{len(cleared)} ⚠️  {row['name']:<35s} verify failed — check D1 manually")
            errors.append(row)

    if errors:
        print(f"\n❌  {len(errors)} error(s) — check above before proceeding.")
        sys.exit(1)

    print(f"\n\n✅  All {len(cleared)} UPDATEs complete.")
    print("   → Re-run audit script to confirm 0 mismatches.")

if __name__ == "__main__":
    main()
