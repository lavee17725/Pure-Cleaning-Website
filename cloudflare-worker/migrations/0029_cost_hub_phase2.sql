-- Migration 0029: Cost Hub Phase 2 — allocation engine schema
--
-- Adds the four schema pieces the Phase-2 per-job profit computation needs:
--
--   1. JobProfit — single-row-per-job cache of the 6-way breakdown so the
--      calendar/profile chip is a one-key read, not a recompute. Recomputed
--      whenever any input (gas/chlorine/sealer/sand/equipment/labor/fixed)
--      that touches the job changes.
--
--   2. JobChlorineAllocation — Tyler's MANUAL per-job gallons split for a
--      given chlorine CostEntry. (Same rig+day chlorine fill gets split N
--      ways across the rig's jobs that day.) System will learn gallons-per-
--      service from his corrections in Phase 3, but Phase 2 captures the
--      ground truth he types.
--
--   3. Equipment.estimatedLifetimeHours — wear rate denominator. Seeded
--      manually (purchase-year expectation × annual active hours from
--      Bouncie). On status=broken, worker trues-up to actual install→break
--      Bouncie active hours on the rig and recomputes rate forward.
--
--   4. Job.halfDayCrew — flag (1=half-day) for the rare half-day labor
--      scenario. When set on ANY job in a (rig, date) tuple, labor for that
--      whole rig+day uses half-day rates ($75/person instead of $150/$160).
--
-- ADDITIVE ONLY — no existing column changed, no existing row mutated.
-- Snapshot customer_db_backup_2026-06-19T01-49-51 taken before applying.
--
-- Date: 2026-06-19

-- ── JobProfit cache ─────────────────────────────────────────────────────────
-- One row per completed job (allocation engine writes; reads serve the chip).
-- `partial=1` AND `missing` (JSON array of input names) flag honest-on-incomplete
-- — Phase-1 chips never lie about precision.
CREATE TABLE IF NOT EXISTS JobProfit (
  jobId             TEXT PRIMARY KEY,
  revenue           REAL NOT NULL,
  laborCost         REAL NOT NULL DEFAULT 0,
  gasCost           REAL NOT NULL DEFAULT 0,
  chlorineCost     REAL NOT NULL DEFAULT 0,
  sealMaterialCost  REAL NOT NULL DEFAULT 0,
  equipmentCost     REAL NOT NULL DEFAULT 0,
  fixedCost         REAL NOT NULL DEFAULT 0,
  netProfit         REAL NOT NULL,
  margin            REAL,                       -- nullable when revenue=0
  partial           INTEGER NOT NULL DEFAULT 0, -- 1 if any input was unknown/missing
  missing           TEXT,                       -- JSON array of missing-input names
  computedAt        TEXT NOT NULL,
  FOREIGN KEY (jobId) REFERENCES Job(jobId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobprofit_partial    ON JobProfit(partial);
CREATE INDEX IF NOT EXISTS idx_jobprofit_computedAt ON JobProfit(computedAt);

-- ── JobChlorineAllocation ──────────────────────────────────────────────────
-- A given chlorine CostEntry (a fill, e.g. 30 gal on rig1, 2026-06-18) gets
-- split N ways across the rig's jobs that day. Tyler types gallons into each
-- job row in the new UI — system learns gallons-per-service from his correc-
-- tions in Phase 3.
CREATE TABLE IF NOT EXISTS JobChlorineAllocation (
  jobId       TEXT NOT NULL,
  costEntryId TEXT NOT NULL,
  gallons     REAL NOT NULL,                    -- Tyler's manual split (gallons)
  createdAt   TEXT NOT NULL,
  modifiedAt  TEXT NOT NULL,
  PRIMARY KEY (jobId, costEntryId),
  FOREIGN KEY (jobId)       REFERENCES Job(jobId)        ON DELETE CASCADE,
  FOREIGN KEY (costEntryId) REFERENCES CostEntry(costEntryId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jca_costentry ON JobChlorineAllocation(costEntryId);

-- ── Equipment.estimatedLifetimeHours ───────────────────────────────────────
-- The wear-rate denominator. Manually seeded; trued up at status=broken.
-- NULL = "we don't know yet" → equipment cost for this job marked partial.
ALTER TABLE Equipment ADD COLUMN estimatedLifetimeHours REAL DEFAULT NULL;

-- ── Job.halfDayCrew ─────────────────────────────────────────────────────────
-- 1 = half-day labor for this (rig, date). 0/null = full-day (default).
-- Tyler sets it on any one job for the day; allocation engine treats the
-- entire (rig, date) tuple as half-day for labor purposes.
ALTER TABLE Job ADD COLUMN halfDayCrew INTEGER DEFAULT 0;
