-- Migration 0010: propertyType on PersonProperty
-- Enables labeling system: main_residence | rental | vacation | investment | other
-- propertyLabel already exists (cid 7). propertyType is new.

ALTER TABLE PersonProperty ADD COLUMN propertyType TEXT;
-- values: 'main_residence' | 'rental' | 'vacation' | 'investment' | 'other' | NULL
-- NULL = unlabeled (single-property customers, or existing rows pre-migration)
