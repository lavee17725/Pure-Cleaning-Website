-- Migration 0030: Cost Hub Phase 2 LABOR REVISION
--
-- Replaces the day-split labor model (each job got a share of the rig's day-pay
-- by hour fraction) with a STANDARD HOURLY RATE model:
--
--   standardHours = EDITABLE config, seasonal (summer 4.5 / winter 5)
--   hourly rate   = day-rate / standardHours
--                   default: $150 / 4.5 = $33.33/hr
--                   Jonathan: $160 / 4.5 = $35.56/hr
--                   half-day: $75 / 4.5  = $16.67/hr
--   per-job labor = job.onSiteHrs × Σ(assigned crew member's hourly rate)
--
-- The labor cost per job no longer depends on how many other jobs were on the
-- rig that day. Day-level UNDER/over-utilization surfaces as a new metric
-- idleCapacityCost(rig, date) = paid - standardCharged. NEVER on a job.
--
-- ADDITIVE ONLY — no existing column changed, no existing row mutated.
-- All cached JobProfit rows need recompute under the new model — exposed via
-- POST /admin/job-profit/recompute { all: true }.
--
-- Snapshot customer_db_backup_2026-06-19T03-52-28 taken before applying.
--
-- Date: 2026-06-19

-- ── LaborConfig ─────────────────────────────────────────────────────────────
-- One row per season. Tyler edits standardHours from the Costs hub. Day-rate
-- numbers live here too so a single source of truth governs labor cost — if
-- Jonathan gets a raise, change one row, recompute, done.
CREATE TABLE IF NOT EXISTS LaborConfig (
  season        TEXT PRIMARY KEY CHECK (season IN ('summer','winter')),
  standardHours REAL NOT NULL,                  -- billable on-site hours that the day-rate is "buying"
  dayRateDefault REAL NOT NULL DEFAULT 150,
  dayRateNamed  TEXT NOT NULL DEFAULT '{"jonathan":160}',  -- JSON map of lowercased name → day rate
  halfDayRate   REAL NOT NULL DEFAULT 75,
  notes         TEXT,
  updatedAt     TEXT NOT NULL
);

INSERT OR IGNORE INTO LaborConfig (season, standardHours, dayRateDefault, dayRateNamed, halfDayRate, notes, updatedAt) VALUES
  ('summer', 4.5, 150, '{"jonathan":160}', 75, 'Apr–Oct: shorter on-site days due to heat/sun', '2026-06-19'),
  ('winter', 5.0, 150, '{"jonathan":160}', 75, 'Nov–Mar: cooler weather extends productive hours', '2026-06-19');

-- ── JobProfit.season ────────────────────────────────────────────────────────
-- Season is derived from scheduledDate at compute time. Tagging the cache lets
-- weekly/monthly reports filter by season + lets the recompute path know which
-- rows the old labor model touched.
ALTER TABLE JobProfit ADD COLUMN season TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_jobprofit_season ON JobProfit(season);
