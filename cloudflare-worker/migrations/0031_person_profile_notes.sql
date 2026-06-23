-- Migration 0031: Person.profileNotesJson
-- 2026-06-22: customer_profile.html was writing profileNotes via whole-DB
-- PUT /customers (Rule 7 anti-pattern) — cross-device clobber risk and no
-- D1 home for the data. This column gives notes a canonical D1 store; the
-- new POST /admin/person/:id/note endpoint reads/appends/writes here.
--
-- JSON array of { id, text, author, createdAt } records.
ALTER TABLE Person ADD COLUMN profileNotesJson TEXT;
