# Auth Boundaries — Pure Cleaning API

> Every endpoint added to the worker **must** be listed here first.
> If a customer-facing page needs data, create a scoped public endpoint — never expose `/customers` or other admin-only endpoints to the public.

---

## Public Routes (no auth required)

These endpoints are in the `isPublic` check in `index.js`.

| Path | Method(s) | Called by | Scope |
|------|-----------|-----------|-------|
| `/health` | GET | verify-deploy.js, uptime monitors | Returns `{ status, timestamp, customerCount }` |
| `/auth/login` | POST | login.html | Validates password, returns session token |
| `/auth/logout` | POST | Any admin page | Invalidates session token |
| `/errors/log` | POST | All HTML pages (error-tracker.js) | Appends error entry; rate limited 20/IP/min |
| `/links` | GET | q.html (link resolver) | Returns short-link map |
| `/incoming` | POST | public quote form, reschedule | Appends one entry; never exposes existing list |
| `/customer/{phone}` | GET | agreement.html, receipt.html | Returns ONE customer's record by phone; rate limited 30/IP/min |
| `/quote/{code}` | GET | customer_quote.html, agreement.html | Returns that specific quote |
| `/quote/{code}/approve` | POST | customer_quote.html | Scoped update: phone-validated, updates only quoteStatus + scheduledStatus |
| `/agreement/{phone}/confirm` | PUT | customer_quote.html | Customer confirms agreement |
| `/agreement/{phone}/skip-reminder` | POST | customer_quote.html | Customer skips reminder |
| `/agreement/{phone}/log-reminder` | POST | customer_quote.html | Logs reminder send |
| `/appointment/{phone}/*` | POST | customer_quote.html | Customer requests date change |
| `/receipt/{phone}` | GET | receipt.html (?phone path) | Returns that customer's receipt |
| `/invoice/{invoiceId}` | GET | pure_cleaning_invoice.html (?id path) | Returns ONE invoice's render data — bill-to, line items, total, status. Tracks viewedAt on first call. Rate limited 30/IP/min. **Rule 13: this is the only endpoint pure_cleaning_invoice.html may call.** |
| `/public/review-count` | GET | public homepage (index.html), future customer-facing pages | Returns `{count, rating, lastUpdated}` from KV `reviews_data` — same store as legacy `/reviews` (admin home writes via `POST /admin/reviews/actual-count`). Rate limited 30/IP/min. 5-min browser cache. |
| `/public/google-reviews` | GET | public homepage (index.html) | Returns up to 5 5-star reviews `{author, rating, text, time, relativeTime}` from Google Places place-details + a `placeMeta` object so the resolved listing is visible on every response. Worker calls Places API with server-side `GOOGLE_PLACES_API_KEY` (T1.14). 24h KV cache (`pcpc_google_reviews`), 1h browser cache. Place ID is resolved via Find Place on each cache miss (~1/day) — **never written to KV as a permanent cache**, to prevent a wrong-listing-cached-forever footgun. Once Tyler confirms the resolved listing from `placeMeta`, the `PURE_CLEANING_PLACE_ID` constant in the worker is set and lookups stop entirely. Homepage has static 4-quote fallback if endpoint 5xx's. Rate limited 30/IP/min. |
| `/public/quote-photo?leadId=…&idx=0..5` | POST | public quote form (quote.html) | Lead photo upload for the public quote form. Body is raw bytes (image/jpeg \| image/png \| image/webp). Five layered guards: (1) rate limit `rate:quotephoto:{ip}` 10/IP/hour, (2) max 4 MB body, (3) Content-Type allow-list, (4) magic-byte sniff (declared type must match first bytes of body), (5) **R2 quarantine prefix** `quote-leads/{leadId}/...` separate from any `job/` or `property/` key. `leadId` sanitized to `[A-Za-z0-9_-]{8,64}`. Returns `{success, key, type, size}` or `{success:false, reason}` (reasons: `rate_limited` / `too_large` / `wrong_type` / `bad_lead_id` / `body_read_failed` / `too_small` / `magic_byte_mismatch` / `r2_write_failed` / `r2_not_configured`). T1.11: never 5xx (except 429 on rate-limited so test/client UX can distinguish). **NO public read route exists** — the keys are served only via `/admin/photos/key/*` which is admin-gated. The `quote-leads/` prefix is the quarantine; the auth boundary lives at the read endpoint. |
| `/reviews` | GET | LEGACY — receipt.html + pure_cleaning_quote.html (older customer-facing pages) | Returns `{count, lastUpdated}`. **Deprecated in favor of `/public/review-count`** but kept alive — new pages must use `/public/review-count`. |
| `/receipt/{phone}/track` | PATCH | receipt.html | Tracks receipt open event |
| `/dates/suggest` | GET | quote form | Returns suggested available dates |
| `/service-frequency` | GET | quote form | Returns service frequency config |
| `/addons-config` | GET | quote form | Returns add-on options |
| `/oauth/google/start` | GET | Tyler's browser (one-time setup) | Redirects to Google consent screen |
| `/oauth/google/callback` | GET | Google (redirect target) | Exchanges auth code for refresh token |

---

## Admin-Only Routes (require `Authorization: Bearer <token>`)

Any path **not** listed above requires a valid session token. Attempting access without auth returns 401.

Key protected resources:
- `GET /customers` — full customer DB (1,243 records)
- `PUT /customers` — replaces entire customer DB (destructive)
- `GET /incoming` — all quote requests
- `PUT /incoming` — replaces incoming list
- `GET /admin/*` — all admin endpoints (errors, backups, reviews, cron heartbeat, alerts-active, google-drive/status, export-weekly)
- `GET /admin/day-route?date=YYYY-MM-DD&rig=rig_1|rig_2|rig_3` — per-rig operational timeline from Bouncie GPS + jobHistory
- `GET /admin/insights?start=YYYY-MM-DD&end=YYYY-MM-DD&prevStart=&prevEnd=&source=all|live` — D1 revenue/job aggregates for insights page; returns completed, pipeline, ytd, prevCompleted, migrationDate
- `GET /admin/monthly-breakdown?month=YYYY-MM` — one row per job-group for the month (Excel-style table for Mom). Excludes rig_segment children + day-children (parent represents the group); computes groupAmount in SQL since multi-day parent.amount is Day-1 slice only. Date filter is business date (completedAt → ET for completed, scheduledDate otherwise). Address: workSiteAddress-first, partner-aware. Returns { month, rowCount, totalRevenue, paidCount, unpaidCount, rows[] }.
- `POST /admin/bouncie/probe-coords` — read-only diagnostic. Body: { lat, lon, dates: ['YYYY-MM-DD', ...] }. Fetches Bouncie trips per mapped rig for each date and reports closest dwell. No D1/KV writes. Used to diagnose mismatches like "Ivan got no_data but Reza matched same day same rig". Returns { lat, lon, thresholdFt, minDwellMin, probes:[{ date, perRig:[{ rig, imei, tripCount, closestDistFt, withinGeofence, dwell }] }] }.
- `POST /admin/invoice/from-job` — body { jobId }. **Idempotent**: returns the existing Invoice row if jobIds JSON already references this jobId; otherwise creates Invoice + LineItems and increments DocumentCounter atomically. **Guard: jobs with source='csv_backfill' or source LIKE 'backfill_%' are rejected with HTTP 422 (`historical_record_not_invoiceable`) per Rule 12 / DL-04** — synthetic historicals are excluded from every actionable pattern and counter pollution is impossible. Sector ('commercial' if Person.customerType='commercial' OR Job.isCommercialJob, else 'residential' — partners get sector 'residential' but BILL TO the partner company with the WORKSITE as service address). Multi-day parents expand into one LineItem per non-rig child + parent (Day 1). Status derived from Job.paymentStatus → 'paid' ⇒ status 'paid'; else 'sent' with paymentTerms (Person.billingNotes if present, else generic). Returns { invoiceId, invoiceNumber (e.g. INV-RES-2026-0001 or INV-COM-2026-0001), sector, status, total, url, idempotent:boolean }.
- `GET /admin/invoice/{invoiceId}` — Admin-scoped read: full editable shape including `internalNotes` (which the public GET /invoice/:id intentionally omits). Powers the new invoice editor page (`pure_cleaning_invoice_admin.html`) and the calendar modal's paid-toggle verify-after-write check (T1.20). Returns { invoiceId, status, paidInFull, subject, introText, notes, internalNotes, paymentTerms, paymentMethod, paidAt, sentAt, subtotal, total, amountPaid, lineItems[], customer{...}, jobIds[], createdAt, modifiedAt }.
- `PATCH /admin/invoice/{invoiceId}` — Two distinct flows on one route: **(A) Paid toggle** — body `{ paidInFull: true|false }`. `true` ⇒ status='paid', amountPaid=total, paidAt=now. `false` ⇒ status=(sentAt ? 'sent' : 'draft'), amountPaid=0, paidAt=null. **Voided guard**: rejects with HTTP 409 `invoice is voided` when current status='voided' (operator must explicitly restore first; voided→paid→sent would silently un-void). **(B) Content edit** — body any of `subject/introText/notes/internalNotes/paymentTerms/dueDate/lineItems/discountAmt`. Locked when status IN ('paid','voided') — returns HTTP 409 `invoice is locked` with hint to toggle off first. Recomputes subtotal/total when lineItems provided. Mirrors handlePatchProposal pattern (line ~10063). Both flows return the full updated invoice via handleAdminGetInvoice so the client's T1.20 verify-before-success check is a single read.
- `GET /admin/partners-ranked` — Returns `partner_referral` Person rows ranked by **real-job count** DESC: `COUNT(Job WHERE payerId=personId AND parentJobId IS NULL AND COALESCE(isRigSegment,0)=0 AND scheduledDate >= '2026-04-01')`. The predicates drop multi-day children, rig-segment children, and pre-system CSV-backfill history (inception cutoff per Tyler 2026-06-17). Subquery-per-row so partners with 0 real jobs still appear (LEFT-JOIN-with-predicates would collapse). Excludes `doNotContact=1`. Powers `new_customer.html`'s partner dropdown. Returns `{ partners:[{ personId, firstName, lastName, businessName, phone, email, jobCount }] }`. **Important context**: `Job.referredById` is dead (0 of 1,922 jobs); `payerId` is the only authoritative partner→job link.
- `POST /admin/reminder` — Create a manual follow-up reminder. Body `{ personId, followUpMonth:'YYYY-MM', note?, type? }`. `type` defaults to `'manual_follow_up'` (open container — future types like `'rebook_reminder'` ship by inserting rows + adding a bell render branch only). Validates `followUpMonth` against `^\d{4}-(0[1-9]|1[0-2])$`; verifies Person exists (404 otherwise). Inserts into D1 `Reminder` table (migration 0025) with `status='active'`. Returns the created row shape. Person can have **zero jobs** — reminders are person-scoped, NOT job-scoped (the canonical case: Peter, GM at Toku Miami, contact-only Person with phone but no job).
- `GET /admin/reminders-active` — Bell feeder. Returns reminders that are **both due AND active**: `WHERE status='active' AND strftime('%Y-%m','now') >= followUpMonth`. JOINed to Person so the card has `{ firstName, lastName, businessName, phone }` in one request. Month granularity intentional (day granularity invites silent snoozing; week granularity floods the bell). Returns `{ reminders:[{ reminderId, type, followUpMonth, note, createdAt, person:{...} }] }`. Reactivation infrastructure (`KV reactivation_contacts` + computed dormant pool) is intentionally separate — no collision.
- `POST /admin/reminder/{reminderId}/status` — Server-side status transition. Body `{ status: 'active' | 'done' | 'dismissed' }`. The bell's Dismiss button writes `'done'` so the dismissal is **cross-device** and never re-surfaces — this is the whole reason this is server-side instead of the existing localStorage `pcpc_notif_dismissed` path (T1.22 / Rule 22: server-side state for anything with a downstream consumer; localStorage only for ephemeral per-device UI state). 404 if `reminderId` not found.
- `GET /admin/person/{personId}/reminders` — Per-person history (all statuses, most-recent followUpMonth first). Powers the customer profile follow-up panel so the operator can see past dismissed/done reminders without leaving the page. Distinct from `/admin/reminders-active` which is global+due+active only.
- `POST /admin/geocode-rooftop-sweep?batch=N` — Phase 1 targeted re-geocode of properties that fell to weaker geocoders (`nominatim` / `census` / legacy `'google'` / NULL). Excludes `google_maps` (whatever precision Google returned can't improve via re-geocode) and `manual_override` (operator pinned by hand). Per row: normalize street ("Southwest"→"SW", "Street"→"St"...) → Google geocode → **upgrade-only** (ROOFTOP → write coords/precision/source/googleVerified/formattedAddress + re-capture zoom-19 satellite via `runSatelliteBackfillBatch`; anything else → leave row + add to deferred list). Earned from the Tom-Shelton regression: never swap one vague pin for another. Returns `{ processed, upgraded, deferred, failed, upgraded_ids[], deferred_list[], failures[] }` so the Phase-2 BCPA worklist is the response payload.
- `GET /admin/property/{propertyId}/for-measure` — Single-roundtrip bundle for the Surface Measure UI: `{ property:{...streetAddress, lat/lng/zoom + captured-lat/lng, satelliteImageKey, stories...}, surfaces:[…rows from Surface], rateCard:[…rows from RateCard] }`. Avoids 3 sequential fetches when the operator opens a tile.
- `GET /admin/property/{propertyId}/surfaces` — List traced surfaces for a property. Returns `{ propertyId, surfaces:[{ surfaceId, surfaceType, material, polygon, sqft, pricePerSqft, price, source, tracedBy, ts }] }`.
- `POST /admin/surface` — Create one Surface row (Phase 1 quoting-engine data layer). Body `{ propertyId, surfaceType, material?, polygon, sqft, pricePerSqft?, price?, tracedBy?, jobId? }`. Validates surfaceType against `driveway|patio|sidewalk|pool_deck|roof|wall|other` and material against `concrete|paver|rock|tile_barrel|tile_flat|shingle|metal|stucco|other`. `polygon` is `{ points:[{x,y},...], centerLat, centerLng, zoom, imgSize? }` — stored as JSON so the trace is reprojectable onto any future tile of the same property. Defaults `source='traced'`.
- `PUT /admin/surface/{surfaceId}` — Edit any field (material, sqft, prices, polygon, jobId, tracedBy).
- `DELETE /admin/surface/{surfaceId}` — Hard delete; Phase 1 has no soft-delete state.
- `GET /admin/rate-card` — List `RateCard` rows ordered by (surfaceType, material). Returns `{ rateCard:[{ surfaceType, material, pricePerSqft, storyModifier, notes, updatedAt }] }`. Powers the Measure UI's auto-fill on (surfaceType, material) pick. Seeded with concrete driveway = $0.13/sqft per `docs/QUOTING-ENGINE.md §3`.
- `PUT /admin/rate-card` — Upsert by `(surfaceType, material)`. Body `{ surfaceType, material, pricePerSqft, storyModifier?, notes? }`. `storyModifier` is the multiplier applied when `Property.stories=2` for walls.
- `GET /admin/drive-time?from=lat,lng&to=lat,lng` — Google Directions API proxy; KV-cached 7d; falls back to haversine; returns { duration_minutes, distance_miles, source: 'google'|'cache'|'haversine_fallback' }
- `GET /admin/drive-time/stats` — cache hit rate, total API calls, estimated cost since reset
- `GET /admin/places/autocomplete?input=<text>&sessiontoken=<uuid>` — Google Places Autocomplete proxy; US+address-type only, South FL biased; session token for cost optimization
- `GET /admin/places/details?place_id=<id>&sessiontoken=<uuid>` — Google Places Details proxy; KV cached 30d; returns parsed street/city/state/zip + lat/lng
- `POST /admin/properties/canonicalize-all` — historical migration: fetches place_id for all Property rows via Find Place API, then runs dedup pass; body: { phase: 'canonicalize'|'dedup'|'both', batchSize?, reset? }; Tyler-triggered only, not auto-scheduled
- `POST /admin/photos/auto-satellite?propertyId=...&quoteCode=...` — body `{address}`. Phase A satellite auto-fetch on new quotes. Server-side: geocode → Static Maps fetch with `env.GOOGLE_MAPS_API_KEY` (T1.14, key never client-side) → R2 `property/{propertyId}/satellite.jpg` → optional KV stamp on `quote_{code}` so `handleAgreementConfirm` carries the key even if `Property` row doesn't exist yet. **T1.11 contract: ALWAYS HTTP 200 with `{success, reason?}`**, never 5xx. Reason codes: `missing_address` / `missing_propertyId` / `maps_key_not_configured` / `geocode_failed` / `maps_fetch_failed` / `no_imagery` / `r2_write_failed`. No-imagery detected by `Content-Type !== image/jpeg`. Client (quote_builder_v2) fires once per quote session on address-field blur (fire-and-forget; never blocks `generateQuote`).
- `POST /admin/satellite-backfill?batch=200` — Phase B one-time existing-property backfill. SELECTs Property rows with `latitude/longitude IS NOT NULL AND satelliteImageKey IS NULL`, batch size capped at 500, sequential with 150ms delay per call (rate-respect). For each: fetches Static Maps with coords (skip geocode), writes R2 `property/{propertyId}/satellite.jpg`, UPDATEs `Property.satelliteImageKey` + `modifiedAt`. **Resumable** — re-running continues from where the prior batch left off (the WHERE clause skips populated rows). Returns `{fetched, no_imagery, failed, failures[≤20], total_remaining, no_coords_count, batch_size, duration_ms, processed}`. **Tyler-triggered only, NOT a cron.** Snapshot before first run via `POST /import/snapshot`.
- `POST /admin/quote-photo-connect` — body `{leadId, propertyId, photoKeys[]}`. **Lead→customer conversion (T1.22-Connect).** For each `quote-leads/{leadId}/...` key: R2 GET → R2 PUT to `property/{propertyId}/lead_{ts}_{n}.{ext}` → delete the source → append to `Property.photoKeys` JSON array (set-uniqued so re-runs are safe). Property row must exist (handleAgreementConfirm creates it during the quote flow); returns `success:false reason:property_not_found` otherwise, leaving R2 keys in place for retry. Called by `new_customer.html` on Person create (fire-and-forget, triggered by the incoming card's "👤 Convert →" button which builds the `fromOnline=` URL with `photos[]` + `leadId`). Idempotent. Schema dependency: migration 0022 (`Property.photoKeys` column).
- `GET /admin/quote-leads-stats` — orphan census for the `quote-leads/` R2 prefix. Returns `{total_objects, total_bytes, lead_count, oldest_upload, leads[≤50]}` where each lead entry is `{leadId, objects, bytes, oldest_upload}`. Surfaces what's sitting in quarantine from leads that never converted — visibility for a future retention-policy decision (e.g. 90-day janitor batch).
- `POST /admin/property/{propertyId}/measurements` — Build B ground-truth measurement vault. Body `{surface, sqft, source, detail?, polygon?, measuredAt?, measuredBy?}`. **Append-only**: read-modify-write the JSON array on `Property.measurements`. Validates surface enum (`driveway` / `patio` / `pool_deck` / `sidewalk` / `walkway` / `roof` / `other`), source enum (`tyler_measured_onsite` / `traced_satellite`), and `sqft > 0`. Rounds sqft to nearest 10. Polygon meta is optional and recorded verbatim for traced sources (re-auditable; future AI training input). Multiple entries per surface are intentional — the accuracy panel compares traced-vs-measured pairs. Schema dependency: migration 0021. **Read-surface-only consumer in this batch** (customer profile property card display); quoting/pricing integration explicitly out of scope.
- `GET /admin/property/{propertyId}/measurements` — returns `{propertyId, measurements[], count}` from the same column. Powers the tracer page's accuracy panel + the customer-profile read surface.
- `GET /admin/property-duplicates` — lists Property rows sharing a googlePlaceId (should be 0 after migration)
- `POST /admin/crew` — create a new CrewMember; body { name, phone, email?, hiredAt?, role?, notes? }; returns { crewMemberId, ...created fields }
- `GET /admin/crew` — list all CrewMembers (active + inactive); optional ?activeOnly=true to filter; returns { crew: [...] }
- `PATCH /admin/crew/:crewMemberId` — update a CrewMember; body any of { name, phone, email, hiredAt, role, notes, active }; returns updated record
- `DELETE /admin/crew/:crewMemberId` — soft-delete (sets active=0 + modifiedAt); returns { crewMemberId, active: 0 }
- `POST /admin/export-weekly` — triggers weekly Google Drive export (with optional `?from=&to=` params)
- `POST /admin/google-drive/set-folder` — stores Drive folder ID in KV
- `GET /events` — audit/event log
- `PUT /agreement/{phone}/edit-services` — admin edits services
- `POST /agreement/{phone}/manual-confirm` — admin confirms
- `customer/{phone}/delete` and other action paths
- `POST /customer/{phone}/never-ask-review` — sets c.neverAskReview=true on KV customer; permanent review queue exclusion
- `POST /customer/{phone}/clear-never-ask-review` — clears c.neverAskReview flag; re-enables review queue eligibility
- All Bouncie, photo, weather, task, calendar, link-generator endpoints

---

## THE RULE: Adding New Endpoints

1. **Update this file first** before adding to the worker.
2. **Customer-facing pages that need data must use scoped endpoints.** Never call `GET /customers` from a public page — that exposes all 1,243 records.
3. **Validate the caller has rights to the resource.** Example: `POST /quote/{code}/approve` validates the phone in the request body matches the quote's phone.
4. **Rate limit all public write endpoints** (20-30 requests/IP/min via KV counter with 60s TTL).
5. **Test in incognito** before declaring a public page "done."

---

## Known Deferred Scoped Endpoints (TODO)

These customer-facing operations currently fail silently because they haven't been given scoped endpoints yet:

| Feature | Broken call | Status |
|---------|-------------|--------|
| Sealing/rust interest (agreement.html) | `GET+PUT /customers` | Silenced — `TODO: POST /customer/{phone}/interest` |
| View tracking (quote.html) | `GET+PUT /customers` | Silenced — `TODO: POST /customer/{phone}/mark-viewed` |
| ~~Review count display (receipt.html)~~ | ~~`GET /reviews`~~ | **RESOLVED (2026-06-11):** `/reviews` is public; new `/public/review-count` lives alongside it for new pages. Receipt + legacy quote continue to use `/reviews` (still public). |

---

## Incident Log

| Date | Incident | Root cause | Fix |
|------|----------|-----------|-----|
| 2026-05-08 | Customer quote page broken after auth deploy | `q.html` called `GET /links` (not in isPublic); `customer_quote.html` called `GET+PUT /customers` (admin-scoped) | Added `GET /links` to isPublic; new `POST /quote/{code}/approve` scoped endpoint; reschedule → `POST /incoming` |
| 2026-05-08 | `agreement.html` + `receipt.html` broken after auth deploy | Both called `GET /customers` on page load | New `GET /customer/{phone}` scoped public endpoint |
