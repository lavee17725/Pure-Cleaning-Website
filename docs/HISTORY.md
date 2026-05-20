# Pure Cleaning CRM — Project History

> Chronological log of what happened, why, and what it changed.
> Active rules → `CLAUDE.md`. Architecture rationale → `docs/ARCHITECTURE.md`.

---

## Timeline

### May 20, 2026 (Tuesday night) — Day 2: Dual-Write Cutover — COMPLETE

**Status:** Complete. Shipped 4 days ahead of May 24 target.

**Migration manifest:**
```json
{
  "migrationId": "day_2",
  "status": "complete",
  "startedAt": "2026-05-19T23:00:00Z",
  "completedAt": "2026-05-20T02:30:00Z",
  "commits": [
    "7afd0d8  Phase 1 — 6 delta customers backfilled to D1",
    "2343689  Phase 2 — dual-write enabled for 5 of 11 paths",
    "1485074  Phase 3 — reconciliation + 18-job backfill",
    "d8adc0d  Phase 4A first attempt — GET /customers to D1",
    "4201231  Phase 4A follow-up — scheduledStatus logic + delete 10 phantom rows",
    "7172313  Phase 4A rollback — D1 job coverage gap discovered",
    "2bd9562  Drift fix — 21 UPDATE Job.scheduledDate + dual-write bug fixed",
    "2c7bc8d  Phase 4A re-attempt — clean flip + KV Bouncie bridge"
  ],
  "finalState": {
    "d1PersonCount": 1245,
    "d1PropertyCount": 1224,
    "d1PersonPropertyCount": 1246,
    "d1JobCount": 1838,
    "kvCustomerCount": 1245,
    "reconciliationDiscrepancies": 0
  },
  "notes": "D1 canonical for reads. KV write-canonical via dual-write. TEMP KV bridge merges Bouncie GPS + geocoded coords. 4 dual-write paths uncovered: cancel, revert, customer update, customer delete. /admin/worker-hours/customer/:phone still reads KV directly (deferred)."
}
```

**Key learnings:**
1. **Diagnose-first:** Two wrong hypotheses surfaced before code was written — "30 days of missing jobHistory" (zero missing) and phantom-10 phone list (6 of 10 phones were wrong guesses). Read-only audit scripts prevented wasted inserts.
2. **scheduledDate ≠ completedAt:** D1 dual-write was writing `jh.date` (completion date) as `Job.scheduledDate`. Calendar places customers by scheduled date. 21 customers affected; fixed with surgical UPDATEs + dual-write helper corrected.
3. **Phase gate discipline:** Phase 4A read flip was premature — D1 had correct structure but wrong date semantics. Rollback restored calendar in 30 seconds. All migration infrastructure stayed intact.
4. **KV bridge pattern:** For fields absent from D1 schema (Bouncie GPS, geocoded coords), a single parallel `KV.get()` merges data into D1 reads. Marked TEMP with explicit removal condition.

**Forward queue:**
- D1 schema: Bouncie GPS columns (`actualDuration`, `geocodedLat/Lng`)
- Geocode backfill: populate `Property.latitude/longitude`; dual-write to geocode endpoint
- Remove KV bridge after D1 schema extended and backfill complete
- Cover 4 remaining dual-write paths (cancel/revert/update/delete)
- Flip `/admin/worker-hours/customer/:phone` to D1

---

### May 16–17, 2026 — Day 1 D1 Migration Complete

**Migration ID:** c9acb27c-9268-4296-8de3-7c38aff10bdd

**Source snapshot:** `pre_migration_2026-05-16T044311_1239customers.json` (1,239 customers)

**Result:**
- 1,239 Persons loaded
- 1,218 Properties (1,214 primary + 3 per-job address + 1 UNKNOWN placeholder)
- 1,240 PersonProperty links
- 1,825 Jobs (1,811 completed + 14 scheduled)

**Verified by:** 5-point spot-check (Kristina Seeber aliases, Property Keepers manager, Audrey & Frank Seeber separate, Bob Fishman 3-year span, orphaned job placeholder). All counts matched manifest preview exactly.

**KV remains canonical.** D1 ready for Day 2.

**Recovery baseline:** `wrangler d1 time-travel restore pure-cleaning-crm-v1 --timestamp=2026-05-16T14:11:42Z`

**Schema locked:** May 13, 2026. 8 tables, 14 indexes (2 partial). See `cloudflare-worker/migrations/0001_initial_schema.sql`.

**Spec gaps surfaced during migration:**
1. Robinson Nolasco (954-687-7537): phone not in KV — 4 unrelated Robinsons with different phones. No alias merge done. Spec based on older dataset.
2. Hart's Painting referral pattern: no `REFERRAL_*` phone records in current KV. Deferred to post-migration manual setup.
3. Kristina Seeber 4th property (6520 SW 18 Ct): not in any jobHistory entry. Omitted; will add manually if needed.

**D1 batch size discovery:** `wrangler d1 execute --file` rejects multi-statement SQL files above ~133KB with `SQLITE_TOOBIG`. Fix: execute one 25-row INSERT batch per wrangler call (225 total calls for the full migration).

---

### May 15–16, 2026 — Mom's Friday Session: Fixes 1-5

**Context:** Mom (Sissy Fumero) sat down with Tyler to review the admin app. Identified several paper-cut friction points.

**Fix 1 — Remove zero defaults from number inputs (Rule 18):** All `type="number"` inputs across the admin app pre-filled with `value="0"`. Changed to `placeholder="Enter amount"` or equivalent. 10 changes across 4 files. Committed `0324581`.

**Fix 2 — Job sheet printout redesign:**
- Removed Google Maps link (meaningless on paper)
- Removed completion checklist (6-item sign-off table Mom doesn't use)
- Customer name: 20pt → 28pt, phone 14pt → 18pt, address 12pt → 20pt bold
- Quoted total: 20pt → 36pt bold red, "Total: $X" with word "Total:" prepended
- Services heading: 8pt → 14pt with divider line; service items: 11pt → 16pt
- Notes: gate codes at 18pt bold (separate from regular notes at 14pt)
- Gate code detection regex catches: gate, lockbox, keypad, access code, entry code, code: N

**Fix 3 — "Schedule it now" requires a price:** The three-option post-save modal's "Schedule it now" path was writing `approvedAmount: 0` when no price entered. Added required Price field above the date picker. Button disabled until valid positive number entered. Wrote confirmed `approvedAmount: price` instead of `c.quoteStatus?.mainAmount || 0`.

**Diagnosed:** Insights page (`pure_cleaning_insights.html`) reads `job.total` but every jobHistory entry uses `job.amount`. 1,811 jobs invisible to insights page. Only 24 currently-scheduled jobs (from `scheduledStatus.approvedAmount`) were visible — explaining the "16 jobs since May 2026" symptom. Fix deferred to D1 SQL rewrite (Sunday after Day 1 migration).

---

### May 14, 2026 — KV Write-Path Discovery

**Context:** Investigating why `POST /import/snapshot` appeared to fail, then discovering snapshots existed in the worker's view but not in `wrangler kv key list`.

**Discovery:** Two distinct edge states exist for the same KV namespace:
- **`wrangler kv key get/put` path:** Cloudflare KV API directly
- **Worker runtime `env.DATA` path:** Worker-internal KV reads/writes

Same namespace ID, different data. Writes from the shell land in a different edge location than `saveDb()` calls from the browser. Eventual consistency did NOT converge during the session.

**Evidence:**

| Reader | customer_db count | Snapshots visible | Bob Kirk |
|--------|-------------------|-------------------|----------|
| `wrangler kv key get` | 1,235 | none | absent |
| Worker `/customers` API | 1,240 | 10 snapshots | present |

**Consequence:** 14 hours of shell-path data repairs (Jim New payment, Keith Wolf payment, Seeber Hope, 2 phantom deletions) appeared successful but were silently overwritten by browser `saveDb()` calls. None of those repairs landed in production.

**Rule added (Rule 16):** All reads/writes go through worker admin API. Wrangler kv = diagnostic only.

---

### May 13, 2026 — Calendar Dedup Day + Phantom Cleanup

**Phantom records discovered:** ED Mendez (9548038318) and Pravin Basnyet (9549099618) had phantom duplicates created by the double-push bug in `new_customer.html` — `allCustomers.push(customer)` and `dbRecord.customers.push(customer)` both ran, but they reference the same array. On next load, two objects deserialized as distinct records. Fixed by removing duplicate push lines.

**Late-completion phantom fix (Option A):** Jobs completed late (today ≠ scheduledDate) appeared as extra cards on today's column. `_doCompleteJob` writes `jhEntry.date = isoToday()` but never updates `ss.scheduledDate`. Fixed: `getExtraCompletedJobsForRig` now dedupes by `ss._lastJobId` (job identity) before the date-based `ssCovers` check.

**Bob Kirk `_lastJobId = None` bug:** Idempotency guard only set `_lastJobId` on the non-duplicate path. If a revert cleared `_lastJobId` and re-completion found an existing jh entry, the guard skipped push and left `_lastJobId = None`. Fixed with `else` branch that reads `_lastJobId` from the existing matching entry.

**Multi-property customers (Kristina Seeber):** Real estate agent paying for cleaning at multiple Hollywood addresses. `jobCardHistoryExtra` was a stripped-down chip with no action buttons. Fixed to render full controls (Print, Email, Complaint, Zelle, Log Payment, Send Receipt, Edit) targeting the specific `jhEntry.jobId`.

**Payment defaulting:** All payment modals hardcoded cash as default, ignoring `preferredPaymentMethod`. Fixed. `fullEditModal` extended with 15th field (payment method, visible only on completed jobs) — writes 5 fields atomically via `_applyPaymentMethod()`.

**Drag on completed jobs:** `handleDropToRig` unconditionally set `state='scheduled'`, corrupting completed jobs. Blocked drag on completed jobs. Pencil edit now updates both `scheduledStatus.rig` AND `jhEntry.rigId` atomically.

**Bob Kirk note (resolved):** Bob Kirk appeared in the Playwright diagnostic session as scheduled/completed at phone 9543490771, rig rig_1, scheduledDate 2026-05-05. His `_lastJobId` was set to `9543490771_2026-05-13_25000_calmp4fjinz` via admin API data fix on May 14. Record confirmed present in D1 migration snapshot.

---

### May 7–12, 2026 — Foundation Week

A condensed log of architectural decisions. For full narrative, see the decisions table below.

Key events:
- **May 7:** CSV backfill of 1,819 historical jobs. `source: 'csv_backfill'` flag added. `getEffectiveStats()` pattern established. jobHistory[] made canonical.
- **May 8:** Admin auth deployed (all admin pages gated). Pre-commit secret scanner added. Error monitoring (POST /errors/log, pure_cleaning_errors.html). R2 offsite backup cron added. verify-deploy.js expanded to 32 checks. DNS migrated to Cloudflare Workers (completed May 11). Spam protection on POST /incoming (rate limit + honeypot).
- **May 9:** Playwright browser verification added (verify-browser.js). Bulk Reactivation rewritten with per-job service categorization (ground/roof). Calendar drag-to-navigate added. Architectural Laws 1–13 codified. Auto-auth via .env.local.
- **May 10:** Class A/B/C jobHistory cleanup — 27 changes, 0 issues remaining.
- **May 11:** Per-worker hours tracking shipped. DNS cutover from GoDaddy/GitHub Pages to Cloudflare Workers confirmed stable. Inline ETA button per job card.
- **May 12:** Verbal quote lifecycle (quoteLifecycle, quoteHistory[]). Weekly Google Drive export. Day Route View (per-rig per-day timeline). Roof story selector (1/2-story, stored on scheduledStatus). Cache-Control headers fixed (run_worker_first = true required).

---

## Architectural Decisions Log

| Date | Decision | Why |
|------|----------|-----|
| May 7, 2026 | `jobHistory[]` is canonical source of truth for completed jobs | `_doCompleteJob()` was leaking completions; jobHistory now written on every completion and read by all downstream logic |
| May 7, 2026 | CSV backfill of 1,819 historical jobs flagged `source: 'csv_backfill'` | 4 years of data loaded; flag prevents false positives in review queue and revenue calculations |
| May 7, 2026 | `getEffectiveStats()` pattern: jobHistory overrides stale top-level fields | Backfill populated jobHistory but left `lastService`/`lifetimeSpend`/`totalJobs` stale; getTier() diverged from display |
| May 7, 2026 | `csv_backfill` source guard on review eligibility | Backfill entries have `completedAt: null`; date-fallback `j.date + 'T'` was making future scheduled jobs pass eligibility |
| May 7, 2026 | Combined CSV backfill + Erik Chafin revert in one KV write | Both target `customer_db`; sequential writes meant the second would silently overwrite the first |
| May 7, 2026 | SEO emergency fix on homepage | Google crawler saw JS placeholder ("enable JavaScript"); added meta, LocalBusiness JSON-LD, sitemap.xml, robots.txt |
| May 7, 2026 | Zelle button saves `paymentRequestSentAt` only, does not complete job | Zelle is async payment; completion is a separate deliberate action by the operator |
| May 7, 2026 | `ss.revertLog[]` append-only, removes only matching `calendar_completion` jh entry | Full audit trail of who reverted what; does not disturb other fields or historical entries |
| May 8, 2026 | `npm run deploy` runs gh-pages + wrangler + verify atomically | Three silent-fail deploys went to Workers only; user-facing GitHub Pages was never updated |
| May 8, 2026 | `.req-name { color: var(--text) }` — changed from `var(--white)` | White text on white card had been invisible for months; looked like a data bug, was CSS |
| May 8, 2026 | `scripts/verify-deploy.js` with 32 checks runs post-deploy | Catches: wrong deploy target, CSS contrast regressions, missing code markers, API health |
| May 8, 2026 | API worker deploys from `cloudflare-worker/src/` only | Root `wrangler.jsonc` is static assets; running `wrangler deploy --name purecleaning-api` from root overwrote the API worker → all routes 404 |
| May 8, 2026 | Cron heartbeat: `bouncie:last_cron_run` KV key written after every nightly run | Silent cron failures were undetectable; heartbeat + 26h staleness check in verify-deploy.js closes the gap |
| May 8, 2026 | DB integrity check: `scripts/integrity-check.js` | 1,243 customer single-blob KV; malformed record can crash calendar/directory silently; found 6 duplicate phone entries on first run |
| May 8, 2026 | Pre-commit secret scanning via husky + `scripts/secret-scan.js` | Git history is permanent — once pushed, key must be rotated even after deletion |
| May 8, 2026 | Admin auth: KV-stored session tokens, single shared password | Customer DB (1,243 records) was publicly accessible to anyone who knew the URL |
| May 8, 2026 | Mobile UA verification in verify-deploy.js | Tyler builds on Mac; Mom and drivers use mobile; first run found calendar .cal-grid at 1225px and 8/18px tap targets in bulk reactivation |
| May 8, 2026 | Centralized error monitoring: POST /errors/log, GET /admin/errors, window.onerror | Client-side JS errors were previously invisible — only visible in browser console or Cloudflare logs |
| May 8, 2026 | R2 offsite backup: nightly cron at 4 AM UTC writes customer_db + 7 other KV keys | KV-only backup strategy had single point of failure |
| May 8, 2026 | Customer quote flow refactored for auth: GET /links public, POST /quote/{code}/approve scoped | Auth deploy broke q.html (GET /links returned 401) and approval/reschedule flows |
| May 8, 2026 | agreement.html + receipt.html broken post-auth; GET /customer/{phone} scoped endpoint added | Both pages called GET /customers on page load |
| May 8, 2026 | AUTH_BOUNDARIES.md created; verify-deploy.js CHECK 8 auto-audits customer pages | Systematic prevention of same bug class: any customer HTML fetch() to non-public path = deploy failure |
| May 8, 2026 | Spam protection on POST /incoming: 5/IP/10min rate limit, honeypot, structural validation | Friendly pen-test flooded POST /incoming with 102 entries in <10min |
| May 8, 2026 | verify-deploy.js smoke test was polluting incoming_requests KV | Old CHECK 8 sent `POST /incoming` with smoke_test body on every verify run |
| May 8, 2026 | csv_backfill collision fix: duplicate calendar cards on 14 customers | `getExtraCompletedJobsForRig` lacked guard against csv_backfill entries when active scheduledStatus existed for same date |
| May 8, 2026 | csv_backfill guard rule: csv_backfill entries need explicit guards in "find most recent entry" code paths | By definition synthetic historical records with `completedAt: null` and no GPS data |
| May 8, 2026 | Review Hub white-on-white CSS bug: `.card-name { color: var(--white) }` on white card | Copy-pasted dark-background CSS into a light-background page |
| May 8, 2026 | Review Hub: `isReferralOnly` customers appearing in Google Review queue | `reviewIsReadyToRequest()` only checked `c.deleted`; added guards for isReferralOnly, optOut, REFERRAL_ prefix |
| May 8, 2026 | ML data pipeline foundation: `JOB_HISTORY_SCHEMA.md` created | Documents current jobHistory schema (3 write paths), gap analysis vs ML feature set, 6-tier migration plan |
| May 9, 2026 | Error tracker blind spot closed: Law 9 pattern applied to page-init catch blocks | `tryLoadDatabase()` in bulk_reactivation caught ReferenceError before window.onerror saw it |
| May 9, 2026 | Bulk Reactivation rendering silent ReferenceError fixed | `const tc = tierClass(c.tier)` dropped from `renderTable()` map callback; `${tc}` threw ReferenceError silently |
| May 9, 2026 | Tier 2 ML fields shipped: morningStops linked to job entries at completion time | `_doCompleteJob` reads `_morningStopsData[completedDate][rig]` and snapshots into jobHistory entry |
| May 9, 2026 | Tier 1 ML fields shipped: crewSize, jobNumber, customerTier, sqFt, geocodedCoords on every new completion | Full ML context captured at completion time |
| May 9, 2026 | Auto-alert spike detection (Law 10 Phase 1) | Passive monitoring is not monitoring — push beats pull |
| May 9, 2026 | Bulk Reactivation rewritten with per-job service categorization | Old logic used quoteStatus text for a single service type; new: scans jobHistory per entry for lastGroundDate and lastRoofDate |
| May 9, 2026 | `categorizeService(text)` shared function added (Law 11) | Single source of truth prevents drift across features |
| May 9, 2026 | Bulk Reactivation roof eligibility bug fixed — `monthsSince(null)` sentinel trap | `monthsSince(null)` returns 999; eligibility checked `monthsSinceRoof !== null` (always true); fix: check `lastRoofDateObj !== null` directly |
| May 9, 2026 | Calendar week-view drag-to-navigate added (`_weekNavDrag`) | Mouse drag ≥ 100px navigates week; touch swipe already worked |
| May 9, 2026 | Tanner Huysman duplicate card: csv_backfill imported future-dated job | CSV imported upcoming job as completed on May 7 (2 days before import) |
| May 9, 2026 | Seeber duplicate card: `_doCompleteJob` idempotency guard missed `source:undefined` entries | Guard checked `j.source === 'calendar_completion'` but double-completion created entries with `source: undefined` |
| May 9, 2026 | Law 12 + Playwright browser verification added (`scripts/verify-browser.js`) | Curl-based checks confirm DOM presence but not visibility |
| May 9, 2026 | `_doCompleteJob` idempotency guard made source-agnostic (Law 13) | Duplicate = (date + amount ±$5), not source field value |
| May 9, 2026 | `checkJobHistoryIntegrity()` added — three-class generalized scanner | Class A: csv_backfill collisions; Class B: duplicate completions; Class C: source:undefined entries |
| May 9, 2026 | Auto-auth via `.env.local` — all verification scripts now authenticate automatically | Replaces every `process.env.VERIFY_TOKEN` reference |
| May 10, 2026 | Class A/B/C jobHistory cleanup executed — 27 changes, 0 issues remaining | 15 csv_backfill ghost entries deleted; 7 duplicate completions deleted; 5 undefined-source patched |
| May 11, 2026 | Schedule view: inline ETA button per job card | Replaced bottom-of-rig arrival rows |
| May 11, 2026 | Per-worker hours tracking shipped | actualDuration × every worker in crew[]; /admin/worker-hours endpoint; payroll foundation |
| May 11, 2026 | DNS migrated from GoDaddy/GitHub Pages to Cloudflare Workers | Sub-30s propagation confirmed. Rollback: GoDaddy NS → ns09/ns10.domaincontrol.com |
| May 11, 2026 | SortableJS interference bug fixed: initSortables() now resets wasDragging=false | onAdd fires before onEnd in SortableJS v1.15; destroying Sortable mid-dispatch left wasDragging=true permanently |
| May 11, 2026 | Calendar week-view drag changed to day-by-day sliding window | `dayOffset` replaces `weekOffset * 7`; DAY_DRAG_PX = 150px per day |
| May 11, 2026 | Schedule view: all 3 rig swimlanes always visible + click-to-assign rig picker | Empty swimlanes show "No jobs assigned"; openRigPickModal → applyRigPick → saveDb() |
| May 12, 2026 | Verbal quote lifecycle shipped: quoteLifecycle string + quoteHistory[] array | quoteStatus is a complex object used everywhere — new lifecycle tracking uses separate top-level fields |
| May 12, 2026 | Weekly data export to Google Drive shipped | Every Monday 4 AM UTC; 4 JSON files to PureCleaningCRM Drive folder |
| May 12, 2026 | BCPA link UX fixed across 5 files, then reverted to plain link + Copy button | BCPA's hash router never parsed `searchValue` param in practice; verified URL correct but BCPA destination didn't honor it |
| May 12, 2026 | Day Route View shipped | Per-rig per-day timeline from Bouncie GPS + jobHistory: Home → drive → 7-Eleven/Pro-Line → Jobs → Home |
| May 12, 2026 | Day Route View extended with Week View + Averages View | 7-day × 3-rig grid; dwell times; rig utilization |
| May 12, 2026 | Roof story selector added (1-story or 2-story) | Admin-only; stored in scheduledStatus.roofStories, jobHistory[].roofStories |
| May 12, 2026 | ETA text content corrected: 3 slots (10 AM, early afternoon, late afternoon) | Previous: 9 AM + 6 granular slots; template: "pressure cleaning [service] tomorrow around [slot]" |
| May 12, 2026 | Cache-Control headers fixed — HTML no-cache, hashed assets immutable | Cloudflare [assets] binding bypasses fetch handler without run_worker_first = true |
| May 12, 2026 | 'Didn't ask' option added to 'How did they hear about us?' | Mom can save without blocking when info wasn't captured; web form unchanged |
| May 12, 2026 | Phone-quote intake flow simplified to 3-option post-save modal | Schedule it now / Add to Incoming Queue / Build mini quote |
| May 13, 2026 | Calendar drag: fluid 1:1 translateX, snap-back 150ms, 50px dead zone | Replaced 50% parallax drag; any horizontal drag suppresses post-release click |
| May 13, 2026 | Calendar pencil → full edit modal (fullEditModal, 14 fields) | Replacing "Edit services" mini-modal; phone is primary key |
| May 13, 2026 | Drag-on-completed-jobs bug fixed | handleDropToRig unconditionally set state='scheduled', corrupting completed jobs |
| May 13, 2026 | Continuous drag: dayOffset increments in real-time | No release needed to commit each day |
| May 13, 2026 | Home commute distance banners per rig swimlane | haversine + 1.3× correction + 35mph average |
| May 13, 2026 | Dual-card render bug after rig-correction fixed | saveFullEdit now writes BOTH rig + rigId atomically (jhEntry.rig = ss.rig || null) |
| May 13, 2026 | Existing-customer detection + alt phone field shipped | 3 detection triggers (phone 300ms, address 500ms, name 500ms); rich match banner |
| May 13, 2026 | Payment logging silent failure — drag suppressor was eating modal clicks | _weekNavDrag's click suppressor fired on ALL next clicks; fixed to exclude clicks inside modals |
| May 13, 2026 | jobCardHistoryExtra now renders with full action controls | Print, Email, Complaint, Zelle, Log Payment, Send Receipt, Edit — all targeting jhEntry.jobId |
| May 13, 2026 | Calendar render dedup refined for multi-property same-day jobs | ssCovers branch now skips only the specific entry primary card represents; others render as extras |
| May 13, 2026 | Double-push phantom cleanup: 4 records deleted (ED Mendez, Pravin Basnyet, 2 Queue Test) | Double-push bug in new_customer.html — allCustomers and dbRecord.customers are the same array |
| May 13, 2026 | Double-push bug fixed in new_customer.html | Removed duplicate allCustomers.push(customer) lines at 1736 and 1777 |
| May 13, 2026 | Christina Seeber multi-property pattern: per-job address on primary card | jh.address preferred over customer.address when present |
| May 13, 2026 | Payment defaulting bug fixed across three modals | All payment modals now read preferredPaymentMethod || c.paymentMethod as default |
| May 13, 2026 | Three-field payment write bug fixed via `_applyPaymentMethod()` | Writes 5 fields atomically: c.paymentMethod, c.paymentInfo.method, jh.paymentMethod, jh.payment, jh.paymentInfo.method |
| May 13, 2026 | Late-completion phantom card bug fixed | getExtraCompletedJobsForRig dedupes by ss._lastJobId before date-based ssCovers check |
| May 14, 2026 | KV write-path split discovered (see narrative above) | wrangler kv and worker runtime access different edge states; Rule 16 codified |
| May 15–16, 2026 | Mom's Friday session fixes (1-5): job sheet, schedule price, zero defaults, insights diagnosis | See narrative above |
| May 16, 2026 | D1 migration Day 1 complete | 1,239 Persons / 1,218 Properties / 1,240 PersonProperty / 1,825 Jobs. Migration ID: c9acb27c |

*Append future decisions below this line.*
