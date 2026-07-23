-- Migration 0038: PersonProperty duplicate-link fix (multi-property booking bug root cause).
--
-- Root cause: PK is (personId, propertyId, relationship). The KV-dual-write path wrote
-- relationship = isCommercialAccount ? 'manager' : 'owner', while the admin-API create
-- path hardcodes 'owner'. For commercial/partner customers that produced TWO rows for the
-- same (personId, propertyId) — 'owner' AND 'manager' — which INSERT OR IGNORE can't dedupe.
-- The calendar-jobs JOIN then multiplied every job on that property (duplicate cards;
-- deleting one cancelled the single row so both vanished).
--
-- Audit: nothing load-bearing reads PersonProperty.relationship (owner vs manager) — not the
-- frontend, not properties[], only merge/unmerge PK handling. Safe to collapse owner > manager.
-- Snapshot: customer_db_backup_2026-07-16T15-45-05 taken before this ran.

-- 1. Preserve the primary flag: if a duplicate group's primaryContact=1 sits on the row we're
--    about to drop, move it onto the surviving 'owner' row first (Glen's prop_7085 case).
UPDATE PersonProperty SET primaryContact = 1
WHERE relationship = 'owner'
  AND EXISTS (
    SELECT 1 FROM PersonProperty p2
    WHERE p2.personId = PersonProperty.personId
      AND p2.propertyId = PersonProperty.propertyId
      AND p2.relationship <> 'owner'
      AND p2.primaryContact = 1
  );

-- 2. Collapse: delete the non-'owner' duplicate rows where an 'owner' row exists for the pair.
DELETE FROM PersonProperty
WHERE relationship <> 'owner'
  AND EXISTS (
    SELECT 1 FROM PersonProperty p2
    WHERE p2.personId = PersonProperty.personId
      AND p2.propertyId = PersonProperty.propertyId
      AND p2.relationship = 'owner'
  );

-- 3. Hard guard against ANY future duplicate link, regardless of relationship value.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personproperty_unique ON PersonProperty(personId, propertyId);
