-- Pure Cleaning CRM — Migration 0018: DailyRigAssignment + CrewMember bridge
-- Date: 2026-06-05
-- Phase 1 of crew-labor build (FOUNDATION ONLY — no behavior change).
--
-- Three sections:
--   1. CREATE TABLE DailyRigAssignment — rig-level daily crew roster (empty; populated in Phase 2)
--   2. ALTER TABLE CrewMember — add shortId bridge + financial fields (currently hardcoded in CREW_MEMBERS constant)
--   3. SEED CrewMember rows — shortId + financials from the CREW_MEMBERS constant; INSERT missing Tony row
--
-- Law T1.22: Capture ⟹ Persist ⟹ Connect.
-- This phase only creates the data home. No new endpoints, no UI rewiring.
-- The CREW_MEMBERS JS constant remains authoritative for behavior until Phase 4 rewires it.
--
-- Nothing reads shortId, dailyRate, halfRate, isDriver, receiveAutoTexts yet.
-- DailyRigAssignment is empty; no code writes to or reads from it yet.
-- Zero behavior change in this migration.

-- ── 1. DailyRigAssignment ────────────────────────────────────────────────────
-- One row per (date, rig, crew member) assignment.
-- date:         YYYY-MM-DD
-- rigId:        FK to Rig.rigId (rig_1 | rig_2 | rig_3)
-- crewMemberId: FK to CrewMember.crewMemberId (UUID)
-- role:         'driver' | 'crew'   (driver = designated SMS recipient for textDriver())
-- dayType:      'full' | 'half'     (per-rig-per-day; all crew on a rig share same dayType)
-- createdAt/modifiedAt: ISO-8601 audit timestamps
--
-- SQLite FK constraints are not enforced by default; documented as intent.

CREATE TABLE DailyRigAssignment (
  date         TEXT NOT NULL,
  rigId        TEXT NOT NULL,
  crewMemberId TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'crew',   -- 'driver' | 'crew'
  dayType      TEXT NOT NULL DEFAULT 'full',   -- 'full' | 'half'
  createdAt    TEXT NOT NULL,
  modifiedAt   TEXT NOT NULL,
  PRIMARY KEY (date, rigId, crewMemberId),
  FOREIGN KEY (crewMemberId) REFERENCES CrewMember(crewMemberId)
);

CREATE INDEX idx_dra_date_rig ON DailyRigAssignment(date, rigId);
CREATE INDEX idx_dra_crew     ON DailyRigAssignment(crewMemberId, date);

-- ── 2. ALTER TABLE CrewMember ────────────────────────────────────────────────
-- shortId:          Short string identifier matching the CREW_MEMBERS JS constant
--                   (e.g. 'byron', 'jonathan'). Bridge between UUID PK and UI shorthand.
-- dailyRate:        Full-day pay rate in USD. Mirrors CREW_MEMBERS constant.
-- halfRate:         Half-day pay rate in USD. Mirrors CREW_MEMBERS constant.
-- isDriver:         1 if eligible to receive rig SMS route texts.
-- receiveAutoTexts: 1 if included in automated crew messaging.
--
-- All nullable (existing rows get NULL; seeded below for real crew).

ALTER TABLE CrewMember ADD COLUMN shortId          TEXT    DEFAULT NULL;
ALTER TABLE CrewMember ADD COLUMN dailyRate        REAL    DEFAULT NULL;
ALTER TABLE CrewMember ADD COLUMN halfRate         REAL    DEFAULT NULL;
ALTER TABLE CrewMember ADD COLUMN isDriver         INTEGER DEFAULT 0;
ALTER TABLE CrewMember ADD COLUMN receiveAutoTexts INTEGER DEFAULT 0;

-- ── 3. SEED — bridge + financial fields from CREW_MEMBERS constant ──────────
-- Targeted by UUID so the UPDATE is idempotent and safe to re-run.
-- SMOKE TEST row (220b3e55) left untouched.

UPDATE CrewMember
SET shortId='byron', dailyRate=150, halfRate=75, isDriver=1, receiveAutoTexts=1,
    modifiedAt='2026-06-05T00:00:00.000Z'
WHERE crewMemberId='d0461775-c899-4dfb-be0d-51be0a3cabee';  -- Byron

UPDATE CrewMember
SET shortId='danny', dailyRate=150, halfRate=75, isDriver=0, receiveAutoTexts=0,
    modifiedAt='2026-06-05T00:00:00.000Z'
WHERE crewMemberId='4c02c095-7c4c-4b01-bf79-f4496db6a5c3';  -- Danny

UPDATE CrewMember
SET shortId='jonathan', dailyRate=160, halfRate=80, isDriver=1, receiveAutoTexts=1,
    modifiedAt='2026-06-05T00:00:00.000Z'
WHERE crewMemberId='837b0ea4-3da3-4f3c-8ccf-61049dbf4a59';  -- Jonathan

UPDATE CrewMember
SET shortId='tyler', dailyRate=150, halfRate=75, isDriver=1, receiveAutoTexts=0,
    modifiedAt='2026-06-05T00:00:00.000Z'
WHERE crewMemberId='bec76311-9444-4f4b-84c3-0aea61a2ec15';  -- Tyler Fumero

-- ── 4. INSERT missing Tony row ───────────────────────────────────────────────
-- Tony is in the CREW_MEMBERS constant (shortId='tony', role='owner', dailyRate=0,
-- halfRate=0, isDriver=1, receiveAutoTexts=false) but had no CrewMember row.
-- Phone matches the CREW_MEMBERS constant (+19546103843, same as Tyler — intentional,
-- both owner lines go to the same number).

INSERT INTO CrewMember
  (crewMemberId, name, active, role, phone,
   shortId, dailyRate, halfRate, isDriver, receiveAutoTexts,
   createdAt, modifiedAt)
VALUES
  ('8beba687-e888-44ca-b2e0-ae2a9ec5f831',
   'Tony', 1, 'owner', '+19546103843',
   'tony', 0, 0, 1, 0,
   '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z');
