-- Migration 0034: MergeLog table for undo-able Person merges.
-- 2026-06-22: handlePersonsMerge writes one MergeLog row per merge operation.
-- It records every FK row that got re-linked (Job/PersonProperty/Invoice/
-- Proposal/Reminder/Communication) and every alt-phone added to the keeper,
-- so handlePersonsUnmerge can exactly reverse the merge later.
--
-- relinkedRows: JSON array of { dropPersonId, tableName, rowId, fkColumn }
-- addedAlts:    JSON array of 10-digit phone strings added to keepId.alternateContactsJson
--
-- undoneAt:     ISO timestamp when the unmerge fired (NULL = merge still in effect)

CREATE TABLE IF NOT EXISTS MergeLog (
  mergeId       TEXT PRIMARY KEY,
  keepId        TEXT NOT NULL,
  dropIds       TEXT NOT NULL,       -- JSON array
  relinkedRows  TEXT NOT NULL,       -- JSON array of relink ops
  addedAlts     TEXT,                -- JSON array of phone digits
  createdAt     TEXT NOT NULL,
  createdBy     TEXT,
  undoneAt      TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_mergelog_keepId    ON MergeLog (keepId);
CREATE INDEX IF NOT EXISTS idx_mergelog_createdAt ON MergeLog (createdAt);
