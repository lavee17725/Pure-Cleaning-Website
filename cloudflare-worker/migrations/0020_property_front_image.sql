-- Migration 0020: Property front-of-house / BCPA reference image
--
-- Adds one column to mirror the satelliteImageKey pattern (migration 0019):
--   Property.frontImageKey — single R2 key for the BCPA / front-of-house screenshot
--                            e.g. "property/{propertyId}/front.jpg"
--
-- ADDITIVE ONLY. No existing table dropped or column modified. Zero behavior change.
-- Wired in Phase 2 (quote-builder capture) and Phase 3 (profile/calendar display).
--
-- Date: 2026-06-06

ALTER TABLE Property ADD COLUMN frontImageKey TEXT DEFAULT NULL;
