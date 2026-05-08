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
| `/receipt/{phone}/track` | PATCH | receipt.html | Tracks receipt open event |
| `/dates/suggest` | GET | quote form | Returns suggested available dates |
| `/service-frequency` | GET | quote form | Returns service frequency config |
| `/addons-config` | GET | quote form | Returns add-on options |

---

## Admin-Only Routes (require `Authorization: Bearer <token>`)

Any path **not** listed above requires a valid session token. Attempting access without auth returns 401.

Key protected resources:
- `GET /customers` — full customer DB (1,243 records)
- `PUT /customers` — replaces entire customer DB (destructive)
- `GET /incoming` — all quote requests
- `PUT /incoming` — replaces incoming list
- `GET /admin/*` — all admin endpoints (errors, backups, reviews, cron heartbeat)
- `GET /events` — audit/event log
- `PUT /agreement/{phone}/edit-services` — admin edits services
- `POST /agreement/{phone}/manual-confirm` — admin confirms
- `customer/{phone}/delete` and other action paths
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
| Review count display (receipt.html) | `GET /reviews` | Currently 401 — low priority (cosmetic badge) |

---

## Incident Log

| Date | Incident | Root cause | Fix |
|------|----------|-----------|-----|
| 2026-05-08 | Customer quote page broken after auth deploy | `q.html` called `GET /links` (not in isPublic); `customer_quote.html` called `GET+PUT /customers` (admin-scoped) | Added `GET /links` to isPublic; new `POST /quote/{code}/approve` scoped endpoint; reschedule → `POST /incoming` |
| 2026-05-08 | `agreement.html` + `receipt.html` broken after auth deploy | Both called `GET /customers` on page load | New `GET /customer/{phone}` scoped public endpoint |
