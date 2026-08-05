-- 0049: parked jobs — real work with no knowable date
--
-- Some booked jobs genuinely have no date: the customer is mid-construction,
-- or sealing is rained out for weeks. Today they get dragged forward again and
-- again, which puts revenue on days that will never be worked, distorts
-- day-health and per-truck math, and makes the record look corrupt to any audit
-- (Janice Santana's 3-day family sitting collapsed on one date is exactly this).
--
-- A parked job is DATELESS. scheduledDate is NULL and state='parked'. The
-- invariant is: a job has a date or it is parked, never both.
--
-- WHY NOT REUSE 'needs_scheduling': that state means "pick a date soon" — it is
-- a queue with an expectation attached. Parked means "there is no date to pick
-- yet, don't ask me again." Conflating the two is the dayNumber/totalDays
-- mistake — one column, two meanings, and two sessions to untangle.

ALTER TABLE Job ADD COLUMN parkedReason   TEXT;  -- "waiting on construction", "rain — sealing"
ALTER TABLE Job ADD COLUMN parkedAt       TEXT;  -- ISO timestamp, for "parked 6 weeks" context
ALTER TABLE Job ADD COLUMN parkedFromDate TEXT;  -- the date it held when parked, offered back on un-park

CREATE INDEX IF NOT EXISTS idx_job_parked ON Job(state) WHERE state = 'parked';
