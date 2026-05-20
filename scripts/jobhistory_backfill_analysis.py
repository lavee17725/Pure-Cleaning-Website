#!/usr/bin/env python3
"""
jobHistory Backfill — Analysis Phase (READ-ONLY)

Reads every KV customer's jobHistory[] and compares against D1 Job rows.
Reports what is missing before any writes happen.
"""

import json, os, subprocess, sys, re
from pathlib import Path
from collections import defaultdict

BASE_DIR     = Path(__file__).parent.parent
WRANGLER_CFG = str(BASE_DIR / "cloudflare-worker" / "wrangler.toml")
D1_DB_NAME   = "pure-cleaning-crm-v1"
API_BASE     = "https://purecleaning-api.tylerfumero.workers.dev"
ORIGIN       = "https://purecleaningpressurecleaning.com"

# ── Curl helpers ──────────────────────────────────────────────────────────────
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

# ── D1 helpers ────────────────────────────────────────────────────────────────
def d1_query(sql):
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB_NAME,
         "--remote", "--config", WRANGLER_CFG, "--command", sql],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    if result.returncode != 0:
        print("D1 error:", result.stderr[:500])
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

def person_id(phone10):
    return f"person_1{phone10}"

# ── Phantom-10 list (phones Tyler confirmed were deleted in Phase 4A) ─────────
# We'll discover phones dynamically from KV for names that match,
# but also track the known phones explicitly.
PHANTOM_10 = {
    "8632271269": ("Tanner Huysman",             "2026-05-11"),
    "9545090459": ("Blanca Rapalo",               "2026-05-11"),
    "9545933959": ("Bill Brant",                  "2026-05-11"),
    "9544195278": ("Felicia & Richard Schwartz",  "2026-05-11"),
    "9545367977": ("Andreina Garcia",             "2026-05-12"),
    "9548017990": ("Debra Pashley",               "2026-05-12"),
    "3057714063": ("Yolanda Armalen",             "2026-05-13"),
    "7864041975": ("Oscar Perez",                 "2026-05-13"),
    "9545510632": ("Amy Caress",                  "2026-05-14"),
    "3054694930": ("Nidia Tesoriero",             "2026-05-15"),
}

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("Fetching KV customers via API…")
    token = get_token()
    data = curl_get("/customers", token)
    customers = data.get("customers", [])
    print(f"  {len(customers)} customers from KV\n")

    # ── Load all D1 non-csv jobs ───────────────────────────────────────────────
    print("Fetching D1 non-csv_backfill jobs…")
    d1_jobs = d1_query(
        "SELECT jobId, payerId, scheduledDate, state, amount, source, completedAt "
        "FROM Job WHERE source != 'csv_backfill' AND source NOT LIKE 'csv_backfill_%'"
    )
    print(f"  {len(d1_jobs)} non-csv_backfill Job rows in D1\n")

    # Index by (payerId, date)
    d1_by_payer_date = defaultdict(list)
    for j in d1_jobs:
        key = (j["payerId"], (j.get("scheduledDate") or "")[:10])
        d1_by_payer_date[key].append(j)

    # ── Walk KV jobHistory ────────────────────────────────────────────────────
    all_jh = 0
    by_src_total   = defaultdict(int)
    by_src_in_d1   = defaultdict(int)
    by_src_missing = defaultdict(int)

    missing   = []   # (customer, jh_entry) for entries not in D1
    miss_dates = []

    phantom_status = {
        ph: {"name": nm, "expected": exp, "jh_completed": [], "d1_rows": []}
        for ph, (nm, exp) in PHANTOM_10.items()
    }

    for c in customers:
        if not c or c.get("deleted"):
            continue
        ph = norm_phone(c.get("phone", ""))
        if not ph or len(ph) != 10:
            continue
        pid = person_id(ph)
        jh  = c.get("jobHistory") or []

        for entry in jh:
            if not entry:
                continue
            src = entry.get("source") or "unknown"
            all_jh += 1
            by_src_total[src] += 1

            # csv_backfill already in D1 — count but skip
            if src == "csv_backfill" or src.startswith("csv_backfill_"):
                by_src_in_d1[src] += 1
                continue

            # Only completed entries
            status = entry.get("status") or entry.get("state") or ""
            completed_at = entry.get("completedAt") or ""
            if status != "completed" and not completed_at:
                by_src_missing[f"{src}:not_completed"] += 1
                continue

            jh_date = (entry.get("date") or entry.get("scheduledDate") or "")[:10]
            if not jh_date:
                by_src_missing[f"{src}:no_date"] += 1
                continue

            key = (pid, jh_date)
            if d1_by_payer_date[key]:
                by_src_in_d1[src] += 1
            else:
                by_src_missing[src] += 1
                missing.append((c, entry))
                miss_dates.append(jh_date)

            # Phantom-10 tracking
            if ph in phantom_status:
                phantom_status[ph]["jh_completed"].append(jh_date)
                if d1_by_payer_date[key]:
                    phantom_status[ph]["d1_rows"].extend(d1_by_payer_date[key])

    # ── Report ────────────────────────────────────────────────────────────────
    print("═══ KV jobHistory Analysis ═══\n")
    print(f"Total KV jobHistory entries:          {all_jh}")
    print(f"Missing from D1 (non-csv, completed): {len(missing)}\n")

    print("── By source — KV total ──")
    for src, n in sorted(by_src_total.items()):
        print(f"  {src:30s}  {n}")

    print("\n── By source — already in D1 ──")
    for src, n in sorted(by_src_in_d1.items()):
        print(f"  {src:30s}  {n}")

    print("\n── By source — MISSING from D1 ──")
    for src, n in sorted(by_src_missing.items()):
        print(f"  {src:30s}  {n}")

    if miss_dates:
        print(f"\n── Date range of missing entries ──")
        print(f"  Earliest: {min(miss_dates)}")
        print(f"  Latest:   {max(miss_dates)}")

    print(f"\n── Sample 5 missing entries ──")
    for c, jh in missing[:5]:
        name = f"{c.get('firstName','')} {c.get('lastName','')}".strip()
        src  = jh.get("source", "?")
        dt   = (jh.get("date") or jh.get("scheduledDate", "?"))[:10]
        amt  = jh.get("amount", "?")
        ph   = norm_phone(c.get("phone", ""))
        print(f"  {name:<30s} ({ph}) | {dt} | ${amt} | src={src}")

    print("\n\n═══ Phantom-10 Verification ═══\n")
    all_ok = True
    for ph, info in sorted(phantom_status.items()):
        nm       = info["name"]
        expected = info["expected"]
        jh_dates = info["jh_completed"]
        d1_rows  = info["d1_rows"]

        in_d1 = bool([r for r in d1_rows if (r.get("scheduledDate") or "")[:10] == expected])
        in_kv = expected in jh_dates
        in_kv_any = bool(jh_dates)

        if in_d1:
            status = "✅ already in D1"
        elif in_kv:
            status = "✅ will backfill (found in KV jh)"
        elif in_kv_any:
            status = f"⚠️  KV jh has dates {jh_dates} but NOT expected {expected}"
            all_ok = False
        else:
            status = "❌  NO KV jh entry — will NOT be backfilled"
            all_ok = False

        print(f"  {nm:<35s} ({ph}) expect={expected}: {status}")

    print()
    if all_ok:
        print("✅  All 10 phantom-deleted customers accounted for.")
    else:
        print("⚠️  Some phantom customers missing — manual review needed before proceeding.")

    print(f"\n\n═══ Summary ═══")
    print(f"  Total new Job inserts needed: {len(missing)}")
    print(f"  Await Tyler approval before executing backfill.")

if __name__ == "__main__":
    main()
