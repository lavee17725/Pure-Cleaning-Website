#!/usr/bin/env python3
"""
Phase 3 backfill: populate D1 Property.lat/lng/geocodeSource + Job Bouncie columns
from KV data. Sequential per Law T2.7.
"""

import json, subprocess, sys, re
from pathlib import Path

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
    ok = r.returncode == 0
    if not ok:
        print(f"  ❌  {label} FAILED")
        print("     stderr:", r.stderr[:300])
        print("     stdout:", r.stdout[:300])
    return ok

def esc(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"

def norm_phone(p):
    return re.sub(r'\D', '', p or '')[-10:]

def person_id(ph10):
    return f"person_1{ph10}"

def main():
    print("Loading KV customers…")
    token = get_token()
    customers = curl_get("/customers", token).get("customers", [])
    print(f"  {len(customers)} customers\n")

    # Build backfill lists
    coord_customers = []   # (name, ph, lat, lng, geocodeSource)
    bouncie_customers = [] # (name, ph, ss dict)

    for c in customers:
        if not c or c.get("deleted"):
            continue
        ph = norm_phone(c.get("phone", ""))
        if not ph or len(ph) != 10:
            continue
        name = f"{c.get('firstName','')} {c.get('lastName','')}".strip()

        coords = c.get("coordinates") or {}
        geocoded = c.get("geocoded") or {}
        lat = coords.get("lat") or geocoded.get("lat")
        lng = coords.get("lng") or geocoded.get("lng")
        geo_src = c.get("geocodeSource") or coords.get("source") or geocoded.get("source") or "unknown_legacy"

        if lat and lng:
            coord_customers.append((name, ph, lat, lng, geo_src))

        ss = c.get("scheduledStatus") or {}
        if ss.get("actualDuration"):
            bouncie_customers.append((name, ph, ss))

    print(f"Geocoded customers (Property updates):   {len(coord_customers)}")
    print(f"Bouncie customers (Job updates):         {len(bouncie_customers)}")
    print(f"Total updates:                           {len(coord_customers) + len(bouncie_customers)}\n")

    total = len(coord_customers) + len(bouncie_customers)
    done = 0
    errors = []

    # ── Property updates ──────────────────────────────────────────────────────
    print("── Property backfill ──\n")
    for name, ph, lat, lng, geo_src in coord_customers:
        pid = person_id(ph)

        # Look up propertyId via PersonProperty
        prop_rows = d1_query(
            f"SELECT pp.propertyId FROM PersonProperty pp WHERE pp.personId={esc(pid)} AND pp.primaryContact=1 LIMIT 1"
        )
        if not prop_rows:
            prop_rows = d1_query(
                f"SELECT pp.propertyId FROM PersonProperty pp WHERE pp.personId={esc(pid)} LIMIT 1"
            )
        if not prop_rows:
            print(f"  ⚠️  {name} ({ph}) — no PropertyId found, skipping")
            errors.append((name, ph, "no propertyId"))
            continue

        prop_id = prop_rows[0]["propertyId"]
        sql = (f"UPDATE Property SET latitude={lat}, longitude={lng}, "
               f"geocodeSource={esc(geo_src)} WHERE propertyId={esc(prop_id)}")

        ok = d1_execute(sql, f"Property UPDATE {name}")
        if not ok:
            errors.append((name, ph, "Property UPDATE failed"))
            sys.exit(1)

        # Verify
        verify = d1_query(f"SELECT latitude, longitude, geocodeSource FROM Property WHERE propertyId={esc(prop_id)}")
        if verify and verify[0].get("latitude"):
            done += 1
            print(f"  {done:>2}/{total} ✅  {name:<35s} ({ph}) | lat={verify[0]['latitude']:.4f} lng={verify[0]['longitude']:.4f} src={verify[0]['geocodeSource']}")
        else:
            print(f"  ⚠️  {name} ({ph}) — verify failed after update")
            errors.append((name, ph, "Property verify failed"))

    # ── Job updates (ss.actualDuration) ──────────────────────────────────────
    print("\n── Job Bouncie backfill ──\n")
    for name, ph, ss in bouncie_customers:
        pid = person_id(ph)
        ss_date = (ss.get("scheduledDate") or "")[:10]

        # Find the matching D1 Job: same payerId + scheduledDate
        job_rows = []
        if ss_date:
            job_rows = d1_query(
                f"SELECT jobId FROM Job WHERE payerId={esc(pid)} AND scheduledDate={esc(ss_date)} AND state='completed' LIMIT 1"
            )
        if not job_rows:
            # Fallback: most recent completed job for this person
            job_rows = d1_query(
                f"SELECT jobId FROM Job WHERE payerId={esc(pid)} AND state='completed' ORDER BY scheduledDate DESC LIMIT 1"
            )
        if not job_rows:
            print(f"  ⚠️  {name} ({ph}) — no matching Job found, skipping")
            errors.append((name, ph, "no Job found"))
            continue

        job_id = job_rows[0]["jobId"]
        actual_dur  = ss.get("actualDuration")
        actual_arr  = ss.get("actualArrival")
        actual_dep  = ss.get("actualDeparture")
        match_status = ss.get("bouncieMatchStatus")
        match_conf   = ss.get("bouncieMatchConfidence")
        geo_src      = ss.get("geocodeSource")

        set_parts = [f"actualDuration={actual_dur}"]
        if actual_arr:   set_parts.append(f"actualArrival={esc(actual_arr)}")
        if actual_dep:   set_parts.append(f"actualDeparture={esc(actual_dep)}")
        if match_status: set_parts.append(f"bouncieMatchStatus={esc(match_status)}")
        if match_conf is not None: set_parts.append(f"bouncieMatchConfidence={match_conf}")
        if geo_src:      set_parts.append(f"geocodeSource={esc(geo_src)}")

        sql = f"UPDATE Job SET {', '.join(set_parts)} WHERE jobId={esc(job_id)}"
        ok = d1_execute(sql, f"Job UPDATE {name}")
        if not ok:
            errors.append((name, ph, "Job UPDATE failed"))
            sys.exit(1)

        # Verify
        verify = d1_query(f"SELECT jobId, actualDuration, scheduledDate FROM Job WHERE jobId={esc(job_id)}")
        if verify and verify[0].get("actualDuration"):
            done += 1
            print(f"  {done:>2}/{total} ✅  {name:<35s} ({ph}) | jobId={job_id[-12:]}… actualDuration={verify[0]['actualDuration']}min date={verify[0]['scheduledDate']}")
        else:
            print(f"  ⚠️  {name} ({ph}) — verify failed after Job update")
            errors.append((name, ph, "Job verify failed"))

    # ── Verification counts ────────────────────────────────────────────────────
    print("\n\n── Verification counts ──\n")
    prop_lat  = d1_query("SELECT COUNT(*) as n FROM Property WHERE latitude IS NOT NULL")
    prop_geo  = d1_query("SELECT COUNT(*) as n FROM Property WHERE geocodeSource IS NOT NULL")
    job_dur   = d1_query("SELECT COUNT(*) as n FROM Job WHERE actualDuration IS NOT NULL")
    print(f"  Property WHERE latitude IS NOT NULL:      {prop_lat[0]['n'] if prop_lat else '?'}")
    print(f"  Property WHERE geocodeSource IS NOT NULL: {prop_geo[0]['n'] if prop_geo else '?'}")
    print(f"  Job WHERE actualDuration IS NOT NULL:     {job_dur[0]['n'] if job_dur else '?'}")

    # ── Spot-checks ────────────────────────────────────────────────────────────
    print("\n── Spot-checks ──\n")
    spot = [
        ("Janille Faulkner", "9542982779"),
        ("Andreina Garcia",  "9545367977"),
        ("Joseiky Garcia",   "3054989195"),
    ]
    for sname, sph in spot:
        spid = person_id(norm_phone(sph))
        job = d1_query(
            f"SELECT jobId, scheduledDate, actualDuration, bouncieMatchStatus "
            f"FROM Job WHERE payerId={esc(spid)} AND actualDuration IS NOT NULL LIMIT 1"
        )
        prop = d1_query(
            f"SELECT p.latitude, p.longitude, p.geocodeSource "
            f"FROM Property p JOIN PersonProperty pp ON p.propertyId=pp.propertyId "
            f"WHERE pp.personId={esc(spid)} LIMIT 1"
        )
        jstr = f"actualDuration={job[0]['actualDuration']}min date={job[0]['scheduledDate']}" if job else "NO JOB FOUND"
        pstr = f"lat={prop[0]['latitude']:.4f} lng={prop[0]['longitude']:.4f}" if prop and prop[0].get('latitude') else "no coords"
        print(f"  {sname:<30s} ({sph}) | {jstr} | {pstr}")

    print(f"\n\n═══ Summary ═══")
    print(f"  Property rows updated: {len(coord_customers) - sum(1 for _,_,r in errors if 'Property' in r)}")
    print(f"  Job rows updated:      {len(bouncie_customers) - sum(1 for _,_,r in errors if 'Job' in r)}")
    print(f"  Errors:                {len(errors)}")
    if errors:
        for n, p, r in errors:
            print(f"    ⚠️  {n} ({p}): {r}")
        print("\n⚠️  Review errors above before proceeding to Phase 4.")
    else:
        print("\n✅  All updates clean. Await Tyler approval for Phase 4.")

if __name__ == "__main__":
    main()
