-- Migration 0028: Cost Hub Phase 1 — capture-only schema (no allocation math yet)
--
-- Three new tables for the COGS / Profitability "second head" of the quoting
-- engine. Capture is Phase 1; the allocation engine (Bouncie miles+hours →
-- per-job profit) lands in Phase 2; weekly/monthly P&L + per-job profit chip
-- on the calendar lands in Phase 3. See docs/QUOTING-ENGINE.md §16.
--
--   CostEntry      — every spend: gas receipt, chlorine fill, sealer gallons,
--                    truck repair, monthly rent, etc. One row per spend.
--   CostCategory   — closed vocabulary for `type` (gas | chlorine | sealer | …);
--                    `kind` separates per-job-variable vs fixed-monthly vs
--                    occasional so the UI groups them correctly.
--   Equipment     — registry by serial last-4 (or label). Lifespan tracked in
--                    operating HOURS (from Bouncie active time for the rig the
--                    item lives on) — the seasonal calendar lies, hours don't.
--
-- ADDITIVE ONLY — no existing column changed, no existing row mutated.
-- Snapshot customer_db_backup_2026-06-19T01-31-27 taken before applying.
--
-- Date: 2026-06-19

-- ── CostEntry ────────────────────────────────────────────────────────────────
-- One row per spend (or per-job consumable). The allocation engine in Phase 2
-- will JOIN this against Job/TruckEvent to compute per-job profit.
CREATE TABLE IF NOT EXISTS CostEntry (
  costEntryId   TEXT PRIMARY KEY,
  date          TEXT NOT NULL,                  -- YYYY-MM-DD when the cost was incurred
  type          TEXT NOT NULL,                  -- references CostCategory.categoryId
  rigId         TEXT,                           -- nullable — fixed/monthly entries have no rig
  jobId         TEXT,                           -- nullable — only set for service-triggered entries (sealer, sand)
  amount        REAL NOT NULL,                  -- dollars (always set; for chlorine = gal × price/gal)
  quantity      REAL,                           -- gallons / bags / etc. — used by allocation + rate-learning
  unit          TEXT,                           -- 'gallons' | 'bags' | 'each' | NULL
  note          TEXT,
  receiptUrl    TEXT,                           -- R2 key for receipt photo (optional)
  enteredBy     TEXT,                           -- operator who logged it ('tyler' for now)
  enteredAt     TEXT NOT NULL,                  -- ISO timestamp
  modifiedAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costentry_date    ON CostEntry(date);
CREATE INDEX IF NOT EXISTS idx_costentry_type    ON CostEntry(type);
CREATE INDEX IF NOT EXISTS idx_costentry_rig     ON CostEntry(rigId);
CREATE INDEX IF NOT EXISTS idx_costentry_job     ON CostEntry(jobId);
CREATE INDEX IF NOT EXISTS idx_costentry_date_rig ON CostEntry(date, rigId);

-- ── CostCategory ─────────────────────────────────────────────────────────────
-- Closed vocabulary for CostEntry.type. `kind` groups categories in the UI.
-- Extensible: new categories ship by inserting rows here — no schema change.
CREATE TABLE IF NOT EXISTS CostCategory (
  categoryId    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                  -- display name
  kind          TEXT NOT NULL CHECK (kind IN ('per_job_variable', 'fixed_monthly', 'occasional')),
  defaultUnit   TEXT,                           -- 'gallons' | 'bags' | etc. — drives the UI quantity field
  defaultPrice  REAL,                           -- e.g. chlorine $2/gal (editable; just a seed)
  active        INTEGER NOT NULL DEFAULT 1,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costcategory_kind   ON CostCategory(kind);
CREATE INDEX IF NOT EXISTS idx_costcategory_active ON CostCategory(active);

-- Seed: per_job_variable
INSERT OR IGNORE INTO CostCategory (categoryId, name, kind, defaultUnit, defaultPrice, active, createdAt) VALUES
  ('gas',             'Gas',                   'per_job_variable', 'receipt',  NULL,  1, '2026-06-19'),
  ('chlorine',        'Chlorine',              'per_job_variable', 'gallons',  2.00,  1, '2026-06-19'),
  ('sealer',          'Sealer',                'per_job_variable', 'gallons',  NULL,  1, '2026-06-19'),
  ('polymeric_sand',  'Polymeric Sand',        'per_job_variable', 'bags',     NULL,  1, '2026-06-19'),
  ('equipment_part',  'Equipment Part',        'per_job_variable', 'each',     NULL,  1, '2026-06-19');

-- Seed: fixed_monthly
INSERT OR IGNORE INTO CostCategory (categoryId, name, kind, defaultUnit, defaultPrice, active, createdAt) VALUES
  ('rent',                'Rent',              'fixed_monthly',    NULL, 4400.00, 1, '2026-06-19'),
  ('vehicle_insurance',   'Vehicle Insurance', 'fixed_monthly',    NULL, NULL,    1, '2026-06-19'),
  ('business_insurance',  'Business Insurance','fixed_monthly',    NULL, NULL,    1, '2026-06-19'),
  ('phone',               'Phone',             'fixed_monthly',    NULL, NULL,    1, '2026-06-19'),
  ('truck_payment_1',     'Truck Payment #1',  'fixed_monthly',    NULL, NULL,    1, '2026-06-19'),
  ('truck_payment_2',     'Truck Payment #2',  'fixed_monthly',    NULL, NULL,    1, '2026-06-19');

-- Seed: occasional (Tyler's "truck" bucket — variable, not monthly)
INSERT OR IGNORE INTO CostCategory (categoryId, name, kind, defaultUnit, defaultPrice, active, createdAt) VALUES
  ('truck_rig_repair',    'Truck / Rig Repair','occasional',       NULL, NULL,    1, '2026-06-19'),
  ('tires',               'Tires',             'occasional',       NULL, NULL,    1, '2026-06-19'),
  ('registration_tags',   'Registration / Tags','occasional',      NULL, NULL,    1, '2026-06-19'),
  ('license_permit',      'License / Permit',  'occasional',       NULL, NULL,    1, '2026-06-19'),
  ('sunpass',             'SunPass / Tolls',   'occasional',       NULL, NULL,    1, '2026-06-19');

-- ── Equipment ────────────────────────────────────────────────────────────────
-- Registry of physical equipment per rig. Lifespan computed in Phase 2 from
-- Bouncie active hours on the rig over installAt → brokenAt (the seasonal
-- calendar lies — hours don't).
CREATE TABLE IF NOT EXISTS Equipment (
  equipmentId   TEXT PRIMARY KEY,
  label         TEXT NOT NULL,                  -- serial last-4 OR a free-text label
  type          TEXT NOT NULL,                  -- 'large_machine' | 'small_machine' | 'gun' | 'hose' | 'hover_cover_part' | 'ball_valve' | 'chlorine_injector' | other
  rigId         TEXT,                           -- which rig (or truck) it lives on
  installAt     TEXT NOT NULL,                  -- YYYY-MM-DD
  brokenAt      TEXT,                           -- YYYY-MM-DD when it broke (NULL = still in service)
  purchaseCost  REAL,                           -- dollars
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'broken', 'retired')),
  note          TEXT,
  createdAt     TEXT NOT NULL,
  modifiedAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_rig    ON Equipment(rigId);
CREATE INDEX IF NOT EXISTS idx_equipment_status ON Equipment(status);
CREATE INDEX IF NOT EXISTS idx_equipment_type   ON Equipment(type);
