-- Migration 0015: Per-job outcome fields + cost-ready structure for net margin
--
-- OUTCOME (populate now via PATCH /admin/job/:id):
--   tipped / tipAmount       -- post-job tip recording
--   complained / complaintNotes  -- replaces localStorage/KV complaint path
--
-- COST-READY (structure now; populate as expense tracking + Bouncie mature):
--   gasCost       -- drive-in fuel allocation; derivable from milesFromPreviousJob x rate
--   chemicalCost  -- chlorine + chemicals allocated to this job
--   laborCost     -- crewCount x actualDuration x hourly rate (compute or manual override)
--   equipmentCost -- wear/amortization per job
--   otherCost     -- catch-all for supplies, permits, misc
--
-- netMargin is NOT stored -- computed at read/export time as amount - sum(non-null costs).
-- null = "not yet captured"; never coerced to $0. Margin stays null until at least one
-- cost field is known.
--
-- Note: milesFromPreviousJob and drivetimeFromPreviousJob already exist on Job (initial
-- schema) but were never added to _JOB_MUTABLE_FIELDS. Added to the whitelist in this
-- release so Bouncie backfill and PATCH can populate them without a future schema change.
--
-- All columns DEFAULT NULL or DEFAULT 0 -- purely additive.
-- No existing rows modified. No index changes. No constraint changes.
-- Date: 2026-05-29

ALTER TABLE Job ADD COLUMN tipped           INTEGER DEFAULT 0;
ALTER TABLE Job ADD COLUMN tipAmount        REAL    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN complained       INTEGER DEFAULT 0;
ALTER TABLE Job ADD COLUMN complaintNotes   TEXT    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN gasCost          REAL    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN chemicalCost     REAL    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN laborCost        REAL    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN equipmentCost    REAL    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN otherCost        REAL    DEFAULT NULL;
