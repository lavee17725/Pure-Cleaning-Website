-- Migration 0013: Add roofType column to Job table
-- Stores the roof material type per job (shingle, barrel_tile, flat_tile, metal, etc.)
-- Companion to roofStories (added in 0004). Written by _doCompleteJob and pencil edit.
-- Date: 2026-05-28

ALTER TABLE Job ADD COLUMN roofType TEXT;
