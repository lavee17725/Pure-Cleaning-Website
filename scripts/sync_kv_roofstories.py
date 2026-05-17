#!/usr/bin/env python3
"""
scripts/sync_kv_roofstories.py
Sub-Phase R2: Read D1 Job.roofStories values (backfilled in R1) and sync them
to KV jobHistory[].roofStories via the worker admin API.

Rule 16: KV writes go through the admin API, not wrangler kv put.
Pattern: full read-modify-write on the KV customer blob.
  1. GET /customers → read all customer records into memory
  2. For each customer, match KV jobHistory entries to D1 by date (amount as tiebreaker)
  3. Write roofStories into matching entries
  4. PUT /customers → write the entire modified blob back in one request

Idempotent: entries that already have roofStories set are skipped.

Run from repo root:
    python3 scripts/sync_kv_roofstories.py
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

REPO_ROOT       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WRANGLER_CONFIG = os.path.join(REPO_ROOT, "cloudflare-worker", "wrangler.toml")
DB_NAME         = "pure-cleaning-crm-v1"
API_BASE        = "https://purecleaning-api.tylerfumero.workers.dev"
LOGIN_URL       = "https://purecleaningpressurecleaning.com/auth/login"
ENV_LOCAL       = os.path.join(REPO_ROOT, ".env.local")


# ── Auth helpers ───────────────────────────────────────────────────────────────

def load_admin_password():
    try:
        with open(ENV_LOCAL) as f:
            for line in f:
                if line.strip().startswith("ADMIN_PASSWORD="):
                    return line.strip().split("=", 1)[1]
    except FileNotFoundError:
        pass
    return os.environ.get("ADMIN_PASSWORD")


def curl_json(args):
    """Run a curl command and return parsed JSON. Raises on non-zero exit."""
    result = subprocess.run(["curl", "-s"] + args, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"CURL ERROR:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)


def get_auth_token(password):
    return curl_json([
        "-X", "POST", LOGIN_URL,
        "-H", "Content-Type: application/json",
        "-H", "Origin: https://purecleaningpressurecleaning.com",
        "-d", json.dumps({"password": password}),
    ]).get("token")


# ── Admin API helpers ──────────────────────────────────────────────────────────

def api_get(path, token):
    return curl_json([
        f"{API_BASE}/{path}",
        "-H", f"Authorization: Bearer {token}",
    ])


def api_put(path, token, body):
    import tempfile, os as _os
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(body, f)
        tmp = f.name
    try:
        result = curl_json([
            "-X", "PUT", f"{API_BASE}/{path}",
            "-H", f"Authorization: Bearer {token}",
            "-H", "Content-Type: application/json",
            "--data-binary", f"@{tmp}",
            "--max-time", "120",
        ])
    finally:
        _os.unlink(tmp)
    return result


# ── Wrangler D1 read helper ────────────────────────────────────────────────────

def wrangler_query(sql):
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--remote",
         "--config", WRANGLER_CONFIG, "--command", sql],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    if result.returncode != 0:
        print(f"WRANGLER ERROR:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    raw   = result.stdout
    lines = raw.split("\n")
    start = next((i for i, l in enumerate(lines) if l.strip().startswith("[")), -1)
    if start < 0:
        print(f"No JSON in wrangler output:\n{raw}", file=sys.stderr)
        sys.exit(1)
    return json.loads("\n".join(lines[start:]))[0]["results"]


def e164_to_kv(e164):
    """Strip +1 prefix from E.164 → 10-digit KV phone format. Rule 17."""
    digits = "".join(c for c in (e164 or "") if c.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        return digits[1:]
    return digits


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("KV roofStories Sync — Sub-Phase R2")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)

    # ── Auth ──────────────────────────────────────────────────────────────────
    print("\n[Auth] Obtaining admin token…")
    pw = load_admin_password()
    if not pw:
        print("ERROR: ADMIN_PASSWORD not found in .env.local or env", file=sys.stderr)
        sys.exit(1)
    token = get_auth_token(pw)
    if not token:
        print("ERROR: Auth login returned no token", file=sys.stderr)
        sys.exit(1)
    print("    ✓ Token obtained")

    # ── Step A: Query D1 for all roofStories values ───────────────────────────
    print("\n[A] Querying D1 Job.roofStories (non-null)…")
    d1_rows = wrangler_query(
        "SELECT j.jobId, j.scheduledDate, j.amount, j.roofStories, p.primaryPhone "
        "FROM Job j "
        "JOIN Person p ON j.payerId = p.personId "
        "WHERE j.roofStories IS NOT NULL "
        "ORDER BY p.primaryPhone, j.scheduledDate"
    )
    print(f"    {len(d1_rows)} D1 rows with roofStories set")

    # Build lookup: kv_phone → list of {date, amount, roofStories}
    d1_by_phone: dict[str, list[dict]] = {}
    for row in d1_rows:
        kv_phone = e164_to_kv(row["primaryPhone"])
        d1_by_phone.setdefault(kv_phone, []).append({
            "date":        row["scheduledDate"],
            "amount":      round(float(row["amount"] or 0), 2),
            "roofStories": row["roofStories"],
        })
    print(f"    {len(d1_by_phone)} unique KV phones with D1 roofStories")

    # ── Step B: Read KV ───────────────────────────────────────────────────────
    print("\n[B] Reading KV customer DB via GET /customers…")
    kv_data   = api_get("customers", token)
    customers = kv_data.get("customers", [])
    print(f"    {len(customers)} customers in KV")

    # ── Step C: Match and update in memory ────────────────────────────────────
    print("\n[C] Matching KV jobHistory entries to D1 roofStories values…")
    updated_customers  = 0
    updated_jh_entries = 0
    skipped_already    = 0
    no_d1_data         = 0
    unmatched_entries  = 0

    for c in customers:
        phone = c.get("phone", "")
        jh    = c.get("jobHistory") or []
        if not jh:
            continue

        d1_jobs = d1_by_phone.get(phone)
        if not d1_jobs:
            no_d1_data += 1
            continue

        # Index D1 jobs by (date, amount) and by date-only for fallback
        d1_exact:   dict[tuple, int] = {}
        d1_by_date: dict[str, list]  = {}
        for dj in d1_jobs:
            d1_exact[(dj["date"], dj["amount"])] = dj["roofStories"]
            d1_by_date.setdefault(dj["date"], []).append(dj)

        cust_changed = False
        for entry in jh:
            if entry.get("roofStories") is not None:
                skipped_already += 1
                continue
            date = entry.get("date")
            if not date:
                continue
            amt = round(float(entry.get("amount") or 0), 2)

            # Try exact match (date + amount), then date-only if unambiguous
            stories = d1_exact.get((date, amt))
            if stories is None and date in d1_by_date:
                same_day = d1_by_date[date]
                if len(same_day) == 1:
                    stories = same_day[0]["roofStories"]

            if stories is not None:
                entry["roofStories"] = stories
                updated_jh_entries  += 1
                cust_changed         = True
            else:
                unmatched_entries += 1

        if cust_changed:
            updated_customers += 1

    kv_phones = {c.get("phone", "") for c in customers}
    d1_only   = sum(1 for ph in d1_by_phone if ph not in kv_phones)

    print(f"    jobHistory entries already set (skipped): {skipped_already}")
    print(f"    Entries synced to D1 value:               {updated_jh_entries}")
    print(f"    Entries with no D1 match (left null):     {unmatched_entries}")
    print(f"    Customers with no D1 roofStories at all:  {no_d1_data}")
    print(f"    D1 phones not in KV:                      {d1_only}")
    print(f"    Customers whose KV blob changed:          {updated_customers}")

    # ── Step D: Write back ────────────────────────────────────────────────────
    if updated_jh_entries == 0:
        print("\n[D] Nothing to write — KV already in sync.")
    else:
        print(f"\n[D] Writing modified DB back via PUT /customers… ", end="")
        result = api_put("customers", token, kv_data)
        if result.get("success"):
            print("✓")
        else:
            print(f"\n    ✗ PUT returned unexpected result: {result}", file=sys.stderr)
            sys.exit(1)

    # ── Step E: Spot-check Luis Leon ──────────────────────────────────────────
    print("\n[E] Spot-checking Luis Leon (2024-06-17 job)…")
    luis = next(
        (c for c in customers
         if (c.get("firstName") or "").lower().startswith("luis")
         and (c.get("lastName") or "").lower().startswith("leon")),
        None
    )
    if luis:
        target = next((j for j in (luis.get("jobHistory") or []) if j.get("date") == "2024-06-17"), None)
        if target:
            print(f"    Luis Leon 2024-06-17 → roofStories={target.get('roofStories')}")
        else:
            print("    Luis Leon found, but no 2024-06-17 jobHistory entry")
    else:
        print("    Luis Leon not found in KV")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"D1 roofStories rows read:            {len(d1_rows)}")
    print(f"KV jobHistory entries synced:        {updated_jh_entries}")
    print(f"Entries already set (skipped):       {skipped_already}")
    print(f"Entries with no D1 match (null):     {unmatched_entries}")
    print(f"KV customers modified:               {updated_customers}")
    print(f"D1-only phones (not in KV):          {d1_only}")


if __name__ == "__main__":
    main()
