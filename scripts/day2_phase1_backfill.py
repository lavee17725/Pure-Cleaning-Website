#!/usr/bin/env python3
"""
DAY 2 — PHASE 1: Delta backfill of 6 net-new customers into D1.

Customers added to KV between Day 1 (2026-05-16) and Day 2 (2026-05-20):
  7542142460 — Jeff Sparks
  7864056343 — Alkesh Mevada
  7865305630 — Maria Cuadra
  9546000131 — Gio Colpani
  9548038318 — ED Mendez
  9548059741 — Valerie Bornstein

Confirmed NOT in D1 Person table as of Phase 0 pre-flight.
Uses same extraction pipeline as migration_skeleton.py.
"""

import json, sys
from pathlib import Path

# Reuse skeleton logic verbatim
sys.path.insert(0, str(Path(__file__).parent))
from migration_skeleton import (
    resolve_identities, extract_properties, extract_jobs,
    build_insert_sql, wrangler_exec_file,
    person_to_row, property_to_row, pp_to_row, job_to_row,
    PERSON_COLS, PROPERTY_COLS, PP_COLS, JOB_COLS,
)

BASE_DIR     = Path(__file__).parent.parent
WRANGLER_CFG = str(BASE_DIR / "cloudflare-worker" / "wrangler.toml")
D1_DB_NAME   = "pure-cleaning-crm-v1"

DELTA_PHONES = {
    "7542142460", "7864056343", "7865305630",
    "9546000131", "9548038318", "9548059741",
}

def load_delta_customers():
    """Pull the 6 delta customers from the KV snapshot fetched in Phase 0."""
    snap = Path("/tmp/kv_customers.json")
    if not snap.exists():
        sys.exit("❌  /tmp/kv_customers.json not found — re-run GET /customers first")
    with open(snap) as f:
        data = json.load(f)
    customers = [c for c in data.get("customers", []) if c and not c.get("deleted")]
    def norm(p): return (p or "").replace("-","").replace(" ","").replace("+","").lstrip("1")[-10:]
    delta = [c for c in customers if norm(c.get("phone","")) in DELTA_PHONES]
    print(f"Delta customers found in KV snapshot: {len(delta)}")
    for c in delta:
        print(f"  {norm(c.get('phone',''))} — {c.get('firstName','')} {c.get('lastName','')}")
    if len(delta) != len(DELTA_PHONES):
        missing = DELTA_PHONES - {norm(c.get("phone","")) for c in delta}
        print(f"⚠️  Missing from snapshot: {missing}")
    return delta

def run(dry_run=False):
    print("\n═══ Day 2 Phase 1: Delta Backfill ═══\n")
    customers = load_delta_customers()

    print("\n── Identity resolution ──")
    persons = resolve_identities(customers)
    print(f"  {len(persons)} persons")

    print("\n── Property extraction ──")
    prop_map, pp_links = extract_properties(persons)
    print(f"  {len(prop_map)} properties, {len(pp_links)} PersonProperty links")

    print("\n── Job extraction ──")
    jobs, stats = extract_jobs(persons, prop_map)
    print(f"  {len(jobs)} jobs")
    if stats["date_rejects"]: print(f"  ⚠️  date rejects: {stats['date_rejects']}")

    # ── Build SQL ──────────────────────────────────────────────────────────────
    person_rows = [person_to_row(p) for p in persons]
    prop_rows   = [property_to_row(pv) for pv in prop_map.values()]
    pp_rows     = [pp_to_row(lk) for lk in pp_links]
    job_rows    = [job_to_row(j) for j in jobs]

    person_sql = "\n".join(build_insert_sql("Person",       PERSON_COLS,   person_rows))
    prop_sql   = "\n".join(build_insert_sql("Property",     PROPERTY_COLS, prop_rows))
    # INSERT OR IGNORE for Property + PP: delta addresses might overlap existing D1 properties
    prop_sql   = prop_sql.replace("INSERT INTO Property", "INSERT OR IGNORE INTO Property")
    pp_sql_raw = "\n".join(build_insert_sql("PersonProperty", PP_COLS,     pp_rows))
    pp_sql     = pp_sql_raw.replace("INSERT INTO PersonProperty", "INSERT OR IGNORE INTO PersonProperty")
    job_sql    = "\n".join(build_insert_sql("Job",          JOB_COLS,      job_rows))

    if dry_run:
        print("\n── DRY RUN — SQL preview ──")
        for label, sql in [("Person", person_sql), ("Property", prop_sql),
                           ("PersonProperty", pp_sql), ("Job", job_sql)]:
            lines = sql.splitlines()
            print(f"\n{label} ({len(lines)} lines):")
            for line in lines[:6]: print(f"  {line}")
            if len(lines) > 6: print(f"  ... ({len(lines)-6} more lines)")
        print("\n✅  Dry run complete — no D1 writes.")
        return

    # ── Execute ────────────────────────────────────────────────────────────────
    print("\n── Executing D1 inserts ──")
    ok = True
    ok = ok and wrangler_exec_file(person_sql, "Person_insert")
    ok = ok and wrangler_exec_file(prop_sql,   "Property_insert_or_ignore")
    ok = ok and wrangler_exec_file(pp_sql,     "PersonProperty_insert_or_ignore")
    if job_rows:
        ok = ok and wrangler_exec_file(job_sql, "Job_insert")
    else:
        print("  ℹ️  No job rows to insert (customers with no jobHistory or scheduledStatus)")

    if not ok:
        print("\n❌  One or more inserts failed — check output above. D1 state may be partial.")
        sys.exit(1)

    print("\n✅  Phase 1 backfill complete.")

if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    run(dry_run=dry)
