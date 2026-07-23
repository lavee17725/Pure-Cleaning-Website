-- Migration 0037: Follow-Up Reminders v2 — day-level timing + lead time.
-- ADDITIVE only. Builds on 0025 (Reminder table) + 0027 (cadenceMonths recurrence).
--   targetDay  — 1..31 (nullable). NULL = whole-month (surface on the 1st, unchanged).
--   leadDays   — surface the reminder N days BEFORE the target date (default 5).
--   nextFireAt — 'YYYY-MM-DD' computed surface date the bell compares against.
-- Backfill: existing rows have no targetDay → nextFireAt = 1st of followUpMonth,
-- which preserves today's exact surfacing (month-granular). Zero loss.
-- Snapshot: customer_db_backup_2026-07-14T01-08-25 taken before this ran.
ALTER TABLE Reminder ADD COLUMN targetDay  INTEGER;
ALTER TABLE Reminder ADD COLUMN leadDays   INTEGER DEFAULT 5;
ALTER TABLE Reminder ADD COLUMN nextFireAt TEXT;
UPDATE Reminder SET nextFireAt = followUpMonth || '-01' WHERE nextFireAt IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminder_active_fire ON Reminder(status, nextFireAt);
