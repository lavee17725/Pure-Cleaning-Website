# Pure Cleaning — Business Truths

> **Companion to CLAUDE.md** — that file holds laws about the *code*, this one
> holds truths about the *business*, for any Claude working without this repo.
>
> **Tyler is the source of truth, not the data.** Where they disagree, Tyler
> wins and this file records his version.

---

## WHEN TO APPEND TO THIS FILE

**Append automatically, without asking**, whenever any of these happen:

- Tyler **corrects a factual assumption** about his business.
- Tyler **explains how something actually works** and it isn't already here.
- An assumption about **standard pressure-washing practice** turns out not to
  match how Tyler operates.
- A diagnosis reveals an **operational reality the data alone wouldn't show** —
  multi-rig same-day, comped jobs, parked work and payment-as-receivables were
  every one of them learned this way.
- **A number that matters changes materially.**

Write it **in his words** where possible, with the date. Don't wait to be asked
and **don't ask permission for a factual correction** — add it, then mention it
in the ship report. Tyler can strike anything he disagrees with.

> **The test:** if Tyler had to explain it more than once, it belonged here
> after the first time.

---

## 1. The business

**Pure Cleaning Pressure Cleaning, LLC.** Family-owned, founded **1995** by
**Tony and Darla**. Tyler runs it now. South Florida — Broward and north
Miami-Dade (Davie, Weston, Pembroke Pines, Cooper City, Plantation, Miramar,
Coral Springs, Pinecrest).

Residential pressure washing, roof cleaning (soft wash) and sealing.
**Windows are cleaned as part of wall/exterior work** — a normal service line,
not a favour *(2026-08-06)*.

| Who | Role |
|---|---|
| **Tyler** | Owner/operator — quoting, scheduling, systems |
| **Darla** | Office — invoicing, phones, booking |
| **Tony** | Field |
| **Byron, Jonathan, Danny, Yudani** | Crew |

Three trucks: **rig_1 (Old Tacoma), rig_2 (New Tacoma), rig_3 (Chevy)**.
**rig_3 is the exclusive soft-wash rig** and takes the big projects, often with
Tony. Its higher revenue/hour is **job mix, not crew performance** — never read
per-rig rates as a crew ranking *(2026-08-06)*.

**This is a residential company.** Commercial and partner work is real and
valuable, but it arrives through relationships — property managers who already
call — not outbound sales.

### Where Tyler is trying to get to

Judge proposals against these.

- **$1M+ annual revenue** — 2025 was $357k, so this is a multiple, not a trim.
- **Near-term: $800–1,000 per truck per day, starting September.** Three trucks.
  This is the operating target that makes the annual number reachable.
- **Sealing attach rate is the largest untapped lever** — roughly **2.5%**
  today, big upside. Sealing is weather-gated (§3), so the constraint is
  *scheduling and offer*, not demand.

---

## 2. How work actually happens

Realities that repeatedly surprise anyone reading the data cold:

- **Multi-rig same day** — one job, 2–3 trucks, **one date**. Different from a
  multi-day job; both route through `parentJobId`. Read `splitType` — never
  assume `totalDays` means days.
- **Comped jobs** — real work done free to reciprocate a relationship. **Not a
  missing price.** `priceMode='comped'` with a required reason.
- **Parked jobs** — real booked work with **no knowable date** (construction,
  rain). Dateless by design; lives in the calendar's left rail, $0 to every
  day.
- **Completion ≠ payment.** Completion means the work happened. Payment is
  tracked separately. **Green on the calendar = completed AND paid.** Unpaid is
  an explicit claim, never inferred.
- **Price TBD** — trusted customers get priced after the work is done.
- **Customer texts go from Tyler's or Darla's own phone** via `sms:` links. The
  system has **never** sent a customer message and must not. **Pushover is the
  only system→Tyler channel** (CLAUDE.md Rule 27).

---

## 3. Seasonality — read every summer number against this

- **Winter is busy season. August is normally the slowest month.**
- **Sealing is weather-gated** and gets pushed — often to October.
- **Summer reactivation underperforms structurally.** Customers are out of town
  and say *"call me in November."* A weak summer campaign is not a broken one.

Never compare a summer month to an annual average and call it a decline.

---

## 4. Key relationships and accounts

Relationships, not accounts — most came from someone vouching for Tyler.

- **Premier Association Management** (Glen, University Parc) — largest partner
  relationship, reached through **Hardev Mattu**, a property manager whose own
  house is cleaned **free** as reciprocity. Hardev's $0 jobs are intentional —
  never flag them as missing prices.
- **Harts Painting** — painting partner, refers work.
- **Carlos — Pro Built** — contractor partner.
- **Nelson Faguaga** — partner referral source.
- **Jose Contractor** — contractor partner. 4 completed jobs, $2,500
  *(2026-08-07)*. Dropped from this list on 2026-08-06 as unpinnable and
  restored once the data confirmed the record — the name in the CRM is
  literally "Jose Contractor".
- **Ashley Wheeler** — monthly recurring. **Agreed rate $600/mo, not $750** —
  $750 was one-off/long-gap pricing and must not be quoted to her again. Also
  manages a rental.
- **Keith Wolf** — first organic (non-referral) customer. Protected record;
  don't merge, retire or clean him up. **He predates the CRM — his record holds
  only his most recent job.** Do not read one $375 job as his whole history
  with the company.

Largest commercial accounts by revenue *(2026-08-06)*: OLA Condominium
Association, T&G Management (Racquet Club), Villas at the Gate, Benco (Davie
Square), United Team Group, Sabal Palm.

---

## 5. Numbers that matter

**Every number carries the date it was true. They age — re-check before use.**

*As of 2026-08-06:*

| | |
|---|---|
| People / properties / jobs | 1,359 / 1,538 / 2,180 |
| Completed jobs (all time) | 2,143 |
| Average ticket (all, excl. comped) | **$422** |
| Average ticket — residential | **$370** |
| Average ticket — partner referral | **$584** |
| Average ticket — commercial | **$1,720** |
| Partners / commercial accounts | 16 / 22 |
| Google reviews | **139** (5.0★) |
| Revenue 2024 / 2025 / 2026-YTD | $294,674 / $357,415 / $188,906 |

**Only ~3 months of rich CRM data exists** (reliable from **May 2026**);
earlier months are CSV backfill that under-captures. Those three months are also
**slow season**. Do not extrapolate an annual trend from them.

**Quote pool** logs 41 accepted / 1 declined / 1 open *(2026-08-06)* — that is
**not a 95% acceptance rate**. Accepted quotes get logged more consistently than
declines. It's a record of won work, not a conversion metric, until logging
evens out.

---

## 6. What the data CAN'T tell you yet

The most common failure with this dataset is over-reading it. If an answer
depends on one of these blind spots, say so instead of estimating.

- **Profitability is uncomputable.** No chlorine, gas or labor cost tracking.
  Revenue is known; margin is not. Any "profit" figure would be invented.
- **Square footage covers ~20% of jobs** (334 jobs / 387 properties), recovered
  **2026-08-06** from a pre-migration snapshot after the D1 migration nulled it.
  Good for analysis on the covered set, not for portfolio-wide claims.
  **Historical sqft is not lost** — it can be backfilled from satellite once the
  measurement calibration set is finished. That work is **deliberately paused**
  until Tyler is back from his trip (returns **Sept 6, 2026**).
- **No campaign→booking attribution.** Nothing links a text to the job it
  produced, so reactivation conversion is a **floor, not a real rate** —
  campaign-driven bookings look organic.
- **Bouncie duration coverage is partial** — durations exist for some jobs, not
  all, so crew-efficiency conclusions are partial by construction.
- **Year-over-year is not like-for-like until 2027.** 2024–25 are spreadsheet
  backfill; May 2026 forward is CRM-recorded. Comparing them compares two
  collection methods, not two years of business.

---

## 7. Corrections — do not re-litigate

Tyler has already settled these. Raising them again as new ideas is the exact
problem this file exists to stop.

- **Commercial outreach is NOT the growth priority.** The company is
  residential-heavy by choice. Property managers already call. Commercial is
  opportunistic, not a strategy to build.
- **The React SPA in `src/` is dead.** `public/*.html` is the live site. Edit
  the HTML.
- **Twilio is abandoned** — the account never cleared A2P verification. Pushover
  only. Do not propose an SMS sender.
- **Prefilled quote links didn't convert.** Reactivation is now a short,
  friendly reminder — not a link-heavy pitch.
- **The geotag photo-matcher is dead.** Google Drive strips GPS from photos.
- **The GBP photo pipeline was removed.** Google deprecated the upload API.
- **Two-story roofs price lower than one-story, and that is correct.** A
  two-story roof footprint is ~13% smaller (median 2,640 vs 3,046 sq ft). It's
  geometry, not a bug. **The real gap is that there is no height premium** —
  $0.139/sq ft on two-story vs $0.143 on one-story, despite the added access and
  safety burden *(2026-08-06)*.

---

## 8. How Tyler works

- **Business intent, not technical specs.** Translate; don't make him decode.
- **One decision at a time.** Validate before moving on.
- **Diagnose before building.** Evidence first, then a fix.
- **Everything is a working theory** — his own assumptions included. He'll say
  when the data should override him.
- **He validates live.** A gate passing is not the same as him seeing it work.
- **Honest feedback over agreement.** If he's wrong, say so with evidence.

---

*A correction that only lives in a chat is one he'll have to make again.*
