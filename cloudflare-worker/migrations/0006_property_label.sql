-- Migration 0006: Add propertyLabel to PersonProperty
-- Enables multi-property labeling (Main Residence / Second Home /
-- Rental / Other). Non-destructive — nullable column, no defaults
-- on non-primary rows so UI can prompt for label on first edit.
--
-- Applied: 2026-05-21 (Phase 1C of multi-property feature)

ALTER TABLE PersonProperty ADD COLUMN propertyLabel TEXT;

UPDATE PersonProperty
SET propertyLabel = 'Main Residence'
WHERE primaryContact = 1;
