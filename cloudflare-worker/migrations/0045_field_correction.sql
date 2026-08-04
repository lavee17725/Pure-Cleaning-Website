-- Migration 0045: FieldCorrection — audit trail for quote-time data corrections.
--
-- ~1,800 jobs / 1,300+ customers came from CSVs and handwritten sheets at
-- ~90-95% accuracy. The quote call is when the customer states their real
-- address out loud, so the booking flow is the natural correction mechanism.
-- Those corrections overwrite migrated data, so they must be traceable and
-- reversible — a wrong "correction" that silently clobbers good data is worse
-- than the original error.
--
-- Mirrors MergeLog's proven shape (including undoneAt) rather than inventing a
-- second audit pattern.
--
-- beforeJson/afterJson hold the full prior/next state of everything the
-- correction touched (property row, re-pointed jobIds, backfilled workSite
-- copies, geocode) so an undo can restore it exactly.

CREATE TABLE IF NOT EXISTS FieldCorrection (
  correctionId  TEXT PRIMARY KEY,
  personId      TEXT NOT NULL,
  entity        TEXT NOT NULL,              -- 'property' | 'person'
  entityId      TEXT,                       -- propertyId / personId corrected
  field         TEXT NOT NULL,              -- 'address' | 'name' | ...
  oldValue      TEXT,
  newValue      TEXT,
  beforeJson    TEXT,                       -- full prior state, for undo
  afterJson     TEXT,                       -- what was written
  jobsRepointed TEXT,                       -- JSON array of jobId
  copiesFixed   TEXT,                       -- JSON array of jobId (workSiteAddress mirrors)
  source        TEXT NOT NULL,              -- 'quote_time_gate' | 'repair_pass' | ...
  createdAt     TEXT NOT NULL,
  createdBy     TEXT,
  undoneAt      TEXT,
  notes         TEXT,
  FOREIGN KEY (personId) REFERENCES Person(personId)
);

CREATE INDEX IF NOT EXISTS idx_fieldcorr_person ON FieldCorrection(personId);
CREATE INDEX IF NOT EXISTS idx_fieldcorr_created ON FieldCorrection(createdAt);
