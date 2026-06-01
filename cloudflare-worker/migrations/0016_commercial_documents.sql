-- Migration 0016: Commercial Pillar — Documents Foundation
--
-- Four new tables: Proposal, Invoice, LineItem, DocumentCounter
-- One new column:  Job.signedPhotoKey
--
-- ADDITIVE ONLY. No existing table dropped or column modified.
-- Only change to an existing table: ALTER TABLE Job ADD COLUMN (append-only).
--
-- Sector tag ('commercial'/'residential') on Proposal + Invoice means this
-- schema holds both commercial and residential documents — commercial ships
-- first, residential reuses the same tables with no retrofit.
--
-- Auto-numbering: DocumentCounter.lastSeq incremented atomically via:
--   INSERT INTO DocumentCounter (counterId,sector,docType,year,lastSeq)
--   VALUES (?,?,?,?,1)
--   ON CONFLICT(sector,docType,year) DO UPDATE SET lastSeq=lastSeq+1
--   RETURNING lastSeq;
--
-- Date: 2026-05-30

-- ── Proposal ──────────────────────────────────────────────────────────────────
CREATE TABLE Proposal (
  proposalId       TEXT    PRIMARY KEY,
  personId         TEXT    NOT NULL,
  sector           TEXT    NOT NULL CHECK(sector IN ('commercial','residential')),
  status           TEXT    NOT NULL DEFAULT 'draft'
                           CHECK(status IN ('draft','sent','awaiting_acceptance','accepted','declined','expired','superseded')),
  proposalDate     TEXT    NOT NULL,                    -- YYYY-MM-DD
  validUntil       TEXT,                                -- YYYY-MM-DD
  subject          TEXT,
  introText        TEXT,                                -- wordy opening paragraph
  closingText      TEXT,                                -- payment terms / closing language
  subtotal         REAL    NOT NULL DEFAULT 0,
  discountAmt      REAL,
  total            REAL    NOT NULL DEFAULT 0,
  paymentTerms     TEXT,                                -- "Net 30" | "Due on completion"
  sentAt           TEXT,
  acceptedAt       TEXT,
  declinedAt       TEXT,
  acceptanceMethod TEXT    CHECK(acceptanceMethod IS NULL OR
                           acceptanceMethod IN ('signed_photo','email_reply','verbal','digital')),
  signedPhotoKey   TEXT,                                -- R2 key: signed-docs/proposals/{proposalId}/...
  jobIds           TEXT,                                -- JSON array of Job.jobId
  notes            TEXT,
  internalNotes    TEXT,
  createdAt        TEXT    NOT NULL,
  modifiedAt       TEXT    NOT NULL,
  FOREIGN KEY (personId) REFERENCES Person(personId)
);
CREATE INDEX idx_proposal_person ON Proposal(personId);
CREATE INDEX idx_proposal_sector ON Proposal(sector, proposalDate);
CREATE INDEX idx_proposal_status ON Proposal(status);

-- ── Invoice ───────────────────────────────────────────────────────────────────
CREATE TABLE Invoice (
  invoiceId        TEXT    PRIMARY KEY,
  personId         TEXT    NOT NULL,
  sector           TEXT    NOT NULL CHECK(sector IN ('commercial','residential')),
  proposalId       TEXT,                                -- NULL if standalone; FK Proposal if generated from one
  status           TEXT    NOT NULL DEFAULT 'draft'
                           CHECK(status IN ('draft','sent','partial','paid','overdue','voided')),
  invoiceDate      TEXT    NOT NULL,                    -- YYYY-MM-DD
  dueDate          TEXT,                                -- YYYY-MM-DD
  subject          TEXT,
  introText        TEXT,
  subtotal         REAL    NOT NULL DEFAULT 0,
  discountAmt      REAL,
  taxAmt           REAL,
  total            REAL    NOT NULL DEFAULT 0,
  amountPaid       REAL    DEFAULT 0,
  paymentTerms     TEXT,
  paymentMethod    TEXT,
  paidAt           TEXT,
  sentAt           TEXT,
  viewedAt         TEXT,
  reminderSentAt   TEXT,
  jobIds           TEXT,                                -- JSON array of Job.jobId
  notes            TEXT,
  internalNotes    TEXT,
  createdAt        TEXT    NOT NULL,
  modifiedAt       TEXT    NOT NULL,
  FOREIGN KEY (personId)   REFERENCES Person(personId),
  FOREIGN KEY (proposalId) REFERENCES Proposal(proposalId)
);
CREATE INDEX idx_invoice_person   ON Invoice(personId);
CREATE INDEX idx_invoice_sector   ON Invoice(sector, invoiceDate);
CREATE INDEX idx_invoice_status   ON Invoice(status);
CREATE INDEX idx_invoice_proposal ON Invoice(proposalId);

-- ── LineItem ──────────────────────────────────────────────────────────────────
-- Polymorphic: belongs to either a Proposal or an Invoice.
-- documentType disambiguates (SQLite can't enforce a cross-table polymorphic FK).
CREATE TABLE LineItem (
  lineItemId   TEXT    PRIMARY KEY,
  documentType TEXT    NOT NULL CHECK(documentType IN ('proposal','invoice')),
  documentId   TEXT    NOT NULL,                        -- Proposal.proposalId or Invoice.invoiceId
  sortOrder    INTEGER NOT NULL DEFAULT 0,
  description  TEXT    NOT NULL,                        -- wordy: "Pressure wash Building A (3,200 sq ft)"
  quantity     REAL    DEFAULT 1,
  unit         TEXT,                                    -- 'sqft'|'building'|'visit'|'each'|null
  unitPrice    REAL    NOT NULL,
  lineTotal    REAL    NOT NULL,                        -- quantity × unitPrice, pre-computed
  notes        TEXT,
  createdAt    TEXT    NOT NULL
);
CREATE INDEX idx_lineitem_doc ON LineItem(documentType, documentId, sortOrder);

-- ── DocumentCounter ───────────────────────────────────────────────────────────
-- One row per (sector, docType, year). Never deleted, never reset within a year.
-- Atomic upsert-increment produces gap-free sequences with no collision risk.
-- counterId  = '{sector}-{docType}-{year}'  e.g. 'commercial-proposal-2026'
-- Resulting number: PROP-C-2026-{MMDD}-{NNN} / INV-C-2026-{MMDD}-{NNN}
CREATE TABLE DocumentCounter (
  counterId  TEXT    PRIMARY KEY,                       -- 'commercial-proposal-2026'
  sector     TEXT    NOT NULL,
  docType    TEXT    NOT NULL CHECK(docType IN ('proposal','invoice')),
  year       INTEGER NOT NULL,
  lastSeq    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sector, docType, year)
);

-- ── Job.signedPhotoKey ────────────────────────────────────────────────────────
-- Allows a signed acceptance photo to be attached at the job level
-- (complements Proposal.signedPhotoKey for proposal-level acceptance).
-- R2 key pattern: signed-docs/jobs/{jobId}/signed-{timestamp}.jpg
ALTER TABLE Job ADD COLUMN signedPhotoKey TEXT DEFAULT NULL;
