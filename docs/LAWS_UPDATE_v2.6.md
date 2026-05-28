# Laws We've Learned — Updates for v2.6
**Date:** May 28, 2026
**Adds to v2.5:** Laws from May 28 session — T1.21 promoted, DL series added, communication protocol established, Drive connection enabled.

---

## Law T1.21 — Read Paths Require Verified Write Paths
**Statement:** When adding any new field to a read surface (print sheet, calendar card, edit modal, customer profile, API response), audit the write path FIRST. Confirm: (a) writes exist and connect to the UI Mom uses, (b) field is in worker _JOB_MUTABLE_FIELDS if PATCH-able, (c) round-trip tested in browser before commit. No false fallback defaults — render "N/A" when data unknown.
**Origin:** 4 instances: (1) Issue 5 notes read ss.jobNotes which stores services; (2) Issue 4 roofStories write silently dropped on D1-native path; (3) Carlos workflow read D1 scheduled while write was dead code; (4) Property migration — 92 properties read place_id before writes existed.
**Don't:** Trust a field name. Assume data flows because the variable exists.
**Do:** Verify the actual data contract. Check _JOB_MUTABLE_FIELDS. Test round-trip in browser.

---

## Law T1.22 — _doCompleteJob Must Capture All Available Fields
**Statement:** When _doCompleteJob runs, it has access to ss and c with rich data. Every field available at completion time that is relevant to history, reporting, or segmentation MUST be written to _jhEntry and patchBody. Silent omissions create permanent historical gaps — completed job records are the only permanent truth.
**Origin:** May 28 audit found 13+ fields available at completion time not being captured: roofStories, roofType, customerType, scheduleNote, jobLog, window, crewCount, propertyLabel, workSiteAddress, leadSource, endCustomerName, endCustomerPhone, and more.
**Fields to capture in _jhEntry:** roofStories, roofType, customerType, scheduleNote, jobLog, window, crewCount, propertyLabel, workSiteAddress, leadSource
**Fields to capture in patchBody:** roofStories, roofType, crewCount, endCustomerName, endCustomerPhone, workSiteAddress
**Don't:** Add fields to read surfaces without verifying completion path writes them.
**Do:** Before adding any field to a read surface, check if _doCompleteJob captures it. If not, add it.

---

## Law T2.13 — Tyler Speaks Business Intent, Claude Translates
**Statement:** Tyler describes what he needs in plain business terms. Claude's job is to translate that into the best functional, time-saving, money-making solution. Tyler does not talk in absolutes — treat everything as a working theory to be refined. Never make Tyler decode technical language. One clear business question at a time, highlighted when a decision is needed.
**Origin:** May 28 — Tyler explicit: "I don't know code. You get overly technical sometimes without realizing."
**Don't:** Use technical jargon without translation. Ask Tyler to choose between technical options. Give Tyler more than one decision at a time.
**Do:** Plain English always. Highlight the one decision needed. Handle all technical complexity invisibly.

---

## Law T2.14 — Google Drive Connection is Session-Start Protocol
**Statement:** Google Drive is now connected to Claude. At the start of every CRM session, read: (1) Laws We've Learned current version, (2) Forward Work Queue current version. These are the cross-session memory. Writing to Drive when findings happen is mandatory — not optional, not "later."
**Origin:** May 28 — Drive connection established. Prior sessions Claude was operating without reading these docs, creating advice gaps.
**Laws doc ID:** 1QwvkDCmkmES_yU3oOBY7wSO1vlL0-6o3 (v2.5, check for newer)
**Forward Work Queue ID:** 13BZU949DS_UYalrKFvyfl_65UahC93qs
**Don't:** Start a CRM session without reading both docs. Write findings "later."
**Do:** Read both docs first. Write findings when they happen.

---

## Law T2.15 — Fix the Full Surface, Not Just the Symptom
**Statement:** Before fixing any field or bug, audit every place that field touches. If multiple fields have the same class of problem, fix them all in one pass. Never patch one hole knowing others exist — surface them all first, fix together.
**Origin:** May 28 — roofStories fix revealed 13 other fields with the same omission in _doCompleteJob. DL-07 principle established.
**Don't:** Fix one instance of a pattern when the pattern repeats.
**Do:** Audit full surface first. Fix all instances together.

---

## Data Integrity Laws (DL series) — Added May 28

### DL-01: roofStories Single Source of Truth
- Lives in TWO places: Job record (per-job) and Customer property record (permanent default)
- Customer property record is master default — editable from any page at any time
- _doCompleteJob MUST write roofStories to jobHistory[] entry at completion
- Pre-fills from Customer property first, then most recent jobHistory[] fallback
- NEVER guess from free text parsing — show blank, require selection
- getLastKnownRoofStories() is temporary fallback only

### DL-02: System-Wide Adjustability
- Any field affecting pricing, scheduling, or reporting must be editable system-wide
- No field locked to the page it was first entered on
- Master record updates reflect immediately across all dependent views

### DL-03: jobHistory[] is Canonical
- jobHistory[] is permanent record of completed work — never reconstructed from scheduledStatus or quoteStatus
- scheduledStatus is temporary (current scheduled job state only)
- quoteStatus is temporary (quote information only)
- Once written to jobHistory[], that entry is the truth

### DL-04: CSV Backfill Entries
- Flagged source:'csv_backfill'
- Excluded from review request queue
- Excluded from automated outreach

### DL-05: Minimum Ticket Rule
- $150 minimum per job — flag any job under $150 in reporting
- Never filter out — surface for Tyler to review

### DL-06: Customer Segments
- Residential, commercial, and partners (Hearts Painting, Richard Carlos, Pro Build) are separate segments
- Partners and commercial excluded from residential bulk reactivation
- Each segment has its own reactivation logic — never mix

### DL-07: Fix the Full Surface
- Before fixing any field or bug, audit every place that field touches
- Fix all instances of the same class of problem in one pass
- Never patch one hole knowing others exist

---

*v2.6 additions — May 28, 2026. T1.21 promoted from CLAUDE.md. T1.22 earned from _doCompleteJob audit. T2.13-T2.15 earned from session protocol improvements. DL-01 through DL-07 added as new Data Integrity Law series.*
