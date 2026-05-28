# Pure Cleaning CRM — Active Law

> Auto-read at session start. These rules apply to every task, every session.

---

## How to use this file

**CLAUDE.md is the active law** — rules that apply to every task. Read this first.

For full architectural rationale, code patterns, and schema detail, read **`docs/ARCHITECTURE.md`**.

For project history, timeline, and the architectural decisions log, read **`docs/HISTORY.md`**.

When in doubt, follow this file. The other two are reference.

---

## Active Rules

**1.** Read this file before making any change.

**2.** `npm run deploy` ends with `🟢 Browser verification passed`. Never declare success before seeing that line.

**3.** Three deploys, three failures → STOP. Diagnose the deeper layer. Don't retry.

**4.** Bug feels mysterious → go read-only first. Diagnose full stack (live URL → headers → file → API → render sim) before changing anything.

**5.** Tyler hard-refreshes by default. Visual issues are not browser cache. Don't suggest it.

**6.** Snapshot before any bulk KV write: `POST /import/snapshot`, confirm key in response, then proceed.

**7.** Never PUT /customers with a placeholder payload. PUT replaces the entire database. Use GET to validate, not PUT.

**8.** All KV data reads and writes go through the worker admin API. `wrangler kv` commands are READ-ONLY diagnostics — never write tools. Same namespace ID, different edge state. (Full detail: `docs/ARCHITECTURE.md` → KV Access Policy.)

**9.** Never hardcode secrets in source files or shell commands. Read ADMIN_PASSWORD from `.env.local`. Worker secrets via `wrangler secret put`.

**10.** After any fix matching a Section 9 trigger (deploy mismatch, CSS contrast bug, field naming mismatch, auth/CORS issue, "declared success and Tyler found it broken"): update `docs/ARCHITECTURE.md` + `scripts/verify-deploy.js` before closing the session.

**11.** Referral-only customers (`isReferralOnly: true` OR phone starts with `REFERRAL_`) are excluded from ALL outreach — review requests, reactivation, bulk SMS. Add the guard to every new "find eligible customers" function.

**12.** `csv_backfill` jobHistory entries (`source: 'csv_backfill'`) are synthetic historical records with `completedAt: null`. Exclude them from any "most recent entry", "GPS match", or "eligible for outreach" pattern.

**13.** Customer-facing HTML pages (quote form, agreement, receipt, q.html) may only call API routes listed as public in `cloudflare-worker/src/AUTH_BOUNDARIES.md`. Any protected-endpoint call from a customer page = deploy blocker.

**14.** All dates stored and compared as `YYYY-MM-DD`. Accepted input: `5/6/26`, `5/6/2026`, `YYYY-MM-DD`. Any of those parses to canonical form. All other formats rejected — never silently coerced.

**15.** Migration and schema changes: Saturday morning OR weekday after 8 PM ET only. Never Tuesday–Thursday AM — those are Mom's heaviest call hours.

**16.** KV access: all reads/writes via worker admin API endpoints (`GET /customers`, `PUT /customers`, `POST /import/snapshot`). `wrangler kv key get/put` accesses a different edge state and writes silently fail to reach production. (Full story: `docs/HISTORY.md` → May 14.)

**17.** E.164 phone format: D1 `Person.primaryPhone` is always `+1XXXXXXXXXX`. KV stores raw 10-digit phones. Never compare directly. When mapping E.164 back to a KV-format lookup key, strip the leading `1` — `re.sub(r'\D','',e164)[1:]`. (Footgun detail: `docs/ARCHITECTURE.md` → E.164 Phone Format.)

**18.** Number inputs in admin forms must not pre-fill with `0`. Use `placeholder="Enter amount"`. Zero defaults cause silent $0 jobs when a field is skipped.

**19.** D1 is canonical for customer-data reads. `GET /customers` and `GET /customer/:phone` read from D1 via compatibility layer (`d1AllCustomersToKvShape` / `d1CustomerToKvShape`). KV remains write-canonical via dual-write infrastructure. A TEMP KV bridge merges Bouncie GPS fields (`actualDuration`, `bouncieMetrics`, etc.) and geocoded coordinates into D1 read results — remove after D1 schema gains those columns. Day 2 migration completed 2026-05-20.

**20.** (T1.20) Success toasts must verify end-to-end write before showing. Fire-and-forget bulk sync banned. All scheduled-state writes go through explicit POST /admin/scheduled-job with shared scheduleJobWithDualWrite helper.

**21.** (T1.21) **Read paths require verified write paths.** When adding any new field to a read surface (print sheet, calendar card, edit modal, customer profile, API response), audit the write path FIRST. Confirm: (a) writes exist and connect to the UI Mom uses, (b) field is in worker `_JOB_MUTABLE_FIELDS` if PATCH-able, (c) round-trip tested in browser before commit. No false fallback defaults — render "N/A" when data unknown. Trusting a field name is insufficient — verify the actual data contract. *Earned by 4 instances: (1) Issue 5 notes read `ss.jobNotes` which stores services; (2) Issue 4 roofStories write silently dropped on D1-native path; (3) Carlos workflow read D1 scheduled while write was dead code; (4) Property migration — 92 properties read `place_id` before writes existed.*

---

## Data Integrity Laws

### DL-01: roofStories — Single Source of Truth
- `roofStories` lives in TWO places: the Job record (per-job) and the Customer property record (permanent default)
- The Customer property record is the master default — editable directly from any page at any time
- When a job is completed, `roofStories` MUST be written to the `jobHistory[]` entry at completion time (`_doCompleteJob` must capture it)
- When a new quote or job is created for a returning customer, `roofStories` pre-fills from the Customer property record first, then falls back to most recent completed `jobHistory[]` entry
- NEVER guess `roofStories` from free text parsing — if it's not set, show blank and require selection
- `getLastKnownRoofStories()` is a temporary fallback only — every completion path must write it so this function becomes unnecessary over time

### DL-02: System-Wide Adjustability
- Any field that affects pricing, scheduling, or reporting must be editable system-wide from a single admin control
- No field should be locked to the page it was first entered on
- When a master record is updated, all dependent views reflect it immediately — no stale cache

### DL-03: jobHistory[] is Canonical
- `jobHistory[]` is the permanent record of all completed work — it is never reconstructed from `scheduledStatus` or `quoteStatus`
- `scheduledStatus` is temporary — it holds the current scheduled job state only
- `quoteStatus` is temporary — it holds quote information only
- Once a job is completed and written to `jobHistory[]`, that entry is the truth

### DL-04: CSV Backfill Entries
- All CSV backfill entries are flagged `source: 'csv_backfill'`
- CSV backfill entries are excluded from the review request queue
- CSV backfill entries are excluded from any automated outreach

### DL-05: Minimum Ticket Rule
- $150 minimum per job — flag any job under $150 in reporting
- Never filter these out — surface them for Tyler to review

### DL-06: Customer Segments
- Residential customers, commercial customers, and partners (Hearts Painting, Richard Carlos, Pro Build) are separate segments
- Partners and commercial accounts are excluded from residential bulk reactivation campaigns
- Each segment has its own reactivation logic — never mix them

### DL-07: Fix the Full Surface, Not Just the Symptom
- Before fixing any field or bug, audit every place that field touches
- If multiple fields have the same class of problem, fix them all in one pass
- Never patch one hole knowing others exist — surface them all first, fix together
- This applies to every completion path, every write path, every read path

---

## Working with Tyler

- **One fix at a time.** Validate before moving to the next.
- **Read-only diagnostic when a bug is mysterious.** Show evidence first, fix second.
- **Snapshot before destructive changes.** No exceptions.
- **Terse responses.** No preamble, no trailing summary that repeats the diff.
- **Hard refresh is muscle memory.** Visual issues are not cache. Don't say cache.
- **When the same pattern fails three times, STOP.** Diagnose the deeper layer.
- **Honest feedback over hype.** If something is wrong, say so directly.
- **Tyler speaks in business intent, not technical specs.** Translate plain language into the best functional, time-saving, money-making solution. Never make Tyler decode technical language.
- **Always read Google Drive docs at session start.** Laws doc ID: `1piyusFUPyOTuTUFEsWxMARJZ0B8L6BWXxgMdFNNXSVI`. Forward Work Queue ID: `13BZU949DS_UYalrKFvyfl_65UahC93qs`.
- **Fix the full surface, not just the symptom.** Before any fix, audit every place that field or pattern touches. Fix all instances in one pass.

---

## Quick Reference

```
npm run deploy          # build → deploy:api → verify-deploy → verify-browser
npm run deploy:verify   # verify without deploying
npm run verify:browser  # Playwright only

Live site:    purecleaningpressurecleaning.com  (Cloudflare Worker)
Rollback:     GoDaddy NS → ns09/ns10.domaincontrol.com  (GitHub Pages, 5–30 min)
Admin auth:   POST /auth/login  →  Authorization: Bearer <token>
.env.local:   ADMIN_PASSWORD=<password>  (never committed)
```

**Key files:**
```
public/                           ← source HTML (edit these)
build/                            ← generated by npm run build (do not edit)
cloudflare-worker/src/index.js    ← API worker
cloudflare-worker/wrangler.toml   ← worker config (KV + D1 + R2 bindings)
cloudflare-worker/migrations/     ← D1 schema migrations
scripts/verify-deploy.js          ← 176-check post-deploy verifier
scripts/verify-browser.js         ← Playwright browser verifier
scripts/migration_skeleton.py     ← Day 1 KV→D1 loader (ONE-SHOT, do not re-run)
snapshots/                        ← KV snapshots (gitignored, backed up to R2)
docs/ARCHITECTURE.md              ← rule rationale, schema, patterns
docs/HISTORY.md                   ← timeline, decisions log
```

**D1 database:**
```
DB: pure-cleaning-crm-v1  (a9cca011-f138-4e99-b831-8f78f3165409)
wrangler: npx wrangler d1 execute pure-cleaning-crm-v1 --remote --config cloudflare-worker/wrangler.toml
Status: Day 2 complete (2026-05-20). D1 canonical for reads. KV write-canonical via dual-write.
Counts: Person 1,245 / Property 1,224 / PersonProperty 1,246 / Job 1,838
Pending: Bouncie GPS columns, geocode backfill, 4 uncovered dual-write paths (cancel/revert/update/delete)
```

---

*For full architectural rationale and code patterns → `docs/ARCHITECTURE.md`*
*For project history, decisions log, and timeline → `docs/HISTORY.md`*
