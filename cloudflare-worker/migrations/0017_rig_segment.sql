-- Migration 0017: isRigSegment column for multi-rig job segments (Layer 3)
--
-- Marks a Job row as a rig-segment unit: same-date children with different rigIds,
-- all sharing a common parent (parentJobId IS NOT NULL, parentJobId.rigId IS NULL).
--
-- Rig-segment children are:
--   - Excluded from customer-facing records (jobHistory, lifetimeSpend) — parent is book of record
--   - Excluded from _d1BuildScheduledStatus selection — parent holds the full amount
--   - Matched to GPS by constraining to job.rigId only (Layer 4 — NOT YET BUILT)
--
-- Layer 4 NOTE: Bouncie time-attribution for rig-segments is NOT yet correct.
-- The current matcher scans all rigs per job and picks the best. For rig-segments
-- at the same address on the same day, all rows get the same rig's GPS time.
-- Fix: when isRigSegment=1, constrain GPS search to job.rigId only. Layer 4, separate session.
--
-- Hybrid multi-day × multi-rig is NOT built. Flat rig-group only.

ALTER TABLE Job ADD COLUMN isRigSegment INTEGER DEFAULT 0;
