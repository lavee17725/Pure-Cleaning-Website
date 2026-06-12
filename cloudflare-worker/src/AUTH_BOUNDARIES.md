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
- `GET /admin/drive-time?from=lat,lng&to=lat,lng` — Google Directions API proxy; KV-cached 7d; falls back to haversine; returns { duration_minutes, distance_miles, source: 'google'|'cache'|'haversine_fallback' }
- `GET /admin/drive-time/stats` — cache hit rate, total API calls, estimated cost since reset
- `GET /admin/places/autocomplete?input=<text>&sessiontoken=<uuid>` — Google Places Autocomplete proxy; US+address-type only, South FL biased; session token for cost optimization
- `GET /admin/places/details?place_id=<id>&sessiontoken=<uuid>` — Google Places Details proxy; KV cached 30d; returns parsed street/city/state/zip + lat/lng
- `POST /admin/properties/canonicalize-all` — historical migration: fetches place_id for all Property rows via Find Place API, then runs dedup pass; body: { phase: 'canonicalize'|'dedup'|'both', batchSize?, reset? }; Tyler-triggered only, not auto-scheduled
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
