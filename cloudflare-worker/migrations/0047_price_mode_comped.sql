-- 0047: priceMode — one field for "why is this amount what it is"
--
-- Job.amount is NOT NULL (original schema), so every "no price" state has to be
-- stored as a 0 placeholder plus a flag. We had exactly one flag (priceTbd), so
-- a comped job was indistinguishable from a dropped price, and Hardev Mattu's
-- intentional free cleanings kept surfacing as data-quality defects.
--
-- Two booleans (priceTbd + a new isComped) can disagree — a row could claim to
-- be both TBD and comped, and nothing would say which wins. One enum can't.
--
--   'standard' — amount is the real price
--   'tbd'      — priced after the job; amount 0 is a placeholder, not a price
--   'comped'   — deliberately free; amount 0 IS the truth
--
-- priceTbd stays as a DERIVED MIRROR (worker writes it from priceMode in the
-- same statement, never independently) so existing readers keep working. It is
-- no longer a source of truth; a later migration can drop it.

ALTER TABLE Job ADD COLUMN priceMode TEXT NOT NULL DEFAULT 'standard';

-- Why it was comped. Required when priceMode='comped' — enforced in the worker,
-- because "free" without a reason is the same unreadable record we started with.
ALTER TABLE Job ADD COLUMN compedReason TEXT;

-- Who the comp is FOR, when it's reciprocity for someone else's business.
-- Deliberately its own column rather than reusing Job.referredById (which exists
-- as an FK to Person but is set on 0 of 1,922 rows). Overloading a column with a
-- second meaning is exactly what dayNumber/totalDays did, and untangling that
-- cost two sessions.
ALTER TABLE Job ADD COLUMN compedForPersonId TEXT REFERENCES Person(personId);

-- What the work WOULD have billed at. Not revenue, never summed into it — this
-- is what makes "what have I given Hardev against what Premier has paid me"
-- answerable instead of a guess.
ALTER TABLE Job ADD COLUMN compedValue REAL;

UPDATE Job SET priceMode = 'tbd' WHERE priceTbd = 1;

CREATE INDEX IF NOT EXISTS idx_job_priceMode ON Job(priceMode) WHERE priceMode != 'standard';
CREATE INDEX IF NOT EXISTS idx_job_compedFor ON Job(compedForPersonId) WHERE compedForPersonId IS NOT NULL;
