-- Pure Cleaning CRM — Schema v3 FINAL (LOCKED)
-- Migration: 0001_initial_schema
-- Locked: May 13, 2026. Applied: Day 1 migration.
-- Architecture: D1 canonical, KV cache + tokens.

-- ── Person ────────────────────────────────────────────────────────────────────
CREATE TABLE Person (
  personId               TEXT PRIMARY KEY,
  firstName              TEXT,
  lastName               TEXT,
  businessName           TEXT,
  aliases                TEXT,           -- JSON array
  primaryPhone           TEXT,           -- E.164 format
  alternatePhones        TEXT,           -- JSON array
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
CREATE INDEX idx_person_phone    ON Person(primaryPhone);
CREATE INDEX idx_person_lastname ON Person(lastName);
CREATE INDEX idx_person_business ON Person(businessName);
CREATE INDEX idx_person_referral ON Person(isReferralSource) WHERE isReferralSource = 1;

-- ── Property ──────────────────────────────────────────────────────────────────
CREATE TABLE Property (
  propertyId           TEXT PRIMARY KEY,
  googlePlaceId        TEXT UNIQUE,
  streetAddress        TEXT NOT NULL,
  unit                 TEXT,
  city                 TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'FL',
  zip                  TEXT,
  zipPlus4             TEXT,
  latitude             REAL,
  longitude            REAL,
  communityName        TEXT,
  county               TEXT,
  sqft                 INTEGER,
  stories              INTEGER,         -- 1 or 2 (moved from Job)
  roofType             TEXT,            -- Barrel Tile | Flat Tile | Shingle | Metal | Steel
  yearBuilt            INTEGER,
  gateCode             TEXT,
  accessNotes          TEXT,
  milesFromHomeBase    REAL,
  createdAt            TEXT NOT NULL,
  modifiedAt           TEXT NOT NULL,
  migratedFrom         TEXT,
  migrationVersion     TEXT,
  migratedAt           TEXT,
  migrationConfidence  TEXT,
  migrationNotes       TEXT
);
CREATE INDEX idx_property_city ON Property(city);
CREATE INDEX idx_property_zip  ON Property(zip);
CREATE INDEX idx_property_geo  ON Property(latitude, longitude);

-- ── PersonProperty (many-to-many) ─────────────────────────────────────────────
CREATE TABLE PersonProperty (
  personId         TEXT NOT NULL,
  propertyId       TEXT NOT NULL,
  relationship     TEXT NOT NULL,  -- owner | manager | referrer | tenant | family
  primaryContact   INTEGER DEFAULT 0,
  startedAt        TEXT,
  endedAt          TEXT,
  notes            TEXT,
  PRIMARY KEY (personId, propertyId, relationship),
  FOREIGN KEY (personId)   REFERENCES Person(personId)   ON DELETE CASCADE,
  FOREIGN KEY (propertyId) REFERENCES Property(propertyId) ON DELETE CASCADE
);

-- ── Job ───────────────────────────────────────────────────────────────────────
CREATE TABLE Job (
  jobId                    TEXT PRIMARY KEY,
  payerId                  TEXT NOT NULL,
  propertyId               TEXT NOT NULL,
  referredById             TEXT,
  scheduledDate            TEXT,           -- YYYY-MM-DD
  scheduledTimeWindow      TEXT,           -- Morning | Early Afternoon | Afternoon | Flexible
  estimatedStartTime       TEXT,
  estimatedEndTime         TEXT,
  state                    TEXT NOT NULL DEFAULT 'pending',
    -- pending | scheduled | in_progress | completed | cancelled | reverted
  completedAt              TEXT,
  cancelledAt              TEXT,
  cancellationReason       TEXT,
  servicesRequested        TEXT NOT NULL,  -- JSON array from canonical taxonomy
  servicesPerformed        TEXT,           -- JSON array
  servicesRaw              TEXT,           -- original CSV string for audit
  amount                   REAL NOT NULL,
  paymentMethod            TEXT,           -- Zelle | Check | Cash | Venmo
  paymentStatus            TEXT NOT NULL DEFAULT 'unpaid',
    -- unpaid | requested | paid | partial | refunded
  paidAt                   TEXT,
  receiptSentAt            TEXT,
  rigId                    TEXT,
  crewMembers              TEXT,           -- JSON array
  reviewRequested          INTEGER DEFAULT 0,
  reviewRequestedAt        TEXT,
  reviewStatus             TEXT,           -- not_asked | asked | posted | declined
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
    -- quote_form | phone_quote | reschedule | csv_backfill_2024/2025/2026 | manual_repair
  migratedFrom             TEXT,
  migrationVersion         TEXT,
  migratedAt               TEXT,
  migrationConfidence      TEXT,
  migrationNotes           TEXT,
  FOREIGN KEY (payerId)      REFERENCES Person(personId),
  FOREIGN KEY (propertyId)   REFERENCES Property(propertyId),
  FOREIGN KEY (referredById) REFERENCES Person(personId)
);
CREATE INDEX idx_job_payer     ON Job(payerId);
CREATE INDEX idx_job_property  ON Job(propertyId);
CREATE INDEX idx_job_referrer  ON Job(referredById);
CREATE INDEX idx_job_scheduled ON Job(scheduledDate, state);
CREATE INDEX idx_job_completed ON Job(completedAt) WHERE state = 'completed';
CREATE INDEX idx_job_rig_date  ON Job(rigId, scheduledDate);

-- ── Rig ───────────────────────────────────────────────────────────────────────
CREATE TABLE Rig (
  rigId        TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  active       INTEGER DEFAULT 1,
  capabilities TEXT
);

-- ── CrewMember ────────────────────────────────────────────────────────────────
CREATE TABLE CrewMember (
  crewMemberId TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  active       INTEGER DEFAULT 1,
  role         TEXT
);

-- ── Communication ─────────────────────────────────────────────────────────────
CREATE TABLE Communication (
  communicationId TEXT PRIMARY KEY,
  personId        TEXT NOT NULL,
  jobId           TEXT,
  channel         TEXT NOT NULL,   -- sms | email | call | quote_link | review_request
  direction       TEXT NOT NULL,   -- outbound | inbound
  content         TEXT,
  sentAt          TEXT NOT NULL,
  outcome         TEXT,
  FOREIGN KEY (personId) REFERENCES Person(personId),
  FOREIGN KEY (jobId)    REFERENCES Job(jobId)
);
CREATE INDEX idx_comm_person ON Communication(personId, sentAt);

-- ── MigrationManifest ─────────────────────────────────────────────────────────
CREATE TABLE MigrationManifest (
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
  transformationsApplied   TEXT,  -- JSON: rule name → count
  summary                  TEXT,
  notes                    TEXT
);
