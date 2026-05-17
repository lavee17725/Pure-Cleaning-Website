-- Pure Cleaning CRM — Migration 0004: Job.roofStories column
-- Date: 2026-05-17
-- Purpose: Add structured roofStories field to Job so the render layer
--          can read it directly instead of parsing servicesRaw free text.
--
-- The data backfill (parsing servicesRaw → populating roofStories,
-- then deriving Property.stories per property) is done separately by
-- scripts/backfill_stories.py — NOT in this SQL file.
--
-- Background: audit revealed Property.stories (INT) existed in the Day 1
-- schema (0001) but was never populated. Job had no stories column at all.
-- servicesRaw text contains "2 story" / "1 story" in 875 of 1,811 jobs.
-- See: Stories Data Root Cause Audit (Drive, May 17, 2026).
--
-- After backfill:
--   ~277 jobs → roofStories = 2
--   ~598 jobs → roofStories = 1
--   ~936 jobs → roofStories = NULL (no story info in servicesRaw)
--   Properties with consistent roof-job history → stories updated
--   Properties with conflicting history → flagged in Drive doc, not updated

ALTER TABLE Job ADD COLUMN roofStories INTEGER;
CREATE INDEX idx_job_roofstories ON Job(roofStories) WHERE roofStories IS NOT NULL;
