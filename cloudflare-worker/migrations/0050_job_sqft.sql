-- 0050: Job.sqFt — the per-job square footage that migration lost
--
-- Tyler recorded roof square footage on essentially every roof job since
-- inception. The Day-1 KV→D1 loader (scripts/migration_skeleton.py:1064)
-- hardcoded `"sqft": None` on Property and no sqft column was ever created on
-- Job, so the per-job value had nowhere to land. The KV blob is rebuilt FROM
-- D1, so the first rebuild after migration overwrote the originals with nulls
-- and the loss was invisible for three months (DL-09 — decision-driving state
-- read from a store that never received it).
--
-- 340 values survive in customer_db_backup_2026-05-08T23-52-12, a KV snapshot
-- taken 12 days before the migration. 337 resolve to jobs still in D1.
--
-- WHY BOTH Job.sqFt AND Property.sqft (Tyler's call, option c):
--   Job.sqFt      — historical truth. What the roof measured when THAT job was
--                   done. Never overwritten by a later measurement.
--   Property.sqft — the current default for quoting repeat work, set from the
--                   most recent job's value.
-- A property whose readings disagree keeps every reading on its jobs; only the
-- Property default has to choose.

ALTER TABLE Job ADD COLUMN sqFt INTEGER;

CREATE INDEX IF NOT EXISTS idx_job_sqft ON Job(sqFt) WHERE sqFt IS NOT NULL;
