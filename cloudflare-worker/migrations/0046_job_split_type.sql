-- Migration 0046: Job.splitType — separate MULTI-DAY from MULTI-RIG.
--
-- Both real situations route through the same parentJobId tree today, and the
-- day fields are overloaded on rig splits:
--
--                     multi-DAY            multi-RIG (same date)
--   dayNumber         which day            which RIG
--   totalDays         number of days       number of RIGS
--   isMultiDayParent  1 on parent          ALSO 1 on parent
--   isRigSegment      0                    1  <- the only real discriminator
--   child date        differs per day      same as parent
--   child amount      split share          $0 attribution marker
--
-- So "totalDays: 3" on Nelson Faguaga means THREE TRUCKS ON ONE DAY, not three
-- days. splitType makes that explicit without reinterpreting or rewriting the
-- existing columns — nothing is collapsed, no history is erased.
--
-- Values: 'day' | 'rig'. NULL means a plain single job.

ALTER TABLE Job ADD COLUMN splitType TEXT
  CHECK(splitType IN ('day','rig') OR splitType IS NULL);

-- Backfill: a family containing ANY isRigSegment row is a rig split; every
-- other parent/child family is a day split. Applied to parents and children so
-- either row answers the question on its own.
UPDATE Job SET splitType = 'rig'
 WHERE isRigSegment = 1
    OR jobId IN (SELECT DISTINCT parentJobId FROM Job WHERE isRigSegment = 1 AND parentJobId IS NOT NULL);

UPDATE Job SET splitType = 'day'
 WHERE splitType IS NULL
   AND (parentJobId IS NOT NULL OR isMultiDayParent = 1);

CREATE INDEX IF NOT EXISTS idx_job_splittype ON Job(splitType);
