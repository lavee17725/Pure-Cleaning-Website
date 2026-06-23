-- Migration 0033: identity-migration audit columns for change-primary-phone + merge.
-- 2026-06-22: phone = personId in this system, so a "change primary phone" or a
-- "merge two records into one" requires creating/keeping one canonical Person
-- and retiring the rest. We never hard-delete in these flows — instead we mark
-- the obsolete row retired with a pointer to the surviving personId, so audits
-- and incoming references to the old phone can resolve.
--
-- replacedBy:     newPersonId the old record was redirected to (NULL until retired)
-- retiredAt:      ISO timestamp when the row was retired (NULL = active)
-- retiredReason:  'phone_change' | 'merge' (NULL = active)
--
-- Reads (d1AllCustomersToKvShape, d1CustomerToKvShape) filter out retired rows
-- so they never appear in the directory / bulk reactivation / calendar.

ALTER TABLE Person ADD COLUMN replacedBy TEXT;
ALTER TABLE Person ADD COLUMN retiredAt TEXT;
ALTER TABLE Person ADD COLUMN retiredReason TEXT;
