-- Archived 2026-05-17. Dryrun tables were dropped after canonical write verification. Kept for historical reference.

-- Pure Cleaning CRM — Dry-run shadow tables
-- Migration: 0002_dryrun_tables
-- Purpose: Receive identity-resolution dry-run output.
--          Mirrors canonical schema with _dryrun suffix.
--          FK constraints removed to avoid cross-table FK issues during dry-run.
--          Indexes retained for spot-check queries.

-- ── Person_dryrun ─────────────────────────────────────────────────────────────
CREATE TABLE Person_dryrun (
  personId               TEXT PRIMARY KEY,
  firstName              TEXT,
  lastName               TEXT,
  businessName           TEXT,
  aliases                TEXT,
  primaryPhone           TEXT,
  alternatePhones        TEXT,
  email                  TEXT,
  preferredContact       TEXT DEFAULT 'phone',
  isHomeowner            INTEGER DEFAULT 0,
  isReferralSource       INTEGER DEFAULT 0,
  isCommercialAccount    INTEGER DEFAULT 0,
  isReferralOnly         INTEGER DEFAULT 0,
  preferredPaymentMethod TEXT,
  doNotContact           INTEGER DEFAULT 0,
  doNotService           INTEGER DEFAULT 0,
  billingNotes           TEXT,
  internalNotes          TEXT,
  createdAt              TEXT NOT NULL,
  modifiedAt             TEXT NOT NULL,
  migratedFrom           TEXT,
  migrationVersion       TEXT,
  migratedAt             TEXT,
  migrationConfidence    TEXT,
  migrationNotes         TEXT
);
CREATE INDEX idx_pd_phone    ON Person_dryrun(primaryPhone);
CREATE INDEX idx_pd_lastname ON Person_dryrun(lastName);

-- ── Property_dryrun ───────────────────────────────────────────────────────────
CREATE TABLE Property_dryrun (
  propertyId          TEXT PRIMARY KEY,
  googlePlaceId       TEXT,
  streetAddress       TEXT NOT NULL,
  unit                TEXT,
  city                TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'FL',
  zip                 TEXT,
  zipPlus4            TEXT,
  latitude            REAL,
  longitude           REAL,
  communityName       TEXT,
  county              TEXT,
  sqft                INTEGER,
  stories             INTEGER,
  roofType            TEXT,
  yearBuilt           INTEGER,
  gateCode            TEXT,
  accessNotes         TEXT,
  milesFromHomeBase   REAL,
  createdAt           TEXT NOT NULL,
  modifiedAt          TEXT NOT NULL,
  migratedFrom        TEXT,
  migrationVersion    TEXT,
  migratedAt          TEXT,
  migrationConfidence TEXT,
  migrationNotes      TEXT
);
CREATE INDEX idx_propd_city ON Property_dryrun(city);

-- ── PersonProperty_dryrun ─────────────────────────────────────────────────────
CREATE TABLE PersonProperty_dryrun (
  personId       TEXT NOT NULL,
  propertyId     TEXT NOT NULL,
  relationship   TEXT NOT NULL,
  primaryContact INTEGER DEFAULT 0,
  startedAt      TEXT,
  endedAt        TEXT,
  notes          TEXT,
  PRIMARY KEY (personId, propertyId, relationship)
);
CREATE INDEX idx_ppd_person   ON PersonProperty_dryrun(personId);
CREATE INDEX idx_ppd_property ON PersonProperty_dryrun(propertyId);

-- ── Job_dryrun ────────────────────────────────────────────────────────────────
CREATE TABLE Job_dryrun (
  jobId                    TEXT PRIMARY KEY,
  payerId                  TEXT NOT NULL,
  propertyId               TEXT NOT NULL,
  referredById             TEXT,
  scheduledDate            TEXT,
  scheduledTimeWindow      TEXT,
  estimatedStartTime       TEXT,
  estimatedEndTime         TEXT,
  state                    TEXT NOT NULL DEFAULT 'pending',
  completedAt              TEXT,
  cancelledAt              TEXT,
  cancellationReason       TEXT,
  servicesRequested        TEXT NOT NULL,
  servicesPerformed        TEXT,
  servicesRaw              TEXT,
  amount                   REAL NOT NULL,
  paymentMethod            TEXT,
  paymentStatus            TEXT NOT NULL DEFAULT 'unpaid',
  paidAt                   TEXT,
  receiptSentAt            TEXT,
  rigId                    TEXT,
  crewMembers              TEXT,
  reviewRequested          INTEGER DEFAULT 0,
  reviewRequestedAt        TEXT,
  reviewStatus             TEXT,
  isReferralOnly           INTEGER DEFAULT 0,
  isCommercialJob          INTEGER DEFAULT 0,
  isMultiBuildingJob       INTEGER DEFAULT 0,
  drivetimeFromPreviousJob INTEGER,
  milesFromPreviousJob     REAL,
  jobNotes                 TEXT,
  internalNotes            TEXT,
  createdAt                TEXT NOT NULL,
  modifiedAt               TEXT NOT NULL,
  source                   TEXT NOT NULL,
  migratedFrom             TEXT,
  migrationVersion         TEXT,
  migratedAt               TEXT,
  migrationConfidence      TEXT,
  migrationNotes           TEXT
);
CREATE INDEX idx_jobd_payer     ON Job_dryrun(payerId);
CREATE INDEX idx_jobd_property  ON Job_dryrun(propertyId);
CREATE INDEX idx_jobd_scheduled ON Job_dryrun(scheduledDate, state);

-- ── MigrationManifest_dryrun ──────────────────────────────────────────────────
CREATE TABLE MigrationManifest_dryrun (
  migrationId              TEXT PRIMARY KEY,
  migrationVersion         TEXT NOT NULL,
  startedAt                TEXT NOT NULL,
  completedAt              TEXT,
  status                   TEXT,
  totalRecordsProcessed    INTEGER,
  personsCreated           INTEGER,
  propertiesCreated        INTEGER,
  jobsCreated              INTEGER,
  aliasesMerged            INTEGER,
  flaggedForReview         INTEGER,
  unresolvedReferrers      INTEGER,
  transformationsApplied   TEXT,
  summary                  TEXT,
  notes                    TEXT
);
