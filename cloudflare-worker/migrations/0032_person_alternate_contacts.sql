-- Migration 0032: Person.alternateContactsJson
-- 2026-06-22: alternateContacts (array of {name, phone, label, relation}) was
-- KV-only — the calendar/new-customer modals captured "second number" entries
-- that disappeared on every D1 rebuild. Promoting to D1 makes it canonical so
-- adding Mom's secondary number actually sticks across devices and reads.
--
-- altPhone (legacy single-field) is INTENTIONALLY not added — the array form
-- (alternateContacts) supersedes it; existing altPhone strings get projected
-- into the array via the KV bridge until callers fully migrate.
ALTER TABLE Person ADD COLUMN alternateContactsJson TEXT;
