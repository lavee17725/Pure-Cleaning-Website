#!/usr/bin/env python3
"""
Pure Cleaning CRM — Migration Script
Hour 3: Identity Resolution + Manifest Preview

v3 schema locked May 13, 2026.
DO NOT WRITE TO D1 — this script produces a manifest preview only.

Usage:
  python3 scripts/migration_skeleton.py [snapshot_path]

If snapshot_path omitted, uses the latest pre_migration_*.json in snapshots/.
"""

import json, re, sys, uuid, os, subprocess, tempfile
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

# ── Configuration ──────────────────────────────────────────────────────────────

BASE_DIR      = Path(__file__).parent.parent
SNAP_DIR      = BASE_DIR / "snapshots"
MIGS_DIR      = BASE_DIR / "cloudflare-worker" / "migrations"
WRANGLER_CFG  = str(BASE_DIR / "cloudflare-worker" / "wrangler.toml")
D1_DB_NAME    = "pure-cleaning-crm-v1"

HOME_BASE_LAT = 26.0418
HOME_BASE_LNG = -80.3710

MIGRATION_VERSION = "v3_day1_hour3"

# ── Canonical service taxonomy (from locked spec) ───────────────────────────────

SERVICE_TAXONOMY = [
    "Roof", "Roof - Softwash", "Roof - Traditional brush",
    "Rinse Walls", "Rinse Walls & Windows",
    "Patio", "Driveway", "Sidewalk", "Entranceway", "Walkway",
    "Pool Deck", "Screen Enclosure", "Fence", "Gutter Cleaning",
    "Stairways", "Curbs / Carstops", "Dumpster Area", "Tennis Court",
    "Landscape Border",
    "Seal Driveway", "Seal Patio", "Seal Sand in Joints", "Seal Pool Deck",
    "Prep for Painting", "Multi-building Complex",
]

# Keyword → canonical service (checked in order, longest match wins)
SERVICE_KEYWORD_MAP = [
    (r'softwash|soft\s+wash',               "Roof - Softwash"),
    (r'roof.*brush|brush.*roof',             "Roof - Traditional brush"),
    (r'roof',                                "Roof"),
    (r'rinse\s+walls?\s*&?\s*windows?',      "Rinse Walls & Windows"),
    (r'rinse\s+walls?',                      "Rinse Walls"),
    (r'seal.*sand|sand.*joint',              "Seal Sand in Joints"),
    (r'seal.*pool\s*deck|pool\s*deck.*seal', "Seal Pool Deck"),
    (r'seal.*patio|patio.*seal',             "Seal Patio"),
    (r'seal.*driveway|driveway.*seal',       "Seal Driveway"),
    (r'pool\s*deck',                         "Pool Deck"),
    (r'screen\s*enclosure|screen',           "Screen Enclosure"),
    (r'tennis\s*court',                      "Tennis Court"),
    (r'gutter',                              "Gutter Cleaning"),
    (r'stairway|stairs',                     "Stairways"),
    (r'curb|carstop|car\s*stop',             "Curbs / Carstops"),
    (r'dumpster',                            "Dumpster Area"),
    (r'landscape\s*border|landscape\s*strip',"Landscape Border"),
    (r'prep\s*(for)?\s*paint',               "Prep for Painting"),
    (r'multi.*building|multiple.*building',  "Multi-building Complex"),
    (r'fence',                               "Fence"),
    (r'patio',                               "Patio"),
    (r'driveway',                            "Driveway"),
    (r'sidewalk',                            "Sidewalk"),
    (r'entranceway|entrance\s*way',          "Entranceway"),
    (r'walkway',                             "Walkway"),
]

# ── Known hard-coded spec decisions ─────────────────────────────────────────────

# Phones that map to specific Person configs from the locked spec
SPEC_LOCKED_PERSONS = {
    "9542493300": {
        "aliases_include": ["Kristina Seeber", "Krissy Llorca"],
        "isHomeowner": True,
        "isReferralSource": True,
        "note": "Christina/Kristina Seeber — 4 properties per spec (6520 SW 18 Ct absent from KV data)",
        # Per-job address → relationship override
        "address_relationships": {
            "5501 Monroe St":    "referrer",
            "7000 Hope St":      "referrer",
            "6520 SW 18 Ct":     "owner",    # spec says owner, not in KV data
            "2419 Marathon Lane": "owner",
        },
    },
}

# Commercial account phone patterns — isCommercialAccount=true
COMMERCIAL_PHONES = {
    "7542813444",  # Property Keepers / Villas at the Gate
}

# Commercial name keywords — detected at runtime too
COMMERCIAL_NAME_KEYWORDS = [
    "property keepers", "t&g", "utg", "premier", "miami mgmt",
    "management", "commercial", "hoa", "association", "resort",
    "villas", "community", "condo", "holdings", "llc", "inc",
    "corporation", "corp", "enterprises", "properties",
]

# ── Normalization helpers ───────────────────────────────────────────────────────

def normalize_phone(raw):
    """Normalize to E.164 (+1XXXXXXXXXX). Returns (e164, error_reason)."""
    if not raw:
        return None, "missing"
    s = str(raw).strip()
    if s.upper().startswith("REFERRAL_"):
        return s, None       # referral placeholder — keep as-is
    digits = re.sub(r"\D", "", s)
    if len(digits) == 10:
        return f"+1{digits}", None
    if len(digits) == 11 and digits[0] == "1":
        return f"+{digits}", None
    if len(digits) < 7:
        return None, f"too_short:{s}"
    return None, f"invalid_format:{s}"


def normalize_date(raw):
    """
    Parse date string to YYYY-MM-DD.
    Accepts: YYYY-MM-DD, M/D/YY, M/D/YYYY.
    Returns (yyyy_mm_dd, rejection_reason).
    """
    if not raw:
        return None, "missing"
    s = str(raw).strip()
    # Already YYYY-MM-DD
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return s, None
    # M/D/YY or M/D/YYYY
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$", s)
    if m:
        month, day, year = m.groups()
        if len(year) == 2:
            year = "20" + year
        try:
            dt = datetime(int(year), int(month), int(day))
            return dt.strftime("%Y-%m-%d"), None
        except ValueError as e:
            return None, f"invalid_date:{s}:{e}"
    # ISO with time component — truncate
    m2 = re.match(r"^(\d{4}-\d{2}-\d{2})T", s)
    if m2:
        return m2.group(1), None
    return None, f"unrecognized_format:{s}"


def normalize_address(street, city=""):
    """Lower-cased, whitespace-collapsed address key for deduplication."""
    if not street:
        return None
    s = re.sub(r"\s+", " ", (street or "").strip().lower())
    c = re.sub(r"\s+", " ", (city or "").strip().lower())
    return f"{s}|{c}"


def canonical_name(first, last):
    return f"{(first or '').strip()} {(last or '').strip()}".strip()


def is_commercial(c):
    if c.get("phone") in COMMERCIAL_PHONES:
        return True
    name = canonical_name(c.get("firstName",""), c.get("lastName","")).lower()
    biz  = (c.get("businessName") or "").lower()
    full = f"{name} {biz}"
    return any(kw in full for kw in COMMERCIAL_NAME_KEYWORDS)


def map_services(raw_text):
    """
    Map free-text services string to list of canonical taxonomy terms.
    Returns (canonical_list, unmapped_fragments).
    """
    if not raw_text:
        return [], []
    # Split on common delimiters
    parts = re.split(r"[,\n/·•]+", str(raw_text))
    canonical = []
    unmapped  = []
    for part in parts:
        p = part.strip()
        if not p:
            continue
        matched = None
        for pattern, svc in SERVICE_KEYWORD_MAP:
            if re.search(pattern, p, re.IGNORECASE):
                if svc not in canonical:
                    canonical.append(svc)
                matched = svc
                break
        if not matched and len(p) > 2:
            unmapped.append(p)
    return canonical, unmapped


def make_id(prefix, *parts):
    slug = "_".join(str(p) for p in parts if p)
    slug = re.sub(r"[^\w]", "_", slug)[:40]
    return f"{prefix}_{slug}"


def new_uuid():
    return str(uuid.uuid4())


# ── Phase 1: Load ──────────────────────────────────────────────────────────────

def load_snapshot(path=None):
    if path:
        snap = Path(path)
    else:
        snaps = sorted(SNAP_DIR.glob("pre_migration_*customers.json"), reverse=True)
        if not snaps:
            sys.exit("No pre_migration_* snapshot found in snapshots/")
        snap = snaps[0]
    print(f"Loading: {snap.name}")
    with open(snap, encoding="utf-8", errors="surrogateescape") as f:
        d = json.load(f)
    custs = d.get("customers", [])
    print(f"  {len(custs)} customers")
    return custs, snap.name


# ── Phase 2: Identity resolution ───────────────────────────────────────────────

def resolve_identities(custs):
    """
    Group KV records by normalized phone. Within each group:
      - Merge names into aliases[]
      - Assign confidence
      - Apply locked spec decisions

    Returns list of person_candidate dicts.
    """
    phone_groups = defaultdict(list)    # e164 → [kv_record, ...]
    no_phone     = []
    referral_only = []
    invalid_phone = []

    for c in custs:
        e164, err = normalize_phone(c.get("phone"))
        if err == "missing":
            no_phone.append(c)
        elif e164 and e164.startswith("REFERRAL_"):
            referral_only.append(c)
        elif err:
            invalid_phone.append((c, err))
        else:
            phone_groups[e164].append(c)

    persons = []

    # ── Regular phone-keyed records ──
    for e164, group in phone_groups.items():
        raw_digits = re.sub(r"\D", "", e164)

        # Collect all names across the group
        all_names = list({canonical_name(c.get("firstName"), c.get("lastName"))
                          for c in group if canonical_name(c.get("firstName"), c.get("lastName"))})
        # Primary name = most-recent record (last in list is newest)
        primary = group[-1]
        primary_name = canonical_name(primary.get("firstName"), primary.get("lastName"))
        aliases = [n for n in all_names if n != primary_name]

        # Merge all jobHistory across group
        jh_all = []
        for c in group:
            for j in (c.get("jobHistory") or []):
                j["_kv_phone"] = c.get("phone")   # audit trail
                jh_all.append(j)

        # Determine confidence
        if len(group) == 1:
            confidence = "high"
            confidence_reason = "single_record_phone_match"
        else:
            # Multiple KV records with same phone → merge
            confidence = "medium"
            confidence_reason = f"phone_merge_{len(group)}_records"

        # Check for commercial
        any_commercial = any(is_commercial(c) for c in group)

        # Apply locked spec overrides
        # raw_digits is 11-digit E.164 body (e.g. "19542493300"); spec keys are 10-digit
        spec_key = raw_digits[1:] if len(raw_digits) == 11 and raw_digits.startswith("1") else raw_digits
        spec = SPEC_LOCKED_PERSONS.get(spec_key, {})
        if spec.get("aliases_include"):
            # SET aliases directly from spec — don't rely on KV merges producing them
            aliases = list(spec["aliases_include"])

        # Build person candidate
        person_id = make_id("person", raw_digits)
        p = {
            "personId":              person_id,
            "e164Phone":             e164,
            "rawPhone":              primary.get("phone"),
            "firstName":             primary.get("firstName") or "",
            "lastName":              primary.get("lastName") or "",
            "businessName":          primary.get("businessName") or (primary.get("firstName") if any_commercial else None),
            "aliases":               aliases,
            "email":                 primary.get("email") or "",
            "address":               primary.get("address") or "",
            "city":                  primary.get("city") or "",
            "zip":                   primary.get("zip") or "",
            "notes":                 primary.get("notes") or "",
            "alerts":                primary.get("alerts") or [],
            "isHomeowner":           spec.get("isHomeowner", not any_commercial),
            "isReferralSource":      spec.get("isReferralSource", False),
            "isCommercialAccount":   any_commercial,
            "isReferralOnly":        bool(primary.get("isReferralOnly")),
            "preferredPaymentMethod": primary.get("paymentMethod") or "",
            "preferredContact":      "phone",
            "doNotContact":          bool(primary.get("optOut")),
            "internalNotes":         primary.get("notes") or "",
            "kv_records":            len(group),
            "kv_jobHistory":         jh_all,
            "kv_scheduledStatus":    primary.get("scheduledStatus"),
            "kv_tags":               primary.get("tags") or [],
            "migrationConfidence":   confidence,
            "migrationConfidenceReason": confidence_reason,
            "specNote":              spec.get("note"),
            "addressRelationships":  spec.get("address_relationships", {}),
        }
        persons.append(p)

    # ── Referral-only records ──
    for c in referral_only:
        pid = make_id("person", "ref", c.get("phone","").replace("REFERRAL_",""))
        p = {
            "personId":            pid,
            "e164Phone":           c.get("phone"),
            "rawPhone":            c.get("phone"),
            "firstName":           c.get("firstName") or "",
            "lastName":            c.get("lastName") or "",
            "aliases":             [],
            "isReferralSource":    True,
            "isReferralOnly":      True,
            "isCommercialAccount": False,
            "isHomeowner":         False,
            "doNotContact":        True,
            "kv_records":          1,
            "kv_jobHistory":       [],
            "kv_scheduledStatus":  None,
            "migrationConfidence": "medium",
            "migrationConfidenceReason": "referral_placeholder_phone",
            "specNote": "REFERRAL_* phone — referral source marker, not a real customer",
        }
        persons.append(p)

    # ── No-phone records ──
    for c in no_phone:
        name = canonical_name(c.get("firstName"), c.get("lastName"))
        pid  = make_id("person", "nophone", re.sub(r"[^\w]","_",name.lower())[:20])
        p = {
            "personId":            pid,
            "e164Phone":           None,
            "rawPhone":            None,
            "firstName":           c.get("firstName") or "",
            "lastName":            c.get("lastName") or "",
            "aliases":             [],
            "isReferralSource":    False,
            "isReferralOnly":      bool(c.get("isReferralOnly")),
            "isCommercialAccount": is_commercial(c),
            "isHomeowner":         True,
            "doNotContact":        bool(c.get("optOut")),
            "kv_records":          1,
            "kv_jobHistory":       c.get("jobHistory") or [],
            "kv_scheduledStatus":  c.get("scheduledStatus"),
            "migrationConfidence": "low",
            "migrationConfidenceReason": "no_phone",
            "specNote": "No phone — requires manual review",
        }
        persons.append(p)

    # ── Invalid phone records ──
    for c, err in invalid_phone:
        name = canonical_name(c.get("firstName"), c.get("lastName"))
        pid  = make_id("person", "badphone", re.sub(r"[^\w]","_",name.lower())[:20])
        p = {
            "personId":            pid,
            "e164Phone":           None,
            "rawPhone":            c.get("phone"),
            "firstName":           c.get("firstName") or "",
            "lastName":            c.get("lastName") or "",
            "aliases":             [],
            "isReferralSource":    False,
            "isReferralOnly":      False,
            "isCommercialAccount": is_commercial(c),
            "isHomeowner":         True,
            "doNotContact":        bool(c.get("optOut")),
            "kv_records":          1,
            "kv_jobHistory":       c.get("jobHistory") or [],
            "kv_scheduledStatus":  c.get("scheduledStatus"),
            "migrationConfidence": "low",
            "migrationConfidenceReason": f"invalid_phone:{err}",
            "specNote": f"Invalid phone format: {c.get('phone')} — {err}",
        }
        persons.append(p)

    return persons


# ── Phase 3: Property extraction ───────────────────────────────────────────────

def extract_properties(persons):
    """
    Deduplicate properties by (normalized_address, city).
    Returns (property_dict, person_property_list).
    """
    prop_map  = {}   # norm_key → property_dict
    pp_links  = []   # PersonProperty candidates

    for p in persons:
        person_id = p["personId"]
        # Primary address
        primary_street = p.get("address","")
        primary_city   = p.get("city","")
        primary_key    = normalize_address(primary_street, primary_city)

        addr_rels = p.get("addressRelationships", {})

        if primary_key and primary_street:
            if primary_key not in prop_map:
                prop_map[primary_key] = {
                    "propertyId":    make_id("prop", primary_key[:40]),
                    "streetAddress": primary_street,
                    "city":          primary_city,
                    "state":         "FL",
                    "zip":           p.get("zip",""),
                    "gateCode":      _extract_gate_code(p.get("notes","") or ""),
                    "accessNotes":   p.get("notes","") or "",
                    "migratedFrom":  "kv_customer_address",
                }
            # Relationship for primary address — commercial accounts are managers, not owners
            default_rel = "manager" if p.get("isCommercialAccount") else "owner"
            rel = addr_rels.get(primary_street, default_rel)
            pp_links.append({
                "personId":      person_id,
                "propertyId":    prop_map[primary_key]["propertyId"],
                "relationship":  rel,
                "primaryContact": 1,
                "address_key":   primary_key,
            })

        # Per-job addresses from jobHistory
        seen_job_addrs = set()
        for job in (p.get("kv_jobHistory") or []):
            ja = (job.get("address") or "").strip()
            jc = (job.get("city") or primary_city).strip()
            if not ja:
                continue
            jk = normalize_address(ja, jc)
            if not jk or jk == primary_key or jk in seen_job_addrs:
                continue
            seen_job_addrs.add(jk)
            if jk not in prop_map:
                prop_map[jk] = {
                    "propertyId":    make_id("prop", jk[:40]),
                    "streetAddress": ja,
                    "city":          jc,
                    "state":         "FL",
                    "zip":           "",
                    "gateCode":      None,
                    "accessNotes":   None,
                    "migratedFrom":  "kv_jobhistory_address",
                }
            rel = addr_rels.get(ja, "referrer")   # per-job addr defaults to referrer
            # Avoid duplicate PersonProperty links
            dup = any(lk["personId"] == person_id and lk["propertyId"] == prop_map[jk]["propertyId"]
                      for lk in pp_links)
            if not dup:
                pp_links.append({
                    "personId":      person_id,
                    "propertyId":    prop_map[jk]["propertyId"],
                    "relationship":  rel,
                    "primaryContact": 0,
                    "address_key":   jk,
                })

    return prop_map, pp_links


def _extract_gate_code(notes_text):
    if not notes_text:
        return None
    rx = re.compile(r'\b(gate|lockbox|keypad|access\s*code|entry\s*code|code\s*[:#]?\s*\d)', re.IGNORECASE)
    for line in notes_text.splitlines():
        if rx.search(line):
            # Extract trailing digits
            m = re.search(r'\b\d{3,6}#?\b', line)
            if m:
                return m.group(0)
            return line.strip()[:60]
    return None


# ── Phase 4: Job extraction ────────────────────────────────────────────────────

def extract_jobs(persons, prop_map):
    """
    Build proposed Job records from jobHistory entries.
    Each jh entry → 1 Job row.
    Returns (jobs_list, stats_dict).
    """
    jobs         = []
    date_rejects = []
    unmapped_svcs = []
    auto_assigned = 0

    for p in persons:
        person_id   = p["personId"]
        primary_addr_key = normalize_address(p.get("address",""), p.get("city",""))
        primary_prop_id = None
        if primary_addr_key and primary_addr_key in prop_map:
            primary_prop_id = prop_map[primary_addr_key]["propertyId"]

        for jh in (p.get("kv_jobHistory") or []):
            # Resolve property for this job
            ja  = (jh.get("address") or "").strip()
            jc  = (jh.get("city") or p.get("city","")).strip()
            jk  = normalize_address(ja, jc) if ja else None
            if jk and jk in prop_map:
                prop_id = prop_map[jk]["propertyId"]
            elif primary_prop_id:
                prop_id = primary_prop_id
            else:
                # No resolvable address — create a placeholder Property so the foreign key holds
                placeholder_key = f"__unknown__|{person_id}"
                if placeholder_key not in prop_map:
                    placeholder_id = make_id("prop", "unknown", person_id[-20:])
                    prop_map[placeholder_key] = {
                        "propertyId":    placeholder_id,
                        "streetAddress": "UNKNOWN",
                        "city":          "UNKNOWN",
                        "state":         "FL",
                        "zip":           "",
                        "gateCode":      None,
                        "accessNotes":   None,
                        "migratedFrom":  "placeholder_no_address",
                        "migrationConfidence": "low",
                        "migrationNotes": f"No address in KV for person {person_id}. Placeholder preserves FK. Resolve manually.",
                    }
                prop_id = prop_map[placeholder_key]["propertyId"]

            # Date
            raw_date = jh.get("date") or jh.get("completedAt","")[:10] if jh.get("completedAt") else jh.get("date")
            norm_date, date_err = normalize_date(raw_date)
            if date_err:
                date_rejects.append({
                    "personId": person_id, "raw_date": raw_date, "error": date_err
                })

            # Amount
            amount = float(jh.get("amount") or jh.get("total") or 0)

            # Services
            svc_text       = jh.get("services") or jh.get("jobNotes") or ""
            canonical_svcs, unmapped = map_services(svc_text)
            if unmapped:
                unmapped_svcs.append({
                    "personId": person_id, "raw": svc_text, "unmapped": unmapped
                })

            # Source mapping
            src = jh.get("source") or "manual_repair"
            if src not in ("quote_form", "phone_quote", "reschedule", "manual_repair",
                           "csv_backfill_2024", "csv_backfill_2025", "csv_backfill_2026"):
                if src.startswith("csv_backfill"):
                    src = src  # preserve
                elif src == "calendar_completion":
                    src = "phone_quote"
                else:
                    src = "manual_repair"

            # Job ID — preserve existing or generate
            raw_job_id = jh.get("jobId")
            job_id = raw_job_id if raw_job_id else make_id("job", person_id, norm_date or "nodate")
            if not raw_job_id:
                auto_assigned += 1

            # Payment
            paid_at = jh.get("paidAt") or (jh.get("paymentInfo") or {}).get("paidAt")
            pay_method = (jh.get("paymentMethod") or jh.get("payment") or
                          (jh.get("paymentInfo") or {}).get("method") or "")
            payment_status = "paid" if paid_at else ("unpaid" if amount > 0 else "unpaid")

            job = {
                "jobId":             job_id,
                "payerId":           person_id,
                "propertyId":        prop_id,
                "scheduledDate":     jh.get("date") or norm_date,
                "state":             "completed" if jh.get("status") == "completed" else "completed",
                "completedAt":       jh.get("completedAt"),
                "servicesRequested": json.dumps(canonical_svcs),
                "servicesRaw":       svc_text,
                "amount":            amount,
                "paymentMethod":     pay_method,
                "paymentStatus":     payment_status,
                "paidAt":            paid_at,
                "rigId":             jh.get("rigId") or jh.get("rig"),
                "source":            src,
                "jobNotes":          " | ".join(unmapped) if unmapped else None,
                "migratedFrom":      f"kv_jobhistory:{person_id}",
                "migrationVersion":  MIGRATION_VERSION,
                "migratedAt":        datetime.now(timezone.utc).isoformat(),
                "migrationConfidence": p["migrationConfidence"],
                "migrationNotes":    f"orig_jobId:{raw_job_id or 'none'};orig_date:{raw_date}",
                "_date_err":         date_err,
                "_prop_missing":     prop_id is None,
            }
            jobs.append(job)

        # Also capture currently-scheduled / pending job from scheduledStatus
        # (only if NOT in jobHistory — i.e., not yet completed)
        ss = p.get("kv_scheduledStatus") or {}
        if ss.get("state") in ("scheduled", "in_progress") and ss.get("scheduledDate"):
            ss_job_id = make_id("job", person_id, ss["scheduledDate"], "scheduled")
            ss_in_jh = any(j["jobId"] == ss_job_id for j in jobs)
            if not ss_in_jh and ss.get("approvedAmount", 0) > 0:
                norm_date, _ = normalize_date(ss.get("scheduledDate"))
                canonical_svcs, unmapped = map_services(ss.get("jobNotes",""))
                jobs.append({
                    "jobId":             ss_job_id,
                    "payerId":           person_id,
                    "propertyId":        primary_prop_id,
                    "scheduledDate":     norm_date,
                    "state":             "scheduled",
                    "completedAt":       None,
                    "servicesRequested": json.dumps(canonical_svcs),
                    "servicesRaw":       ss.get("jobNotes",""),
                    "amount":            float(ss.get("approvedAmount", 0)),
                    "paymentMethod":     None,
                    "paymentStatus":     "unpaid",
                    "paidAt":            None,
                    "rigId":             ss.get("rig"),
                    "source":            "phone_quote",
                    "jobNotes":          None,
                    "migratedFrom":      f"kv_scheduledstatus:{person_id}",
                    "migrationVersion":  MIGRATION_VERSION,
                    "migratedAt":        datetime.now(timezone.utc).isoformat(),
                    "migrationConfidence": p["migrationConfidence"],
                    "migrationNotes":    "from_scheduled_status_not_in_jobhistory",
                    "_date_err":         None,
                    "_prop_missing":     primary_prop_id is None,
                })

    stats = {
        "date_rejects":   date_rejects,
        "unmapped_svcs":  unmapped_svcs,
        "auto_assigned_ids": auto_assigned,
    }
    return jobs, stats


# ── Phase 5: Spec-vs-data gap detection ────────────────────────────────────────

def detect_spec_gaps(persons, prop_map):
    """Surface known spec decisions that don't match the actual data."""
    gaps = []

    # Robinson Nolasco — spec says phone 954-687-7537, aliases [Robinson-referall, Ryan Robinson, Robinson Referral]
    rob_phones = [p for p in persons if "robinson" in (p.get("firstName","") + p.get("lastName","")).lower()]
    if not any(p.get("e164Phone") == "+19546875737" for p in rob_phones):
        gaps.append({
            "type": "spec_reference_not_found",
            "spec_item": "Robinson Nolasco",
            "detail": "Spec references phone 954-687-7537 with aliases [Robinson-referall, Ryan Robinson, Robinson Referral]. "
                      f"Phone not in data. Found {len(rob_phones)} Robinson records with different phones: "
                      + str([(p['firstName'], p['lastName'], p['rawPhone']) for p in rob_phones]),
            "action": "MANUAL_REVIEW — verify correct phone number before migration",
        })

    # Hart's Painting — spec says REFERRAL_* phone pattern for referral sources
    harts_ref = [p for p in persons if (p.get("e164Phone") or "").startswith("REFERRAL_")
                 and "hart" in (p.get("firstName","") + p.get("lastName","")).lower()]
    if not harts_ref:
        gaps.append({
            "type": "spec_pattern_not_found",
            "spec_item": "Hart's Painting referral",
            "detail": "Spec expects a REFERRAL_* phone record for Hart's Painting. "
                      "Zero REFERRAL_* records exist in current KV data. "
                      "Hart's referral pattern may not have been implemented in KV.",
            "action": "MANUAL_REVIEW — confirm how Hart's jobs are attributed; may need to be added post-migration",
        })

    # Kristina Seeber — spec says 4 properties; only 3 appear in data
    seeber = next((p for p in persons if p.get("e164Phone") == "+19542493300"), None)
    if seeber:
        spec_missing = [a for a in ["6520 SW 18 Ct"] if
                        not any(normalize_address(a, "") in k for k in prop_map)]
        if spec_missing:
            gaps.append({
                "type": "spec_address_not_in_data",
                "spec_item": "Kristina Seeber — 4th property",
                "detail": f"Spec says 4 properties. 6520 SW 18 Ct not found in jobHistory. "
                           "Only 3 appear in KV: Marathon Lane (primary), 5501 Monroe St, 7000 Hope St.",
                "action": "LOW — omit 6520 SW 18 Ct from migration; add manually post-migration if needed",
            })

    return gaps


# ── Phase 6: Manifest generation ───────────────────────────────────────────────

def build_manifest(persons, prop_map, pp_links, jobs, job_stats, spec_gaps, snap_name):
    now_str = datetime.now(timezone.utc).isoformat()

    high   = [p for p in persons if p["migrationConfidence"] == "high"]
    medium = [p for p in persons if p["migrationConfidence"] == "medium"]
    low    = [p for p in persons if p["migrationConfidence"] == "low"]

    alias_merges = [
        {"phone": p["e164Phone"], "primary_name": canonical_name(p["firstName"], p["lastName"]),
         "aliases": p["aliases"], "kv_records_merged": p["kv_records"]}
        for p in persons if p["aliases"] or p["kv_records"] > 1
    ]

    flagged = [
        {"personId": p["personId"], "name": canonical_name(p["firstName"], p["lastName"]),
         "phone": p["rawPhone"], "confidence": p["migrationConfidence"],
         "reason": p["migrationConfidenceReason"], "note": p.get("specNote","")}
        for p in low
    ] + [
        {"personId": p["personId"], "name": canonical_name(p["firstName"], p["lastName"]),
         "phone": p["rawPhone"], "confidence": p["migrationConfidence"],
         "reason": p["migrationConfidenceReason"], "note": p.get("specNote","")}
        for p in medium if p["kv_records"] > 1  # multi-record merges
    ]

    jobs_missing_prop = [j for j in jobs if j["_prop_missing"]]
    jobs_with_date_err = [j for j in jobs if j["_date_err"]]

    # Transformation rule counts
    rule_counts = {
        "phone_normalized_to_e164":    len([p for p in persons if p.get("e164Phone") and not p["e164Phone"].startswith("REFERRAL_")]),
        "referral_placeholder":        len([p for p in persons if (p.get("e164Phone") or "").startswith("REFERRAL_")]),
        "no_phone":                    len([p for p in persons if not p.get("e164Phone")]),
        "phone_merge_multi_record":    len([p for p in persons if p["kv_records"] > 1]),
        "commercial_account":          len([p for p in persons if p.get("isCommercialAccount")]),
        "referral_source":             len([p for p in persons if p.get("isReferralSource")]),
        "per_job_address_properties":  len([pv for pv in prop_map.values() if pv["migratedFrom"] == "kv_jobhistory_address"]),
        "date_format_rejections":      len(job_stats["date_rejects"]),
        "services_unmapped_fragments": len(job_stats["unmapped_svcs"]),
        "job_ids_auto_assigned":       job_stats["auto_assigned_ids"],
    }

    manifest = {
        "migrationVersion":               MIGRATION_VERSION,
        "generatedAt":                    now_str,
        "sourceSnapshot":                 snap_name,
        "status":                         "preview_only — NO D1 WRITES",
        "estimated_persons":              len(persons),
        "estimated_properties":           len(prop_map),
        "estimated_person_property_links": len(pp_links),
        "estimated_jobs":                 len(jobs),
        "high_confidence_count":          len(high),
        "medium_confidence_count":        len(medium),
        "low_confidence_count":           len(low),
        "alias_merges":                   alias_merges,
        "flagged_for_review":             flagged,
        "spec_vs_data_gaps":              spec_gaps,
        "unresolved_referrers":           [],   # Hart's pattern — see spec_gaps
        "date_format_rejections":         job_stats["date_rejects"][:20],
        "services_unmapped_sample":       job_stats["unmapped_svcs"][:20],
        "jobs_missing_property":          [j["jobId"] for j in jobs_missing_prop],
        "missing_entry_numbers_auto_assigned": job_stats["auto_assigned_ids"],
        "transformation_rule_counts":     rule_counts,
        # Spot-check samples — key customers for Tyler's review
        "spot_checks": {},
    }
    return manifest


def add_spot_checks(manifest, persons, prop_map, pp_links, jobs):
    """Populate spot_checks section with the key customers from the spec."""
    checks = {}
    spot_phones = {
        "Kristina Seeber":     "+19542493300",
        "Audrey Frank Seeber": "+19549149262",
        "Property Keepers":    "+17542813444",
        "Bob Fishman":         "+19542531264",
        "David Leshner":       "+13053429527",
    }
    for label, e164 in spot_phones.items():
        p = next((x for x in persons if x.get("e164Phone") == e164), None)
        if not p:
            checks[label] = {"status": "NOT_FOUND", "e164": e164}
            continue
        person_id = p["personId"]
        my_links  = [lk for lk in pp_links if lk["personId"] == person_id]
        my_props  = [prop_map[lk["address_key"]] for lk in my_links if lk["address_key"] in prop_map]
        my_jobs   = [j for j in jobs if j["payerId"] == person_id]
        checks[label] = {
            "personId":      person_id,
            "name":          canonical_name(p["firstName"], p["lastName"]),
            "aliases":       p["aliases"],
            "confidence":    p["migrationConfidence"],
            "isCommercial":  p.get("isCommercialAccount"),
            "isReferralSrc": p.get("isReferralSource"),
            "kv_records":    p["kv_records"],
            "properties":    [{"addr": pr["streetAddress"], "city": pr["city"],
                               "rel": lk["relationship"]} for pr, lk in zip(my_props, my_links)],
            "job_count":     len(my_jobs),
            "job_dates":     sorted([j["scheduledDate"] or "" for j in my_jobs if j["scheduledDate"]]),
            "total_revenue": round(sum(j["amount"] for j in my_jobs), 2),
        }
    manifest["spot_checks"] = checks


# ── Main ───────────────────────────────────────────────────────────────────────

def main(snap_path=None):
    custs, snap_name = load_snapshot(snap_path)

    print("\n── Phase 2: Identity resolution ──")
    persons = resolve_identities(custs)
    high   = sum(1 for p in persons if p["migrationConfidence"] == "high")
    medium = sum(1 for p in persons if p["migrationConfidence"] == "medium")
    low    = sum(1 for p in persons if p["migrationConfidence"] == "low")
    merges = sum(1 for p in persons if p["kv_records"] > 1)
    print(f"  {len(persons)} proposed persons  (high={high} medium={medium} low={low})")
    print(f"  {merges} phone-merge groups (multiple KV records → 1 Person)")

    print("\n── Phase 3: Property extraction ──")
    prop_map, pp_links = extract_properties(persons)
    primary_props  = sum(1 for pv in prop_map.values() if pv["migratedFrom"] == "kv_customer_address")
    per_job_props  = sum(1 for pv in prop_map.values() if pv["migratedFrom"] == "kv_jobhistory_address")
    print(f"  {len(prop_map)} unique properties  ({primary_props} from primary addr, {per_job_props} from per-job addr)")
    print(f"  {len(pp_links)} PersonProperty links")

    print("\n── Phase 4: Job extraction ──")
    jobs, job_stats = extract_jobs(persons, prop_map)
    completed = sum(1 for j in jobs if j["state"] == "completed")
    scheduled = sum(1 for j in jobs if j["state"] == "scheduled")
    no_prop   = sum(1 for j in jobs if j["_prop_missing"])
    print(f"  {len(jobs)} proposed jobs  ({completed} completed, {scheduled} scheduled)")
    print(f"  {len(job_stats['date_rejects'])} date format rejections")
    print(f"  {len(job_stats['unmapped_svcs'])} jobs with unmapped service fragments")
    print(f"  {no_prop} jobs with no resolvable propertyId")
    print(f"  {job_stats['auto_assigned_ids']} job IDs auto-assigned (originals missing)")

    print("\n── Phase 5: Spec-vs-data gap detection ──")
    spec_gaps = detect_spec_gaps(persons, prop_map)
    print(f"  {len(spec_gaps)} gaps between locked spec and actual KV data")
    for g in spec_gaps:
        print(f"  [{g['type']}] {g['spec_item']}: {g['action']}")

    print("\n── Phase 6: Manifest generation ──")
    manifest = build_manifest(persons, prop_map, pp_links, jobs, job_stats, spec_gaps, snap_name)
    add_spot_checks(manifest, persons, prop_map, pp_links, jobs)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%S")
    out_path = SNAP_DIR / f"manifest_preview_{ts}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False, default=str)
    print(f"\n  Manifest written: {out_path.name}")

    # ── Human-readable summary ──
    print("\n" + "═"*60)
    print("MANIFEST PREVIEW — Hour 3 Identity Resolution Pass")
    print("═"*60)
    print(f"Source:            {snap_name}")
    print(f"KV customers in:   {len(custs)}")
    print(f"")
    print(f"Proposed Persons:  {len(persons)}")
    print(f"  High confidence: {high}   (~auto-write)")
    print(f"  Medium:          {medium}   (~auto-write with note)")
    print(f"  Low:             {low}   (manual review queue)")
    print(f"  Alias merges:    {merges}   (multiple KV records → 1 Person)")
    print(f"")
    print(f"Proposed Properties: {len(prop_map)}")
    print(f"  From primary addr: {primary_props}")
    print(f"  From per-job addr: {per_job_props}  (multi-property customers)")
    print(f"PersonProperty links:{len(pp_links)}")
    print(f"")
    print(f"Proposed Jobs:     {len(jobs)}")
    print(f"  Completed:       {completed}")
    print(f"  Scheduled:       {scheduled}")
    print(f"  Date rejects:    {len(job_stats['date_rejects'])}")
    print(f"  Missing propId:  {no_prop}")
    print(f"")
    print(f"Spec gaps flagged: {len(spec_gaps)}")
    for g in spec_gaps:
        print(f"  • {g['spec_item']}: {g['action']}")
    print(f"")
    print(f"Manifest:          {out_path.name}")
    print(f"Status:            PREVIEW ONLY — zero D1 writes")
    print("═"*60)

    return manifest


# ── SQL helpers ────────────────────────────────────────────────────────────────

def sv(v):
    """Convert a Python value to a SQLite literal string."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, dict)):
        return sv(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
    return "'" + str(v).replace("'", "''") + "'"


def build_insert_sql(table, cols, rows, batch_size=200):
    """
    Build batched multi-row INSERT statements.
    Returns a list of SQL strings, each inserting up to batch_size rows.
    """
    col_list = ", ".join(cols)
    stmts = []
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        values = ",\n  ".join(
            "(" + ", ".join(sv(row.get(c)) for c in cols) + ")"
            for row in batch
        )
        stmts.append(f"INSERT INTO {table} ({col_list}) VALUES\n  {values};")
    return stmts


def wrangler_exec_file(sql_content, label):
    """Write sql_content to a temp file and execute via wrangler d1 execute --file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql",
                                     prefix=f"pc_{label}_",
                                     delete=False, encoding="utf-8") as tf:
        tf.write(sql_content)
        tmp_path = tf.name
    try:
        cmd = [
            "npx", "wrangler", "d1", "execute", D1_DB_NAME,
            "--remote", f"--config={WRANGLER_CFG}",
            f"--file={tmp_path}",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            print(f"  ❌  {label} FAILED (exit {result.returncode})")
            print(result.stderr[-2000:] if result.stderr else "(no stderr)")
            return False
        print(f"  ✅  {label} — OK")
        return True
    finally:
        os.unlink(tmp_path)


# ── Dry-run SQL generation ──────────────────────────────────────────────────────

NOW = datetime.now(timezone.utc).isoformat()

PERSON_COLS = [
    "personId", "firstName", "lastName", "businessName", "aliases",
    "primaryPhone", "alternatePhones", "email", "preferredContact",
    "isHomeowner", "isReferralSource", "isCommercialAccount", "isReferralOnly",
    "preferredPaymentMethod", "doNotContact", "doNotService",
    "billingNotes", "internalNotes",
    "createdAt", "modifiedAt",
    "migratedFrom", "migrationVersion", "migratedAt", "migrationConfidence", "migrationNotes",
]

PROPERTY_COLS = [
    "propertyId", "googlePlaceId", "streetAddress", "unit",
    "city", "state", "zip", "zipPlus4",
    "latitude", "longitude", "communityName", "county",
    "sqft", "stories", "roofType", "yearBuilt",
    "gateCode", "accessNotes", "milesFromHomeBase",
    "createdAt", "modifiedAt",
    "migratedFrom", "migrationVersion", "migratedAt", "migrationConfidence", "migrationNotes",
]

PP_COLS = [
    "personId", "propertyId", "relationship", "primaryContact",
    "startedAt", "endedAt", "notes",
]

JOB_COLS = [
    "jobId", "payerId", "propertyId", "referredById",
    "scheduledDate", "scheduledTimeWindow", "estimatedStartTime", "estimatedEndTime",
    "state", "completedAt", "cancelledAt", "cancellationReason",
    "servicesRequested", "servicesPerformed", "servicesRaw",
    "amount", "paymentMethod", "paymentStatus", "paidAt", "receiptSentAt",
    "rigId", "crewMembers",
    "reviewRequested", "reviewRequestedAt", "reviewStatus",
    "isReferralOnly", "isCommercialJob", "isMultiBuildingJob",
    "drivetimeFromPreviousJob", "milesFromPreviousJob",
    "jobNotes", "internalNotes",
    "createdAt", "modifiedAt",
    "source", "migratedFrom", "migrationVersion", "migratedAt",
    "migrationConfidence", "migrationNotes",
]

MANIFEST_COLS = [
    "migrationId", "migrationVersion", "startedAt", "completedAt", "status",
    "totalRecordsProcessed", "personsCreated", "propertiesCreated",
    "jobsCreated", "aliasesMerged", "flaggedForReview", "unresolvedReferrers",
    "transformationsApplied", "summary", "notes",
]


def person_to_row(p):
    notes = " | ".join(filter(None, [
        p.get("migrationConfidenceReason"), p.get("specNote")
    ]))
    return {
        "personId":               p["personId"],
        "firstName":              p.get("firstName") or None,
        "lastName":               p.get("lastName") or None,
        "businessName":           p.get("businessName") or None,
        "aliases":                json.dumps(p.get("aliases") or [], ensure_ascii=False),
        "primaryPhone":           p.get("e164Phone") or None,
        "alternatePhones":        "[]",
        "email":                  p.get("email") or None,
        "preferredContact":       p.get("preferredContact") or "phone",
        "isHomeowner":            1 if p.get("isHomeowner") else 0,
        "isReferralSource":       1 if p.get("isReferralSource") else 0,
        "isCommercialAccount":    1 if p.get("isCommercialAccount") else 0,
        "isReferralOnly":         1 if p.get("isReferralOnly") else 0,
        "preferredPaymentMethod": p.get("preferredPaymentMethod") or None,
        "doNotContact":           1 if p.get("doNotContact") else 0,
        "doNotService":           0,
        "billingNotes":           None,
        "internalNotes":          p.get("internalNotes") or p.get("notes") or None,
        "createdAt":              NOW,
        "modifiedAt":             NOW,
        "migratedFrom":           "kv_customer_db",
        "migrationVersion":       MIGRATION_VERSION,
        "migratedAt":             NOW,
        "migrationConfidence":    p.get("migrationConfidence"),
        "migrationNotes":         notes or None,
    }


def property_to_row(prop):
    return {
        "propertyId":         prop["propertyId"],
        "googlePlaceId":      None,
        "streetAddress":      prop.get("streetAddress") or "UNKNOWN",
        "unit":               None,
        "city":               prop.get("city") or "UNKNOWN",
        "state":              prop.get("state") or "FL",
        "zip":                prop.get("zip") or None,
        "zipPlus4":           None,
        "latitude":           None,
        "longitude":          None,
        "communityName":      None,
        "county":             None,
        "sqft":               None,
        "stories":            None,
        "roofType":           None,
        "yearBuilt":          None,
        "gateCode":           prop.get("gateCode") or None,
        "accessNotes":        prop.get("accessNotes") or None,
        "milesFromHomeBase":  None,
        "createdAt":          NOW,
        "modifiedAt":         NOW,
        "migratedFrom":       prop.get("migratedFrom") or "kv_customer_address",
        "migrationVersion":   MIGRATION_VERSION,
        "migratedAt":         NOW,
        "migrationConfidence": prop.get("migrationConfidence") or "high",
        "migrationNotes":     prop.get("migrationNotes") or None,
    }


def pp_to_row(lk):
    return {
        "personId":      lk["personId"],
        "propertyId":    lk["propertyId"],
        "relationship":  lk["relationship"],
        "primaryContact": lk.get("primaryContact", 0),
        "startedAt":     None,
        "endedAt":       None,
        "notes":         None,
    }


def job_to_row(j):
    return {
        "jobId":                    j["jobId"],
        "payerId":                  j["payerId"],
        "propertyId":               j["propertyId"],
        "referredById":             None,
        "scheduledDate":            j.get("scheduledDate") or None,
        "scheduledTimeWindow":      None,
        "estimatedStartTime":       None,
        "estimatedEndTime":         None,
        "state":                    j.get("state") or "completed",
        "completedAt":              j.get("completedAt") or None,
        "cancelledAt":              None,
        "cancellationReason":       None,
        "servicesRequested":        j.get("servicesRequested") or "[]",
        "servicesPerformed":        None,
        "servicesRaw":              j.get("servicesRaw") or None,
        "amount":                   float(j.get("amount") or 0),
        "paymentMethod":            j.get("paymentMethod") or None,
        "paymentStatus":            j.get("paymentStatus") or "unpaid",
        "paidAt":                   j.get("paidAt") or None,
        "receiptSentAt":            None,
        "rigId":                    j.get("rigId") or None,
        "crewMembers":              None,
        "reviewRequested":          0,
        "reviewRequestedAt":        None,
        "reviewStatus":             None,
        "isReferralOnly":           0,
        "isCommercialJob":          0,
        "isMultiBuildingJob":       0,
        "drivetimeFromPreviousJob": None,
        "milesFromPreviousJob":     None,
        "jobNotes":                 j.get("jobNotes") or None,
        "internalNotes":            None,
        "createdAt":                NOW,
        "modifiedAt":               NOW,
        "source":                   j.get("source") or "manual_repair",
        "migratedFrom":             j.get("migratedFrom") or "kv_jobhistory",
        "migrationVersion":         MIGRATION_VERSION,
        "migratedAt":               NOW,
        "migrationConfidence":      j.get("migrationConfidence") or "high",
        "migrationNotes":           j.get("migrationNotes") or None,
    }


def manifest_to_row(manifest, persons, prop_map, jobs):
    return {
        "migrationId":             str(uuid.uuid4()),
        "migrationVersion":        MIGRATION_VERSION,
        "startedAt":               NOW,
        "completedAt":             NOW,
        "status":                  "dryrun_complete",
        "totalRecordsProcessed":   len(persons),
        "personsCreated":          len(persons),
        "propertiesCreated":       len(prop_map),
        "jobsCreated":             len(jobs),
        "aliasesMerged":           sum(1 for p in persons if p.get("aliases")),
        "flaggedForReview":        manifest.get("low_confidence_count", 0),
        "unresolvedReferrers":     0,
        "transformationsApplied":  json.dumps(manifest.get("transformation_rule_counts", {})),
        "summary":                 (
            f"{len(persons)} persons, {len(prop_map)} properties, "
            f"{len(jobs)} jobs. Dryrun pass — no canonical writes."
        ),
        "notes":                   "Hour 4 dry-run. Verify spot-checks before canonical write.",
    }


# ── write_dryrun ───────────────────────────────────────────────────────────────

def _write_tables(table_map, label, allow_delete=True):
    """
    Shared insert engine for both dryrun and canonical targets.
    table_map: OrderedDict of table_name → (cols, rows)
    allow_delete: dryrun=True (idempotent); canonical=False (guard against overwrite)
    """
    print("\n" + "═"*60)
    print(f"{label}")
    print("═"*60)

    if not allow_delete:
        # Canonical safety: verify all target tables are empty before writing
        print("\n  Pre-write canonical emptiness check...")
        for table in table_map:
            result = subprocess.run(
                ["npx", "wrangler", "d1", "execute", D1_DB_NAME,
                 "--remote", f"--config={WRANGLER_CFG}",
                 "--command", f"SELECT COUNT(*) n FROM {table};"],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                print(f"  ❌  Cannot verify {table}: {result.stderr[-200:]}")
                return False
            try:
                d = json.loads(result.stdout[result.stdout.index("["):])
                n = d[0]["results"][0]["n"]
                if n != 0:
                    print(f"  ❌  STOP — {table} already has {n} rows. Restore from time-travel baseline.")
                    return False
                print(f"  ✅  {table}: empty")
            except Exception as e:
                print(f"  ❌  Parse error checking {table}: {e}")
                return False

    for table, (cols, rows) in table_map.items():
        print(f"\n  {table}: {len(rows)} rows")
        if allow_delete:
            if not wrangler_exec_file(f"DELETE FROM {table};\n", f"{table}_clear"):
                return False
        stmts = build_insert_sql(table, cols, rows, batch_size=25)
        for i, stmt in enumerate(stmts):
            lbl = f"{table}_batch{i+1}of{len(stmts)}"
            if not wrangler_exec_file(stmt + "\n", lbl):
                print(f"  STOPPING.")
                return False
        print(f"    → {len(stmts)} batch(es) written")

    print(f"\n✅  {label} complete.")
    return True


def write_dryrun(persons, prop_map, pp_links, jobs, manifest):
    return _write_tables({
        "Person_dryrun":            (PERSON_COLS,   [person_to_row(p) for p in persons]),
        "Property_dryrun":          (PROPERTY_COLS, [property_to_row(v) for v in prop_map.values()]),
        "PersonProperty_dryrun":    (PP_COLS,       [pp_to_row(lk) for lk in pp_links]),
        "Job_dryrun":               (JOB_COLS,      [job_to_row(j) for j in jobs]),
        "MigrationManifest_dryrun": (MANIFEST_COLS, [manifest_to_row(manifest, persons, prop_map, jobs)]),
    }, "DRY-RUN WRITE — inserting into *_dryrun tables", allow_delete=True)


def write_canonical(persons, prop_map, pp_links, jobs, manifest):
    return _write_tables({
        "Person":            (PERSON_COLS,   [person_to_row(p) for p in persons]),
        "Property":          (PROPERTY_COLS, [property_to_row(v) for v in prop_map.values()]),
        "PersonProperty":    (PP_COLS,       [pp_to_row(lk) for lk in pp_links]),
        "Job":               (JOB_COLS,      [job_to_row(j) for j in jobs]),
        "MigrationManifest": (MANIFEST_COLS, [manifest_to_row(manifest, persons, prop_map, jobs)]),
    }, "CANONICAL WRITE — inserting into production tables", allow_delete=False)


if __name__ == "__main__":
    _flags    = {a for a in sys.argv[1:] if a.startswith("--")}
    _positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    _snap_path  = _positional[0] if _positional else None
    manifest = main(_snap_path)
    if ("--write-dryrun" in _flags or "--write-canonical" in _flags) and manifest:
        import io, contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            custs, snap_name   = load_snapshot(_snap_path)
            persons            = resolve_identities(custs)
            prop_map, pp_links = extract_properties(persons)
            jobs, _            = extract_jobs(persons, prop_map)
        if "--write-dryrun" in _flags:
            write_dryrun(persons, prop_map, pp_links, jobs, manifest)
        if "--write-canonical" in _flags:
            write_canonical(persons, prop_map, pp_links, jobs, manifest)
