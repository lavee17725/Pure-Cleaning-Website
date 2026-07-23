# Pure Cleaning CRM — Architecture & Rationale

> Reference document. Read when a task touches the relevant domain.
> Active rules (one-liners) are in `CLAUDE.md`. This file has the WHY.

---

## Data Layer

### KV Namespace: `DATA`

| KV key | Contains |
|--------|----------|
| `customer_db` | `{ customers: [...] }` — entire customer DB |
| `incoming_requests` | `{ requests: [...] }` — public quote form submissions |
| `bouncie:rig_mapping` | IMEI → rig name map |
| `bouncie:morning_stops:{date}` | POI stop results per date |
| `customer_db_snapshots` | Snapshot array for rollback |

### KV Access Policy (Rule 16)

**The problem:** `wrangler kv key get/put` and the worker runtime `env.DATA` access different Cloudflare KV edge states even when given the same namespace ID. They do not reliably converge via eventual consistency.

Discovered May 14, 2026: 14 hours of shell-path repairs (Jim New payment, Keith Wolf, Seeber Hope, two phantom deletions) appeared successful at the shell level but were silently overwritten by browser `saveDb()` calls. None of those repairs landed in production.

**The rule:** All data repairs go through the worker admin API:
- **Reads:** `GET /customers` (admin API) or `GET /import/snapshots`
- **Writes:** `PUT /customers` (full replace), any admin API endpoint that mutates a record
- **Snapshots:** `POST /import/snapshot` → `GET /import/snapshots` to verify
- **Wrangler kv commands:** READ-ONLY diagnostic tools only — never write with them

**Auth pattern for admin API calls:**
```bash
ADMIN_PW=$(grep ADMIN_PASSWORD .env.local | cut -d= -f2)
TOKEN=$(curl -s -X POST https://purecleaningpressurecleaning.com/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://purecleaningpressurecleaning.com" \
  -d "{\"password\":\"${ADMIN_PW}\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
# then: -H "Authorization: Bearer $TOKEN"
```

### D1 Database: `pure-cleaning-crm-v1`

- **Database ID:** `a9cca011-f138-4e99-b831-8f78f3165409`
- **Binding:** `DB` in `cloudflare-worker/wrangler.toml`
- **Region:** ENAM (Atlanta primary)
- **Status:** Day 1 loaded 2026-05-16. KV canonical until Day 2 dual-write.
- **Recovery baseline:** `wrangler d1 time-travel restore pure-cleaning-crm-v1 --timestamp=2026-05-16T14:11:42Z`
- **Schema:** `cloudflare-worker/migrations/0001_initial_schema.sql`

**Execute against D1:**
```bash
npx wrangler d1 execute pure-cleaning-crm-v1 --remote \
  --config cloudflare-worker/wrangler.toml \
  --command "SELECT COUNT(*) FROM Person;"
```

**Day 2 dual-write target:** Saturday May 24 or weekday after 8 PM ET. Worker writes to BOTH KV and D1 atomically. KV stays as read-fallback for 7 days post-cutover.

---

## Schema Design

### D1 v3 Schema (locked May 13, 2026)

**Tables:** Person, Property, PersonProperty, Job, Rig, CrewMember, Communication, MigrationManifest

**Key design decisions:**
- D1 canonical, KV cache + tokens
- `Person.primaryPhone` in E.164 format (`+1XXXXXXXXXX`) always
- `Property.googlePlaceId` is the canonical address identity for dedup
- `Job.completedAt` being non-null is the ONLY signal a job is done — no reading state from `scheduledStatus + jobHistory + source flags`
- `Job.state` transitions: `pending → scheduled → in_progress → completed`. `cancelled` and `reverted` are terminal.
- `Job.servicesRequested` values come from `service_taxonomy.json`. Anything else goes to `jobNotes`.
- Roof tile types and story counts are Property attributes (`Property.roofType`, `Property.stories`), not service tags.
- Same-day repeat job rendering: group by `(payerId, scheduledDate)`. Different payers on same date are independent cards.
- Migration audit fields (`migratedFrom`, `migrationVersion`, etc.) are never deleted, even after manual edits.

**Canonical service taxonomy:**
Surface: Roof, Roof - Softwash, Roof - Traditional brush, Rinse Walls, Rinse Walls & Windows, Patio, Driveway, Sidewalk, Entranceway, Walkway, Pool Deck, Screen Enclosure, Fence, Gutter Cleaning, Stairways, Curbs / Carstops, Dumpster Area, Tennis Court, Landscape Border

Sealing: Seal Driveway, Seal Patio, Seal Sand in Joints, Seal Pool Deck

Specialized: Prep for Painting, Multi-building Complex

### KV Customer Record Schema (current production)

```js
{
  id, firstName, lastName, phone, email, address, city, zip,
  totalJobs, lifetimeSpend, lastService, firstServiceDate, customerSince,
  jobHistory: [{ date, amount, source, status, completedAt, rigId, jobId, ... }],
  scheduledStatus: {
    state,           // 'scheduled' | 'completed' | 'cancelled'
    scheduledDate,
    completedAt,     // use this, NOT completedDate (field does not exist)
    paymentRequestSentAt,
    paymentRequestCount,
    revertLog: [],   // append-only audit trail
    _lastJobId,      // used by late-completion dedup (Option A)
  },
  tags, notes, tier, vip, optOut,
  isReferralOnly,   // true if created from phoneless referral
  quoteLifecycle,   // 'verbal_pending' | 'confirmed' | 'did_not_service'
  quoteHistory: [], // array of quote attempts with outcomes
  paymentMethod,
  paymentInfo: { method, paidAt },
  altPhone,
  alerts: [],
  leadSource: { primary, label, capturedAt, capturedVia },
}
```

### Source of Truth Rules

- **Tier / lifetime spend / last service** — use `jobHistory[]` when `jh.length > 0`. Top-level aggregate fields (`totalJobs`, `lifetimeSpend`, `lastService`) are stale post-CSV backfill. This is the `getEffectiveStats()` pattern.
- **Review eligibility** — requires `j.source !== 'csv_backfill' && j.completedAt && j.completedAt >= REVIEW_ELIGIBLE_CUTOFF`. Never use `j.date + 'T12:00:00'` as a proxy for completedAt.
- **Completed date** — `scheduledStatus.completedAt`. The field `completedDate` does not exist.
- **CSV backfill entries** — `source: 'csv_backfill'`, `completedAt: null`. Exclude from review queue, payment history, and any calculation that requires a real completion.
- **Referral-only customers** — `isReferralOnly: true` OR `phone.startsWith('REFERRAL_')`. Must be excluded from ALL outreach. Add explicit guard in every new filtering function.

### Identity Resolution (for migration / dedup)

Phone is the primary identity key (E.164 normalized).

- Same phone + different name spellings → one Person, all spellings in `aliases[]`
- Different phone + same name + same property → flag medium/low confidence, manual review
- No phone + referral source signal → `payerId = referrer.personId`

Confidence levels:
- `high` (~70%): Phone match, name match, all fields populated → auto-write
- `medium` (~20%): Phone match across alias variants OR phone-less but unambiguous referral → auto-write with note
- `low` (~10%): No phone, ambiguous name → manual review queue

### Incoming Requests Schema

```js
{
  id, customer_name, submittedAt, status,
  customerData: { firstName, lastName, phone, email, address, city, zip, services, ... }
}
```
Always read name from `customerData.firstName` / `customerData.lastName` first; fall back to `customer_name`.

---

## Worker Patterns

### Deploy Topology

Single target: everything — HTML, assets, and API — served from one Cloudflare Worker.

| Target | URL |
|--------|-----|
| **Cloudflare Worker** | `purecleaningpressurecleaning.com` ← user loads this |
| Workers.dev alias | `purecleaning-api.tylerfumero.workers.dev` |

GitHub Pages is retained as rollback only. DNS: `aisha.ns.cloudflare.com` + `rohin.ns.cloudflare.com`.

Static asset routing: worker serves `public/` assets before the API auth gate. Requests with file extensions or root `/` → asset binding. API routes (no extension) → normal auth/routing.

`[assets]` binding: `directory = "../build"`, `run_worker_first = true` (required so `addCacheHeaders()` executes for all paths).

Cache-Control: HTML files are `no-cache, no-store, must-revalidate`. Hashed JS/CSS bundles are `immutable` (1 year).

**⚠ Un-hashed `/js/*.js` footgun (2026-07-23):** shared scripts like `/js/quote-logger.js` and `/js/reminder-builder.js` get the same `immutable` 1-year policy as hashed bundles, and the Cloudflare edge caches them. Editing one in place deploys fine but browsers + edge keep serving the OLD file — the Quote Pool v1.1 browser verify went red exactly this way (modal still had the v1 chip set live). **Fix: bump the query version on every consumer `<script src="/js/foo.js?v=N">` whenever the file changes.** The browser verifier catches staleness because it exercises live behavior, not file contents — keep it that way (LAW 12).

**Rollback:** GoDaddy → change NS to `ns09/ns10.domaincontrol.com`. GitHub Pages resumes in 5–30 min.

### Admin Auth

KV-stored session tokens, single shared password. Login: `POST /auth/login`. Tokens stored as `session:{token}` with 86400s TTL. Auth gate: 20-line IIFE at the top of every admin HTML file.

Public routes (no auth): health, auth/login, auth/logout, POST /incoming, quote/*, agreement/confirm, appointment/*, receipt GET/PATCH, service-frequency GET, addons-config GET.

Set `VERIFY_TOKEN` env var for verify-deploy.js authenticated checks. Or use `.env.local` with `ADMIN_PASSWORD` — `scripts/lib/auto-auth.js` reads it automatically.

### Auth Boundary Rule

When ANY architectural change ships, before declaring success:
1. Identify every existing flow that touches the changed system
2. Simulate what an end user (not admin) experiences — test in incognito
3. ANY 401 on a customer-facing page = deploy-blocker
4. Add a verify-deploy.js check for the same class of regression

`verify-deploy.js` CHECK 8 auto-audits: fetches each customer page, extracts all `fetch()` API paths, checks each against the public allowlist. Protected endpoint call → FAIL.

Reference: `cloudflare-worker/src/AUTH_BOUNDARIES.md` — update before adding any new endpoint.

### Bouncie GPS Thresholds

| Distance from job address | Action |
|--------------------------|--------|
| < 250 ft | High-confidence match |
| 250–500 ft | Medium-confidence match |
| > 500 ft | Reject |

Soft wash jobs → Chevy (rig_3) deterministically; no GPS needed.

**Rig map:**
```
rig_1 = Old Tacoma (Tyler's truck)
rig_2 = New Tacoma
rig_3 = Chevy (soft wash)
```

**Home base:** 5640 SW 197 Ave, Southwest Ranches, FL 33332 — lat: 26.0418239, lng: -80.3709794

**Cron heartbeat:** `bouncie:last_cron_run` written after every nightly run. verify-deploy.js fails if older than 26 hours.

---

## UI Patterns

### CSS Contrast Rules (Rule from LAW 1)

No white-on-white. When writing CSS, resolve `var()` chains to hex.

```
--white: #fff
--card:  #fff   ← default card background
--text:  #1a1f2e  ← safe for text on cards
--navy:  #0a1628  ← safe for text on cards
--muted: #6b7280  ← safe for secondary text on cards
```

Text on cards: use `--text`, `--navy`, or `--muted`. Never `--white` or `--card` for text color.

To suppress a known-safe false positive: add `/* contrast-ok */` inside the CSS rule.

### Modal & Form Patterns

**Number inputs (Rule 18):** Use `placeholder="Enter amount"` not `value="0"`. Zero default = silent $0 jobs.

**Required-field validation pattern (Schedule it now modal):**
- Validate on `oninput` for each field
- Show `.fi.err` border on invalid input
- Display error in `#schedError` div (`color: var(--red); font-size: 12px`)
- Disable submit button (`.mbtn-a:disabled`) until all fields valid
- Defense-in-depth: submit handler re-validates even with button disabled

**Payment field write rule (from `_applyPaymentMethod()`):** All payment corrections must write 5 fields atomically: `c.paymentMethod`, `c.paymentInfo.method`, `jhEntry.paymentMethod`, `jhEntry.payment`, `jhEntry.paymentInfo.method`. Writing any subset leaves the calendar showing stale payment state.

### E.164 Phone Format (Rule 17)

KV stores raw 10-digit phones: `"9542493300"`. D1 stores E.164: `"+19542493300"`. Never compare them directly.

**KV → E.164:** `f"+1{digits}"` for any 10-digit phone.

**E.164 → KV-format lookup key:** Strip the leading `+1`. In Python: `re.sub(r'\D','',e164)[1:]` OR check length — if 11 digits starting with 1, use `[1:]`.

**The spec_key footgun (May 16, 2026):** `re.sub(r'\D', '', "+19542493300")` returns `"19542493300"` (11 digits). A dict keyed on `"9542493300"` (10 digits) silently misses. Always strip the leading `1` when mapping E.164 back to a KV-format key.

**In migration scripts:** use `normalize_phone()` in `scripts/migration_skeleton.py` for KV→E.164, and the `spec_key` strip pattern for E.164→KV-format dict lookups.

---

## Operational Discipline

### Snapshot Protocol (Rule 6)

Before any bulk KV write:
```bash
POST /import/snapshot
# confirm snapshot key in response, then proceed
```

Pattern that saved a recovery session: test PUT wiped 1,233 customers. Snapshot → restored.

### Cutover Windows (Rule 15)

Migration and schema-change cutover windows: **Saturday morning** OR **weekday after 8 PM ET**.

**Never Tuesday–Thursday AM** — those are Mom's heaviest call hours. Breaking customer lookup during those windows is the worst-case outcome.

Applies to: any change touching the schema, the worker handler, or the calendar render path simultaneously.

### Data Repairs

Before/after on all data repairs. Print the before state, get confirmation, apply, print after state, run assertions.

### Revert Path — 4-Store Consistency (2026-06-23)

A completed-job revert must clear completion state across **four stores in lockstep**, or the row sits in a half-completed state and re-triggers downstream logic (review queue, phantom segment cards, ML feature drift):

| Store | What the revert clears | Where |
|---|---|---|
| D1 Job row | `state='scheduled'`, `completedAt=NULL`, `paidAt=NULL`, `paymentStatus='unpaid'` | `PATCH /admin/job/:id {state, completedAt:null, paidAt:null, paymentStatus:'unpaid'}` (calendar `_doRevertJob`). paymentStatus must reset because `_d1BuildScheduledStatus` reads it on every KV rebuild — without clearing D1, the KV-side cleared value gets resurrected to 'paid'. Use the string `'unpaid'` not `null` — Job.paymentStatus has a NOT NULL constraint (schema rejects null). |
| KV `customer_db` blob | `ss.completedAt`, `ss.completedDate`, `ss.paymentStatus`, `ss.paidAt`, `ss.paidAmount` | `_patchJobKvSync` — the clear-completion branch must include `state==='scheduled'` alongside `rescheduled`/`cancelled` |
| KV `jobHistory[]` for the customer | Remove every entry on this date with `source` in `{calendar_completion, rig_segment, day_segment}` | `_doRevertJob`'s jh filter — segment children are easy to miss because they only exist on group jobs |
| Aggregates | `lifetimeSpend -= amount`, `totalJobs -= 1`, `lastService` recomputed, `reviewQueue` removed | `_doRevertJob` local mutation; saveDb mirror |

**Invariant**: after revert, the same record must round-trip back to identical state if completed again — no leftover timestamps, no phantom cards, no duplicate-guard trips.

**verify-deploy markers** (line 79–82 of `pure_cleaning_calendar.html` section): `j.source === 'rig_segment'`, `j.source === 'day_segment'`, `completedAt: null, paidAt: null`. Missing any of these = a regression of one of the four bugs from 2026-06-23 cowork.

**Verifiers are latency-resilient (WO-7, 2026-06-23).** `verify-deploy.js` (`fetchRetry`: retry-on-thrown-network-error, 3 attempts + 20s abort) and `verify-browser.js` (`withPage`: 3 nav attempts × 60s budget) absorb connection jitter. Retries fire ONLY on thrown network errors (undici `fetch failed`, nav timeouts) — HTTP status (4xx/5xx) and content/marker assertions still hard-fail, so real regressions stay red. **Do NOT "fix" verifier flakiness by re-running `npm run deploy` (Rule 3):** network jitter is now absorbed; a red result means a genuine content/status failure, not a slow connection.

### Post-Fix Protocol (Section 9)

**Triggers** (any one → document and verify before closing session):
- Deploy topology mistake or mismatch
- CSS rendering bug (visibility, contrast, z-index, layout)
- Data field naming mismatch (frontend reads X, backend writes Y)
- Auth / CORS issue
- Caching bug
- Race condition or state management bug
- Declared success and Tyler found it broken
- "Three deploys, three failures"
- Any bug class that could plausibly recur in another file

**Required actions:**
1. Append to `docs/HISTORY.md` architectural decisions log
2. Add to `scripts/verify-deploy.js` if mechanically checkable
3. Update this file (`docs/ARCHITECTURE.md`) in the relevant section
4. Tell Tyler: "Logged to ARCHITECTURE.md. Added [N] checks to verify-deploy.js."

**Mechanically checkable:** A check belongs in verify-deploy.js if it can be verified by curling the live URL or API without user interaction.

**Recurring bug classes:** When the same bug pattern appears in 2+ places, it becomes an Architectural Law. Codify in plain English, build automated enforcement, add to the Laws section below with date and rationale.

---

## Architectural Laws

Laws are invariants enforced by automated checks. Violating one causes `verify-deploy.js` to fail. New Laws are added when a bug class recurs (same pattern, different file).

To intentionally violate a Law: add `/* contrast-ok */` inside the CSS rule (or equivalent suppression comment). The scanner skips those.

---

### LAW 1: NO INVISIBLE TEXT

**Rule:** No CSS rule may set a text `color` that resolves to the same hex as its background.

**Enforcement:** `verify-deploy.js` universal CSS contrast scanner (`scanUniversalContrast`). Same-rule white-on-white → FAIL. White text with no background in same rule, file has white card vars → WARN.

**Established:** May 8–9, 2026 — white-on-white bug in `incoming.html` (.req-name), then `review_hub.html` (6 classes in one file).

**Status:** ✅ Enforced

---

### LAW 2: PUBLIC POST ENDPOINTS MUST BE RATE-LIMITED

**Rule:** Any `POST` endpoint without admin auth must have IP-based rate limiting.

**Implementation pattern:** KV counter key `rate:{endpoint}:{ip}` with TTL matching the window; return 429.

**Enforcement:** verify-deploy.js — smoke test verifies `POST /incoming` returns 429 under rapid requests.

**Established:** May 8, 2026 — friendly pen-test flooded POST /incoming with 102 entries in <10 min.

**Status:** ✅ Enforced for `/incoming` · ⏳ PENDING for `/errors/log`

---

### LAW 3: REFERRAL-ONLY CUSTOMERS EXCLUDED FROM ALL OUTREACH

**Rule:** Customers with `isReferralOnly: true` OR `phone.startsWith('REFERRAL_')` must be excluded from every outreach feature.

**Guard pattern:**
```js
if (c.isReferralOnly) return false;
if ((c.phone || '').startsWith('REFERRAL_')) return false;
if (c.optOut) return false;
```

**Established:** May 8–9, 2026 — Hart's Painting Referral appeared in the Google Review queue.

**Status:** ✅ Enforced in code · ⏳ AUTOMATED TEST PENDING

---

### LAW 4: CSV BACKFILL ENTRIES ARE INERT IN "FIND RECENT/ELIGIBLE" PATTERNS

**Rule:** `jobHistory` entries with `source: 'csv_backfill'` must be excluded from any `.find()` / `.filter()` pattern that looks for "most recent entry", "GPS match", or "eligible for outreach". They have `completedAt: null` by definition.

**Enforcement:** Code guards in `getExtraCompletedJobsForRig()`, `jobCardScheduled` GPS lookup, `reviewIsReadyToRequest()`.

**Established:** May 8, 2026 — CSV backfill of May 2026 jobs created duplicate calendar cards on 14 customers.

**Status:** ✅ Enforced in code · ⏳ AUTOMATED SCANNER PENDING

---

### LAW 5: CUSTOMER-FACING PAGES MUST NOT CALL PROTECTED ENDPOINTS

**Rule:** HTML files reachable by customers may only call API routes listed as public in `AUTH_BOUNDARIES.md`.

**Enforcement:** verify-deploy.js CHECK 8 (`checkCustomerFlows`) — fetches each customer page, extracts all `fetch()` paths, checks against public allowlist. Protected call → FAIL.

**Established:** May 8, 2026 — auth deploy broke q.html and customer_quote.html.

**Status:** ✅ Fully enforced

---

### LAW 6: NO CREDENTIALS IN COMMAND OUTPUT OR LOGS — AND NO OAUTH EXTRACTION PATTERNS

**Rule:** Never expose credentials through command output, and never extract OAuth tokens from local credential files to call Cloudflare APIs directly.

**Prohibited patterns:**
- `cat ~/.wrangler/config/default.toml` — prints OAuth token
- `TOKEN=$(grep oauth_token ~/.wrangler/config/...)` — extraction is the violation even if token never prints
- Any grep/awk/sed on `~/.wrangler/config/`
- `curl https://api.cloudflare.com/...` with a bearer token extracted from local files
- `env | grep TOKEN`, `printenv | grep KEY`

**Safe alternative for admin API:** Read password from `.env.local` (see KV access pattern above).

**Established:** May 8, 2026 — `cat` of wrangler config printed OAuth token into conversation.

**Status:** ✅ Policy enforced via discipline + pre-commit secret scanner

---

### LAW 8: TEMPLATE LITERAL VARIABLES MUST BE IN SCOPE

**Rule:** Every `${variable}` in a template literal must be declared in accessible scope. Missing declarations throw `ReferenceError` silently — the rendered container is empty, stats render fine (they run before the throw).

**Symptom signature:** "stats show but list is empty."

**Fix pattern:** When restructuring a `.map()` or `.forEach()` callback, ensure ALL `${variable}` references have corresponding `const`/`let` declarations at the top of the callback.

**Established:** May 9, 2026 — `const tc = tierClass(c.tier)` dropped from `renderTable()`. Silent failure for 36+ hours.

**Status:** ✅ Marker check for `const tc` · ⏳ Generic pre-commit lint PENDING

---

### LAW 9: TRY/CATCH BLOCKS MUST FORWARD TO ERROR TRACKER

**Rule:** Any `catch` block that handles an error locally MUST also forward to `/errors/log` via `navigator.sendBeacon`.

**Pattern:**
```javascript
} catch(e) {
  // ... local handling ...
  try { navigator.sendBeacon(API + '/errors/log', JSON.stringify({
    source: 'descriptive_source_name', page: location.pathname.split('/').pop(),
    errorType: (e && e.name) || 'Error',
    message: ((e && e.message) || String(e)).slice(0, 500),
    stack: ((e && e.stack) || '').slice(0, 2000),
    url: location.href, timestamp: new Date().toISOString(),
  })); } catch {}
}
```

**Intentional suppression (OK to NOT forward):** low-level utility catches (`localStorage`, geocoder, background polling). Mark with `/* err-tracker-ok: reason */`.

**Established:** May 9, 2026 — ReferenceError caught by `tryLoadDatabase()` never reached `window.onerror`. Error dashboard empty for 36+ hours.

**Status:** ✅ Enforced on key page-init catches · ⏳ Full lint scan PENDING

---

### LAW 10: SYSTEM SELF-MONITORS — OPERATOR DOES NOT

**Rule:** The system must detect its own error spikes and surface them automatically. Tyler must not need to open the error dashboard to know something is wrong.

**Phase 1 (done):** `POST /errors/log` increments 5-min KV buckets. ≥10 errors in 15-min window → `alerts:active` KV key (30-min TTL). errors.html shows red banner on load.

**Spike detection:** 5-min buckets: `errors:count:{date}:{floor(epochMs/300000)}`. Sum 3 buckets = 15-min sliding window. Threshold ≥10 → alert.

**Phase 2 (deferred):** Outbound SMS/email when spike detected.

**Established:** May 9, 2026 — error dashboard is useless if only checked when already suspicious.

**Status:** ✅ Phase 1 shipped · Phase 2 deferred

---

### LAW 11: SERVICE CATEGORIZATION IS SHARED

**Rule:** Any feature filtering customers by service type MUST use the shared `categorizeService()` function.

**Returns:** `'roof'` | `'ground'` | `'both'` | `'unknown'`

**Roof keywords:** `roof`, `soft wash`, `softwash`

**Ground keywords:** `driveway`, `patio`, `sidewalk`, `walkway`, `concrete`, `pressure`, `paver`, `pool deck`, `deck`, `entranceway`, `entrance`, `flatwork`, `pool area`

**Thresholds:** Ground reactivation = 6 months. Roof reactivation = 18 months.

**Urgency tiers:**
- Ground: 6–12 mo = `due`, 12–18 mo = `overdue`, 18+ mo = `stale`
- Roof: 18–30 mo = `due`, 30–36 mo = `overdue`, 36+ mo = `stale`

**Location:** `pure_cleaning_bulk_reactivation.html` (inline). Extract to `public/js/pc-utils.js` when a second page needs it.

**Established:** May 9, 2026.

**Status:** ✅ bulk_reactivation · ⏳ Review Hub not yet updated

---

### LAW 12: VERIFICATION MUST MIRROR USER REALITY

**Rule:** "Deploy successful" cannot be reported unless browser-level checks confirm visible UI elements work as the user experiences them. Marker presence in DOM is necessary but not sufficient.

**What curl/markers miss:** elements hidden via CSS, JS that doesn't run due to uncaught errors, interactive elements that don't respond.

**Verification tiers (all must pass):**
1. **curl-based** (`verify-deploy.js`): file reachable, markers in source, CSS contrast, API endpoints
2. **Browser-based** (`verify-browser.js`): Playwright loads each page with real auth, confirms elements VISIBLE, tests interactions, saves screenshots
3. **CDN propagation:** verify-deploy.js sends `Cache-Control: no-cache` to bypass edge cache

**Regression test principle:** Every bug Tyler personally reports becomes a permanent automated test.

**Established:** May 9, 2026 — pattern of "ship → still broken" loops where verify-deploy.js said 🟢 but Tyler's experience said broken.

**Status:** ✅ Both tiers enforced · screenshots saved to `verify-screenshots/`

---

### LAW 13: BUG VARIANTS REQUIRE GENERALIZED DETECTION

**Rule:** When a bug class is diagnosed, the verification system must scan for ALL variants across the entire dataset.

**Generalized scanner (`checkJobHistoryIntegrity()`):**

| Class | Detection | Threshold |
|-------|-----------|-----------|
| A — csv_backfill collision | same-date, or near-date ≤14d + similarity ≥80% | WARN ≤5, FAIL >5 |
| B — duplicate completions | same date, amount within $5 | WARN always |
| C — source:undefined entries | completed entries missing source field | WARN always |

**Idempotency guard principle:** `_doCompleteJob` guard must be source-agnostic. A duplicate = (date + status=completed + amount ±$5), regardless of source field.

**Established:** May 9, 2026 — Tanner Huysman showed the original guard was instance-specific and missed a near-date variant.

**Status:** ✅ Generalized scanner active · source-agnostic idempotency guard in `_doCompleteJob`

---

### LAW 14: VERIFICATION CANNOT SKIP WITHOUT FAILING

**Rule:** A verification step that silently skips when prerequisites are missing provides false confidence. Required verification steps must FAIL the deploy loudly.

**"Skipped" = "Failed."** No exceptions.

**verify-browser.js** exits(1) with explicit setup instructions when no credentials configured.

**One-time setup:**
```bash
cp .env.local.example .env.local
# Set ADMIN_PASSWORD=<login password>
```

**Established:** May 10, 2026 — browser verification silently skipped on its first run, defeating its purpose.

**Status:** ✅ Enforced — verify-browser.js exits(1) when no credentials

---

### LAW 15: NO SILENT FIRE-AND-FORGET ON PRIMARY WRITES (T1.20)

**Rule:** A `saveDb()` / `saveDatabase()` call that is the **primary or only** persistence of a user action MUST be `await`ed inside a `try/catch`, and on failure MUST surface the failure to the operator (toast / inline feedback / alert) AND roll back the in-memory mutation. Success UI (success screen, "Saved" flash, quote link, modal close) must NOT render until the write resolves. `.catch(()=>{})` on a primary write is banned — it shows false success for a customer/job that never persisted.

**Residual writes are exempt from the await, not the logging.** When the primary write is a verified D1 PATCH / dual-write (already error-handled upstream) and `saveDb()` only mirrors a secondary KV field, the call may stay non-blocking — but it must `.catch(e => console.warn('[context] KV sync failed:', e.message))`, never swallow silently. The `[context]` label is the enclosing function so a failure is traceable in the console.

**The trap:** the worst instance (new_customer `submitDigitalPath`) ran `showSuccess()` + handed Tyler the quote link, THEN fired `saveDb()` fire-and-forget. A failed write meant the customer was never persisted but Tyler had already sent the link.

**Enforcement:** verify-deploy.js markers in the calendar / new_customer / bulk_reactivation HTML_FILES entries (search `WO1 / Task #26`). Each marker is an error string or `[context]` label proving a hardened caller still surfaces/logs failure. Reverting one to a silent `.catch(()=>{})` deletes its marker → check goes red.

**Established:** 2026-06-23 — WO1 / Task #26 hardened 9 risky fire-and-forget callers (await + surface + rollback) and standardized 7 residual callers to logged catches across `pure_cleaning_calendar.html`, `pure_cleaning_new_customer.html`, `pure_cleaning_bulk_reactivation.html`.

**Status:** ✅ Enforced (markers) · codifies CLAUDE.md Rule 20 (T1.20)

---

## Deferred Projects

### Multi-Property Customer Schema

**Problem:** One `scheduledStatus` per customer. Multi-property customers collide — only one renders as a full primary card.

**Current workaround (May 13):** Per-job address on jobHistory entries + dedup in `getExtraCompletedJobsForRig` + full controls on `jobCardHistoryExtra`. Works for current volume (1 genuine multi-property customer — Kristina Seeber).

**Planned schema:**
- `customer.properties[]` — canonical address array
- `customer.scheduledStatuses[]` — one per property with active work
- `jobHistory[N].propertyId` — links each job to a property

**Latent bug:** For Kristina Seeber, Keith Wolf, Jim New, Maria Correnti, Keith Beckler, Tara & Aldo Rodriguez — csv_backfill selected as `primaryEntry` (appended last during bulk backfill). Real completion appears as extra card on May 4–6. Will surface if Tyler navigates to those weeks.

**Scope:** ~16h across 2 sessions. Full design: `docs/SCHEMA_MULTI_PROPERTY.md`.

**Trigger:** When property manager clients become more common OR extra-card workaround causes friction. Not mid-week.

**Deferred:** May 13, 2026

---

### Calendar Dedup Architecture Rework

**Status:** Blocked on Multi-Property Schema decision. Do NOT ship more `getExtraCompletedJobsForRig` patches.

**Root problem:** Dedup discriminators (`jobId`, `_lastJobId`, address match, source) are not reliably present across all records. Real fix requires Path 2 schema where each job has a unique primary key.

**Deferred:** May 13, 2026

---

### Property Attribute Capture for Upsell Intelligence

**Goal:** Know what's on a customer's property before suggesting a service.

**Data sources (in order of effort):** quote form additions → BCPA parcel records → crew photo capture → satellite imagery

**Dependency:** ML Tier 3 fields in `cloudflare-worker/src/JOB_HISTORY_SCHEMA.md`.

**Scope:** 8–15h total. Quote form changes alone: 1–2h.

**Deferred:** May 9, 2026

---

### Weekly Data Snapshot Exporter → Google Drive

**Status:** Shipped May 12, 2026. Monday 4 AM UTC cron writes 4 JSON files to `PureCleaningCRM` Drive folder. OAuth refresh token persisted in KV.

**Files:** `weekly_summary.json`, `customer_health.json`, `operations_metrics.json`, `exceptions.json`

---

### ML Data Pipeline

**Phase A (done):** Schema audit — `cloudflare-worker/src/JOB_HISTORY_SCHEMA.md`

**Phase B (done):** Tier 1 fields on every new completion (crewSize, jobNumber, customerTier, sqFt, geocodedCoords). Tier 2: morningStops linked at completion.

**Phase C (deferred):** Day route view — `pure_cleaning_day_route.html` shipped May 12.

**Phase D (deferred):** Model training once 500+ GPS-matched jobs (~12 months at current pace).

**Key gaps:** sqFt not captured on new jobs (only csv_backfill), morning stops not linked to job entries post-hoc, no propertyType/weather snapshot.

---

*Active rules (one line each) → `CLAUDE.md`*
*Project history and decisions log → `docs/HISTORY.md`*
