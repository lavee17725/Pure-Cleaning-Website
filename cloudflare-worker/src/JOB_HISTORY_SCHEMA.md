# Job History Schema — Current State + ML Target

> Audit date: 2026-05-08  
> Purpose: Document every field written to `jobHistory[]` today, identify ML feature gaps,
> and lay out the migration plan for the day route timeline + pricing ML pipeline.

---

## 1. How `jobHistory[]` Gets Populated

There are three write paths. Each produces a different shape.

### Path A — `calendar_completion` (src: `_doCompleteJob` in `calendar.html`)

Triggered when Tyler marks a job complete through the calendar UI.

```js
{
  jobId:        '9543891234_2026-05-08_45000_cal3x9kf2a',  // phone_date_cents_calBase36
  date:         '2026-05-08',     // isoToday() at time of completion
  services:     'Roof / Driveway / Entranceway',  // free-text from ss.jobNotes
  amount:       450,              // ss.approvedAmount
  rig:          'rig_1',          // ss.rig (intended assignment, may differ from GPS truth)
  city:         'Weston',
  address:      '1255 Fairfax Court',
  status:       'completed',
  completedAt:  '2026-05-08T19:23:11.000Z',   // ISO timestamp of operator click
  crew:         ['cm_tyler', 'cm_sissy'],      // ss.crew[] IDs — empty array if unset
  source:       'calendar_completion',
  // Only present if paid at completion:
  payment:      'Zelle',
  paymentMethod:'Zelle',
  paidAt:       '2026-05-08T19:23:11.000Z',
}
```

**Idempotency guard:** Won't push if `(j.date === completedDate && j.source === 'calendar_completion')` already exists.

### Path B — Bouncie GPS matcher writes INTO Path A entries (src: `bouncieJobDurationMatcher` in `index.js`)

Runs nightly at 3 AM UTC (or manually via `/api/bouncie/match?date=`). Finds the Path A entry
for the date and `Object.assign`s these fields into it:

```js
// High-confidence match (< 250 ft, only one rig present):
{
  actualArrival:      '2026-05-08T14:18:37.000Z',  // trip.endTime (rig parked at job)
  actualDeparture:    '2026-05-08T16:33:49.000Z',  // next trip.startTime (rig left job)
  actualDuration:     135,          // minutes on site (departure - arrival)
  durationSource:     'bouncie_gps',
  durationConfidence: 'matched_high',  // or 'matched_medium' (250–500 ft)
  autoAttributed:     true,
  actualRig:          'rig_1',      // GPS truth (only on high-confidence)
  intentRig:          null,         // original ss.rig if it differed; undefined if same
  rigsPresent:        undefined,    // array if multiple rigs within threshold
}
```

**If no `jobHistory` entry exists for the date**, the timing data is written to `scheduledStatus` instead.

### Path C — `csv_backfill` (src: one-time CSV import script, May 2026)

Historical jobs loaded from `2026_Master_Full.csv`. Each entry has:

```js
{
  jobId:          '9543891234_2026-05-04_45000_csv',
  date:           '2026-05-04',
  services:       'Roof 1 story / Rinse Walls / Driveway / Sidewalk / Entranceway',
  amount:         450,
  city:           'Weston',
  address:        '1255 Fairfax Court',
  sqFt:           3133,        // FROM CSV — only available on backfill entries
  payment:        'zelle',
  paymentMethod:  'zelle',
  batchLabel:     '2026_May_Cleaned',
  csvFile:        '2026_Master_Full.csv',
  importedAt:     '2026-05-06T03:15:01.725Z',
  status:         'completed',
  completedAt:    null,        // ALWAYS null — real timestamp not available from CSV
  source:         'csv_backfill',
  // Some entries also have GPS data if import-time Bouncie matching succeeded:
  actualArrival:      '...',
  actualDeparture:    '...',
  actualDuration:     135,
  actualRig:          'rig_1',
  intentRig:          null,
  autoAttributed:     true,
  durationConfidence: 'matched_high',
  durationSource:     'bouncie_gps',
}
```

---

## 2. Morning Stop Data (currently separate, not in jobHistory)

The Bouncie matcher also captures pre-job stop data per rig per day,
stored separately in `bouncie:morning_stops:{date}` KV key (90-day TTL).

**NOT linked to individual job entries.** This is the primary gap for day route reconstruction.

```js
// bouncie:morning_stops:2026-05-08
{
  date: '2026-05-08',
  morningStops: {
    rig_1: {
      gas: {
        found:       true,
        label:       '7-Eleven',
        emoji:       '⛽',
        arrivedAt:   '2026-05-08T10:45:00.000Z',
        departedAt:  '2026-05-08T10:51:00.000Z',
        durationMin: 6,
      },
      chlorine: {
        found:       true,
        label:       'Pro-Line',
        emoji:       '🧪',
        arrivedAt:   '2026-05-08T11:05:00.000Z',
        departedAt:  '2026-05-08T11:15:00.000Z',
        durationMin: 10,
      },
    },
    rig_2: { gas: { found: false, ... }, chlorine: { found: false, ... } },
  },
  updatedAt: '2026-05-08T03:07:44.000Z',
}
```

Running averages per POI are in `bouncie:poi_stats:{key}` (`{ count, totalMin, avgMin }`).

**⚠️ Two coordinate TODOs in `index.js` lines 2092, 2101:**  
The 7-Eleven and Pro-Line coordinates are approximate placeholders — need field verification.

---

## 3. ML Feature Gap Analysis

What the pricing/duration ML needs vs what exists today:

| Feature | Source | Status |
|---------|--------|--------|
| `date` | jobHistory.date | ✅ always present |
| `services` free-text | jobHistory.services | ✅ present — needs parsing |
| `amount` | jobHistory.amount | ✅ always present |
| `actualDuration` (minutes) | Bouncie GPS matcher | ✅ ~30% coverage (GPS-matched jobs) |
| `actualArrival` / `actualDeparture` | Bouncie GPS matcher | ✅ ~30% coverage |
| `durationConfidence` | Bouncie GPS matcher | ✅ on matched entries |
| `rig` / `actualRig` | calendar + Bouncie | ✅ present |
| `crew` IDs | calendar_completion | ✅ captured as array of IDs |
| `city` / `address` | calendar_completion | ✅ always present |
| `paymentMethod` | calendar + backfill | ✅ when paid |
| `sqFt` | **CSV backfill only** | ⚠️ ~40% of records (backfill entries) — **not captured on new jobs** |
| `crewSize` (count) | derivable from `crew[]` | ⚠️ crew.length, not stored explicitly |
| `propertyType` | **nowhere** | ❌ not captured at all |
| `roofStories` | quote notes (free text) | ❌ not structured |
| `weatherConditions` | `/api/weather` endpoint exists | ❌ not written to jobHistory |
| `dayOfWeek` | derivable from `date` | ⚠️ not stored, but trivially computed |
| `month` / `season` | derivable from `date` | ⚠️ not stored, but trivially computed |
| `isRepeatCustomer` | customer.totalJobs | ⚠️ not embedded in jh entry |
| `jobNumberForCustomer` | customer.jobHistory index | ⚠️ not embedded in jh entry |
| `customerTier` | computed from jobHistory | ⚠️ not embedded in jh entry |
| `driveTimeToJob` | Bouncie trips | ❌ home→job leg not captured per-job |
| `gasStopDurationMin` | bouncie:morning_stops | ❌ not linked to job entries |
| `chlorineStopDurationMin` | bouncie:morning_stops | ❌ not linked to job entries |
| `geocodedLat` / `geocodedLon` | geocoder (ephemeral) | ⚠️ used in GPS matching, not stored in jh |

---

## 4. Target Schema — `calendar_completion` jobHistory Entry

What `_doCompleteJob` should write once all gaps are filled:

```js
{
  // ── Core (already present) ──────────────────────────────
  jobId:         '...',
  date:          'YYYY-MM-DD',
  services:      'free text',
  amount:        450,
  rig:           'rig_1',
  city:          'Weston',
  address:       '1255 Fairfax Court',
  status:        'completed',
  completedAt:   '...',
  crew:          ['cm_tyler', 'cm_sissy'],
  source:        'calendar_completion',

  // ── GPS timing (written by Bouncie cron — already present when matched) ──
  actualArrival:      '...',
  actualDeparture:    '...',
  actualDuration:     135,
  durationSource:     'bouncie_gps',
  durationConfidence: 'matched_high',
  actualRig:          'rig_1',
  autoAttributed:     true,

  // ── Property data (NEEDS CAPTURE) ───────────────────────
  sqFt:          3133,          // from customer record (if available) or quote data
  propertyType:  'single_family', // 'single_family' | 'townhouse' | 'condo' | 'commercial'
  geocodedLat:   26.0852,       // persist so GPS matching can skip geocoding next time
  geocodedLon:   -80.3740,

  // ── Derived ML context (NEEDS CAPTURE — easy to add at completion time) ─
  crewSize:           2,          // crew.length
  jobNumberForCustomer: 7,        // 1 = first ever job, N = Nth job for this customer
  isRepeatCustomer:   true,       // jobNumberForCustomer > 1
  customerTier:       'HOT',      // from getEffectiveStats() at completion time

  // ── Day route context (NEEDS LINKING from morning_stops) ────────────────
  dayMorningStops: {              // snapshot from bouncie:morning_stops:{date} for this rig
    gas:      { found: true,  durationMin: 6,  arrivedAt: '...', departedAt: '...' },
    chlorine: { found: true,  durationMin: 10, arrivedAt: '...', departedAt: '...' },
  },
  driveTimeToJobMin: 18,          // minutes from home (or last job) to this job — needs route math

  // ── Weather (NEEDS CAPTURE — api/weather exists) ─────────────────────────
  weather: {
    tempF:       82,
    humidity:    78,
    conditions:  'Partly Cloudy',
    windMph:     8,
  },
}
```

---

## 5. Migration Plan

### Tier 1 — Zero infrastructure, add at completion time (30 min, do first)

These are derivable at the moment `_doCompleteJob` runs. No new endpoints or data sources needed.

| Field | Where to get it | Change required |
|-------|-----------------|-----------------|
| `crewSize` | `crew.length` | 1 line in `_doCompleteJob` |
| `jobNumberForCustomer` | `(c.jobHistory\|\|[]).filter(j=>j.status==='completed').length + 1` | 1 line |
| `isRepeatCustomer` | `jobNumberForCustomer > 1` | 1 line |
| `customerTier` | call `getTier(c)` or `getEffectiveStats(c).tier` | 1 line |
| `geocodedLat/Lon` | already geocoded in Bouncie matcher — persist it back to jh entry | write in Bouncie cron |
| `sqFt` | `c.sqFt` (already on some customer records from backfill) | 1 line |

### Tier 2 — Link morning stops to job entries (1–2 hours, do Sunday)

After Bouncie cron runs, it has `morningStops[rig]` in memory. Add a step to write
`dayMorningStops` into each job's jh entry for that rig and date.

Location: `bouncieJobDurationMatcher` in `index.js`, after the `timingData` Object.assign.

```js
// After writing timingData into jhEntry:
if (morningStops[bestRig]) {
  jhEntry.dayMorningStops = morningStops[bestRig];
}
```

This retroactively links the morning stop data (currently lost in a per-day KV key)
to the specific job entries where it matters.

### Tier 3 — Property type capture (30 min, do Sunday)

Add `propertyType` dropdown to the quote form (or customer profile edit). Store it on the customer
record. Read it at completion time (`c.propertyType`).

Values: `'single_family'` | `'townhouse'` | `'condo'` | `'commercial'`

### Tier 4 — Weather at completion (45 min)

The worker already has `/api/weather`. At Bouncie match time, call it and snapshot
`{ tempF, humidity, conditions, windMph }` into the job entry. Weather is a known
pricing factor (clients reschedule rainy days; heat affects soft wash dilution).

### Tier 5 — Drive time per job (2–3 hours, later)

Requires reconstructing the full day route from Bouncie trips:
`home → gas → chlorine → job1 → job2 → ... → home`

The drive time between segments is `next_trip.startTime - prev_trip.endTime` for each leg.
This is Phase C (Day Route View). The foundation is the trip data already in `rigTripsMap`.

### Tier 6 — Service type structured array (1 hour)

`services` is currently free text (`'Roof / Driveway / Entranceway'`).
Target: structured array `['roof_cleaning', 'driveway', 'entranceway']` using a parser.

Already partially done — quote form has structured service checkboxes. At completion time,
`ss.services[]` could be captured. Needs a canonical service ID → label mapping.

---

## 6. Day Route Vision (Phase C UI)

The `bouncie:morning_stops:{date}` data plus per-job `actualArrival/actualDeparture`
already contains everything needed to reconstruct the full day:

```
LEAVE HOME  16621 SW 62nd St            ~6:45 AM  (first trip start time)
  ↓  18 min drive
⛽  7-ELEVEN gas stop                   ~7:03 AM  arrivedAt / departedAt (6 min)
  ↓  8 min drive
🧪  PRO-LINE chlorine                   ~7:17 AM  arrivedAt / departedAt (10 min)
  ↓  22 min drive
🟢  JOB 1 — Maria Correnti             ~7:51 AM  actualArrival
    1255 Fairfax Ct, Weston
    Roof / Driveway / Entranceway — $450
    GPS: arrived 7:51, departed 10:23  (2h 32m)          ← actualDuration
    ⚠️ chlorine stop was 10 min (norm: 8 min) — +2 min
  ↓  12 min drive
🟢  JOB 2 — …                          ~10:35 AM
  …
🏠  RETURN HOME                        ~3:45 PM
    Total day: 9h 00m  (productive: 5h 15m  /  drive: 1h 45m  /  stops: 1h 00m)
```

**Anomaly detection candidates:**
- Gas stop > 15 min (norm: ~5–8 min)
- Chlorine stop > 20 min (norm: ~8–10 min)
- Idle time between jobs > 30 min (neither driving nor on-site)
- Job took > 2× historical average for that service + sqFt combination

**Implementation path:**
- New page: `public/pure_cleaning_day_route.html`
- API: `GET /admin/day-route?date=YYYY-MM-DD&rig=rig_1`
  - Returns: `{ homeDepart, stops: [{type, label, lat, lon, arrivedAt, departedAt, durationMin, anomaly}], jobs: [...], homeReturn, summary }`
- Data sources: `bouncie:morning_stops:{date}` + customer jobHistory for that date

---

## 7. Current Data Coverage (as of 2026-05-08)

| Metric | Count |
|--------|-------|
| Total customers | 1,246 |
| Customers with jobHistory | ~1,246 (most have ≥1 entry from backfill) |
| jobHistory entries total | ~1,819 (from backfill) + growing |
| Entries with GPS data (`actualDuration > 0`) | ~300 estimated (backfill + cron) |
| Entries with `sqFt` | ~600 estimated (from CSV backfill) |
| Entries with `crew[]` | Growing — new since calendar_completion added crew capture |

**500 GPS-matched job entries** is the rough threshold for a meaningful duration-prediction model.
At current pace (1–5 jobs/day), GPS matching will accumulate ~500 entries within ~12 months of
new completions — or sooner if backfill historical Bouncie data is available.
