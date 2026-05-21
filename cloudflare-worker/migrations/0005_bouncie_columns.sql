-- Migration 0005: Add Bouncie GPS columns to Property and Job tables.
-- Removes dependency on TEMP KV bridge in d1AllCustomersToKvShape /
-- d1CustomerToKvShape. Property.latitude + longitude already exist
-- from 0001; only geocodeSource is new. Job gains six Bouncie columns.

ALTER TABLE Property ADD COLUMN geocodeSource TEXT;

ALTER TABLE Job ADD COLUMN actualDuration      INTEGER;
ALTER TABLE Job ADD COLUMN actualArrival       TEXT;
ALTER TABLE Job ADD COLUMN actualDeparture     TEXT;
ALTER TABLE Job ADD COLUMN bouncieMatchStatus  TEXT;
ALTER TABLE Job ADD COLUMN bouncieMatchConfidence REAL;
ALTER TABLE Job ADD COLUMN geocodeSource       TEXT;
