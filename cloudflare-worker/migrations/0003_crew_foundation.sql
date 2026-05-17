-- Pure Cleaning CRM — Migration 0003: Crew Foundation
-- Date: 2026-05-17
-- Purpose: Schema additions for Worker Directory / Crew Engagement feature (Sub-Phase 0a).
--
-- Sections:
--   1. Extend CrewMember — add contact info + audit timestamps
--   2. Add Person.preferredCrewMemberId — customer preferred-worker tracking
--   3. Create JobCrewAssignment — per-job crew assignment (replaces Job.crewMembers JSON eventually)
--
-- All changes are purely additive. No existing data modified.
-- Job.crewMembers JSON column is preserved; drop it in a later migration
-- once JobCrewAssignment is fully populated and verified.
--
-- See Crew Engagement Vision v2 Drive doc for the bigger picture.

-- ── 1. Extend CrewMember ───────────────────────────────────────────────────────
-- SQLite ALTER TABLE ADD COLUMN cannot specify NOT NULL without a default
-- on existing rows. Added as nullable; future CRUD inserts always set all fields.
-- CrewMember has 0 rows at time of this migration, so backfill is moot.

ALTER TABLE CrewMember ADD COLUMN phone     TEXT;  -- E.164 format per Rule 17
ALTER TABLE CrewMember ADD COLUMN email     TEXT;
ALTER TABLE CrewMember ADD COLUMN hiredAt   TEXT;  -- YYYY-MM-DD
ALTER TABLE CrewMember ADD COLUMN notes     TEXT;
ALTER TABLE CrewMember ADD COLUMN createdAt  TEXT;  -- ISO 8601
ALTER TABLE CrewMember ADD COLUMN modifiedAt TEXT;  -- ISO 8601

-- ── 2. Person.preferredCrewMemberId ───────────────────────────────────────────
-- Nullable FK to CrewMember(crewMemberId). FK constraint not enforced via
-- ALTER (SQLite limitation) but documented intent: only valid crewMemberIds.

ALTER TABLE Person ADD COLUMN preferredCrewMemberId TEXT;

-- ── 3. JobCrewAssignment ──────────────────────────────────────────────────────
-- Per-job crew assignment with role. wasRequested is intentionally omitted —
-- derive it by joining with Person.preferredCrewMemberId at query time.

CREATE TABLE JobCrewAssignment (
  jobId        TEXT NOT NULL,
  crewMemberId TEXT NOT NULL,
  role         TEXT,  -- 'lead' | 'helper' | 'driver'
  PRIMARY KEY (jobId, crewMemberId),
  FOREIGN KEY (jobId)        REFERENCES Job(jobId)               ON DELETE CASCADE,
  FOREIGN KEY (crewMemberId) REFERENCES CrewMember(crewMemberId)
);
CREATE INDEX idx_jca_crew ON JobCrewAssignment(crewMemberId);
CREATE INDEX idx_jca_job  ON JobCrewAssignment(jobId);
