-- 0036_job_name_display.sql
-- Per-job toggle for which name is PRIMARY on partner-referral jobs.
-- 'partner' (or NULL) = partner/business name primary (default, unchanged behavior).
-- 'customer'          = end-customer name primary, partner secondary.
-- NULL is treated as 'partner' by the read surfaces → no backfill needed.
ALTER TABLE Job ADD COLUMN nameDisplay TEXT;
