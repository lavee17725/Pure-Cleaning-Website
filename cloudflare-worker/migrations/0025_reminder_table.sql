-- Migration 0025: Reminder table — manual follow-ups + future reminder types
--
-- Powers the notification-bell follow-up flow:
--   - Mom/Tyler set "Set follow-up" on a customer profile (month granularity).
--   - At/after that month, the bell surfaces it as a typed FOLLOW-UP card with
--     a click-to-text and Dismiss button.
--   - Dismiss writes status='done' server-side (cross-device, never re-surfaces).
--
-- The `type` column is the open container for future reminder kinds — e.g.
-- 'rebook_reminder', 'estimate_followup' — without schema churn. The bell's
-- read path will treat unknown types defensively, so a new type can ship by
-- inserting rows + adding a render branch only.
--
-- Job-OPTIONAL: personId references a Person who may have zero jobs (the
-- canonical case: a contact who hasn't booked yet — Peter, GM at Toku Miami).
-- jobId is intentionally absent on this row; reminders are person-scoped.
--
-- followUpMonth = 'YYYY-MM' (month granularity intentional — week granularity
-- would mean too many "due this week" cards; day granularity invites snoozing
-- to a future day silently). The bell predicate is just:
--     strftime('%Y-%m', 'now') >= followUpMonth AND status='active'
--
-- ADDITIVE ONLY. No existing table changed. Snapshot taken via
-- POST /import/snapshot at 2026-06-17T18:23:29 before this ran.
--
-- Date: 2026-06-17

CREATE TABLE Reminder (
  reminderId      TEXT    PRIMARY KEY,
  type            TEXT    NOT NULL DEFAULT 'manual_follow_up',
  personId        TEXT    NOT NULL,
  followUpMonth   TEXT    NOT NULL,                    -- 'YYYY-MM'
  note            TEXT,
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','done','dismissed')),
  createdAt       TEXT    NOT NULL,
  modifiedAt      TEXT    NOT NULL,
  FOREIGN KEY (personId) REFERENCES Person(personId)
);
CREATE INDEX idx_reminder_person      ON Reminder(personId);
CREATE INDEX idx_reminder_active_due  ON Reminder(status, followUpMonth);
