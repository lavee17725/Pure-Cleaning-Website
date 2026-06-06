-- Migration 0019: Property Images Foundation
--
-- Two new columns:
--   Job.photoKeys              — JSON array of R2 keys for before/after photos
--                                e.g. ["job/{jobId}/before_1234567.jpg", "job/{jobId}/after_1234567.jpg"]
--   Property.satelliteImageKey — single R2 key for satellite screenshot
--                                e.g. "property/{propertyId}/satellite.jpg"
--
-- ADDITIVE ONLY. No existing table dropped or column modified.
-- Nothing reads or writes these columns yet — wired in Phase 2+ (quote-builder
-- capture and profile/calendar display). Zero behavior change on deploy.
--
-- Storage: env.PHOTOS R2 bucket ("pure-cleaning-photos").
-- References are R2 keys only; blobs live entirely in R2.
--
-- Date: 2026-06-06

ALTER TABLE Job      ADD COLUMN photoKeys          TEXT DEFAULT NULL;
ALTER TABLE Property ADD COLUMN satelliteImageKey  TEXT DEFAULT NULL;
