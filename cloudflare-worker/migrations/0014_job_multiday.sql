-- Migration 0014: Multi-day job support columns
-- Adds schema for linking daily Job rows into a multi-day set.
-- All columns are nullable with safe defaults — purely additive.
-- No existing column changes. No data migration. No behavior change.
--
-- Data model:
--   Standalone job  → all five columns null / 0 (default)
--   Parent job      → isMultiDayParent=1, totalDays=N, dayNumber=1, parentJobId=NULL
--   Child day 2     → parentJobId=<parent's jobId>, dayNumber=2, totalDays=N, dayPhase='...'
--   Child day 3     → parentJobId=<parent's jobId>, dayNumber=3, totalDays=N, dayPhase='...'
--
-- parentJobId is NULL on the parent itself and on standalone jobs.
-- Children point at the parent's jobId (not at each other).

ALTER TABLE Job ADD COLUMN parentJobId       TEXT    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN dayNumber         INTEGER DEFAULT NULL;
ALTER TABLE Job ADD COLUMN totalDays         INTEGER DEFAULT NULL;
ALTER TABLE Job ADD COLUMN dayPhase          TEXT    DEFAULT NULL;
ALTER TABLE Job ADD COLUMN isMultiDayParent  INTEGER DEFAULT 0;
