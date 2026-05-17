#!/usr/bin/env python3
"""
scripts/backfill_stories.py
Sub-Phase R1 of Stories Root Fix (May 17, 2026).

Parses Job.servicesRaw to extract story counts, writes Job.roofStories,
then derives Property.stories from each property's most recent roof job.
Properties with conflicting story history across jobs are flagged and
written to /tmp/stories_conflicts.json for Tyler's review.

Run from repo root:
    python3 scripts/backfill_stories.py

Idempotent: safe to re-run; overwrites any previously set values.
One-time migration — do not run after Day 2 KV sync populates
roofStories via the application path.

Rule 16 note: this script is operator-supervised migration work,
not application runtime writes. D1 writes via wrangler are acceptable
here per CLAUDE.md discussion on Day 1/R1 migration exceptions.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WRANGLER_CONFIG = os.path.join(REPO_ROOT, "cloudflare-worker", "wrangler.toml")
DB_NAME = "pure-cleaning-crm-v1"
BATCH_SIZE = 500
CONFLICTS_PATH = "/tmp/stories_conflicts.json"


# ── Wrangler helpers ───────────────────────────────────────────────────────────

def wrangler_query(sql):
    """Run a read-only SELECT against D1 via wrangler. Returns list of row dicts."""
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--remote",
         "--config", WRANGLER_CONFIG, "--command", sql],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    if result.returncode != 0:
        print(f"WRANGLER QUERY ERROR:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    raw = result.stdout
    lines = raw.split("\n")
    start = next((i for i, l in enumerate(lines) if l.strip().startswith("[")), -1)
    if start < 0:
        print(f"Could not find JSON in wrangler output:\n{raw}", file=sys.stderr)
        sys.exit(1)
    data = json.loads("\n".join(lines[start:]))
    return data[0]["results"]


def wrangler_exec_file(sql_path, label=""):
    """Execute a SQL file against D1 via wrangler. Returns True on success."""
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB_NAME, "--remote",
         "--config", WRANGLER_CONFIG, "--file", sql_path],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    if result.returncode != 0:
        print(f"WRANGLER EXEC ERROR ({label}):\n{result.stderr}", file=sys.stderr)
        return False
    return True


def write_and_exec_sql(statements, label):
    """Write a list of SQL statements to a temp file and execute via wrangler."""
    if not statements:
        return True
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False,
                                     prefix="backfill_") as f:
        f.write(";\n".join(statements) + ";")
        path = f.name
    try:
        ok = wrangler_exec_file(path, label)
    finally:
        os.unlink(path)
    return ok


# ── Story parsing ──────────────────────────────────────────────────────────────

def parse_stories(raw):
    """
    Extract story count from a servicesRaw free-text string.
    Returns 2, 1, or None (no story info found).
    Matches: '2 story', '2-story', '2story', '2 stories' etc., case-insensitive.
    """
    if not raw:
        return None
    if re.search(r"\b2[\s\-]*stor(?:y|ies)\b", raw, re.IGNORECASE):
        return 2
    if re.search(r"\b1[\s\-]*stor(?:y|ies)\b", raw, re.IGNORECASE):
        return 1
    return None


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Stories Backfill — Sub-Phase R1")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)

    # ── Step A: Fetch all completed jobs with servicesRaw ──────────────────────
    print("\n[A] Querying completed jobs with servicesRaw…")
    jobs = wrangler_query(
        "SELECT jobId, propertyId, scheduledDate, servicesRaw "
        "FROM Job "
        "WHERE state = 'completed' AND servicesRaw IS NOT NULL "
        "ORDER BY scheduledDate ASC"
    )
    print(f"    {len(jobs)} jobs returned")

    # ── Step B: Parse stories from servicesRaw ─────────────────────────────────
    print("\n[B] Parsing stories from servicesRaw…")
    parsed = []
    count_1 = count_2 = count_null = 0
    for j in jobs:
        stories = parse_stories(j["servicesRaw"])
        parsed.append({
            "jobId":        j["jobId"],
            "propertyId":   j["propertyId"],
            "scheduledDate": j["scheduledDate"],
            "stories":      stories,
            "servicesRaw":  j["servicesRaw"],
        })
        if stories == 2:
            count_2 += 1
        elif stories == 1:
            count_1 += 1
        else:
            count_null += 1

    print(f"    roofStories = 1 : {count_1}")
    print(f"    roofStories = 2 : {count_2}")
    print(f"    no story info   : {count_null}")

    # ── Step C: Backfill Job.roofStories ──────────────────────────────────────
    to_update = [(p["jobId"], p["stories"]) for p in parsed if p["stories"] is not None]
    print(f"\n[C] Updating Job.roofStories for {len(to_update)} jobs…")

    for batch_start in range(0, len(to_update), BATCH_SIZE):
        batch = to_update[batch_start:batch_start + BATCH_SIZE]
        stmts = [
            f"UPDATE Job SET roofStories = {stories} WHERE jobId = '{jid}'"
            for jid, stories in batch
        ]
        batch_num = batch_start // BATCH_SIZE + 1
        total_batches = (len(to_update) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"    Batch {batch_num}/{total_batches} ({len(batch)} rows)…", end=" ")
        if not write_and_exec_sql(stmts, f"Job.roofStories batch {batch_num}"):
            print("FAILED", file=sys.stderr)
            sys.exit(1)
        print("ok")

    print("    ✓ Job.roofStories backfill complete")

    # ── Step D: Derive Property.stories ───────────────────────────────────────
    print("\n[D] Deriving Property.stories from roof job history…")

    # Group all parsed-stories entries by propertyId
    by_prop = defaultdict(list)
    for p in parsed:
        if p["stories"] is not None and p["propertyId"]:
            by_prop[p["propertyId"]].append({
                "jobId":         p["jobId"],
                "scheduledDate": p["scheduledDate"],
                "stories":       p["stories"],
                "servicesRaw":   p["servicesRaw"][:80] if p["servicesRaw"] else None,
            })

    conflicts = []
    prop_updates = []  # (propertyId, stories)

    for prop_id, history in by_prop.items():
        hist_sorted = sorted(history, key=lambda x: x["scheduledDate"] or "", reverse=True)
        unique_values = set(h["stories"] for h in hist_sorted)

        if len(unique_values) == 1:
            prop_updates.append((prop_id, hist_sorted[0]["stories"]))
        else:
            conflicts.append({
                "propertyId":          prop_id,
                "canonicalMostRecent": hist_sorted[0]["stories"],
                "conflictingValues":   sorted(list(unique_values)),
                "history":             hist_sorted,
            })

    print(f"    Properties to update (consistent): {len(prop_updates)}")
    print(f"    Properties with CONFLICTS:         {len(conflicts)}")

    # ── Step E: Apply Property.stories updates ─────────────────────────────────
    if prop_updates:
        print(f"\n[E] Updating Property.stories for {len(prop_updates)} properties…")
        for batch_start in range(0, len(prop_updates), BATCH_SIZE):
            batch = prop_updates[batch_start:batch_start + BATCH_SIZE]
            stmts = [
                f"UPDATE Property SET stories = {stories} WHERE propertyId = '{pid}'"
                for pid, stories in batch
            ]
            batch_num = batch_start // BATCH_SIZE + 1
            total_batches = (len(prop_updates) + BATCH_SIZE - 1) // BATCH_SIZE
            print(f"    Batch {batch_num}/{total_batches} ({len(batch)} rows)…", end=" ")
            if not write_and_exec_sql(stmts, f"Property.stories batch {batch_num}"):
                print("FAILED", file=sys.stderr)
                sys.exit(1)
            print("ok")
        print("    ✓ Property.stories backfill complete")
    else:
        print("\n[E] No Property.stories to update (all properties had conflicts)")

    # ── Step F: Write conflicts file ──────────────────────────────────────────
    conflict_doc = {
        "title":         "Stories Backfill Conflicts — May 17",
        "generatedAt":   datetime.now(timezone.utc).isoformat(),
        "conflictCount": len(conflicts),
        "note":          (
            "These properties had roof jobs with different parsed story counts across "
            "their history. Property.stories was NOT set for these — requires Tyler's "
            "manual review to determine the correct canonical value."
        ),
        "conflicts": conflicts,
    }
    with open(CONFLICTS_PATH, "w") as f:
        json.dump(conflict_doc, f, indent=2)
    print(f"\n[F] Conflicts written → {CONFLICTS_PATH}")

    # ── Summary ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Jobs scanned (completed, has servicesRaw): {len(jobs)}")
    print(f"Jobs → roofStories = 1                   : {count_1}")
    print(f"Jobs → roofStories = 2                   : {count_2}")
    print(f"Jobs → no story info (null)              : {count_null}")
    print(f"Properties updated (consistent history)  : {len(prop_updates)}")
    print(f"Properties flagged (conflicting history) : {len(conflicts)}")
    print(f"\nConflicts file: {CONFLICTS_PATH}")


if __name__ == "__main__":
    main()
