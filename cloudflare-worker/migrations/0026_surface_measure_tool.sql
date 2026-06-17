-- Migration 0026: Surface Measure Tool — Phase 1 quoting-engine data layer
--
-- The Surface table is the ground-truth / training record: one row per
-- human-traced polygon on a property's satellite tile. Each row carries
-- enough metadata (polygon points + tile center + zoom) that the polygon
-- can be reprojected onto any future tile of the same property — that's
-- how future auto-trace and ML models will train against this dataset.
--
-- The RateCard table is the live, editable version of the rates from
-- docs/QUOTING-ENGINE.md §3. The measure UI auto-fills pricePerSqft from
-- this table when the operator picks surfaceType + material; Tyler can
-- override per-row and bulk-edit the rates here.
--
-- Phase 1 is HUMAN traces only. Auto-trace, material classification, and
-- Claude reasoning come in later phases that learn FROM this Surface
-- table. Schema reflects that: every row defaults `source = 'traced'`.
--
-- ADDITIVE ONLY. Zero behavior change on deploy. Writes added by the new
-- /admin/surface + /admin/rate-card routes in the same release.
--
-- Date: 2026-06-17

CREATE TABLE Surface (
  surfaceId      TEXT    PRIMARY KEY,
  propertyId     TEXT    NOT NULL,
  jobId          TEXT,                                  -- NULL until linked to a job
  surfaceType    TEXT    NOT NULL
                         CHECK(surfaceType IN ('driveway','patio','sidewalk','pool_deck','roof','wall','other')),
  material       TEXT
                         CHECK(material IS NULL OR material IN ('concrete','paver','rock','tile_barrel','tile_flat','shingle','metal','stucco','other')),
  polygon        TEXT,                                  -- JSON: { points:[{x,y},...], centerLat, centerLng, zoom, imgSize:[w,h] }
  sqft           REAL,
  pricePerSqft   REAL,
  price          REAL,
  source         TEXT    NOT NULL DEFAULT 'traced',     -- traced | auto | imported_csv
  tracedBy       TEXT,                                  -- operator name / source tag
  createdAt      TEXT    NOT NULL,
  modifiedAt     TEXT    NOT NULL,
  FOREIGN KEY (propertyId) REFERENCES Property(propertyId),
  FOREIGN KEY (jobId)      REFERENCES Job(jobId)
);
CREATE INDEX idx_surface_property         ON Surface(propertyId);
CREATE INDEX idx_surface_property_type    ON Surface(propertyId, surfaceType);
CREATE INDEX idx_surface_job              ON Surface(jobId);
CREATE INDEX idx_surface_type_material    ON Surface(surfaceType, material);

CREATE TABLE RateCard (
  rateCardId     TEXT    PRIMARY KEY,
  surfaceType    TEXT    NOT NULL,
  material       TEXT    NOT NULL,
  pricePerSqft   REAL    NOT NULL,
  storyModifier  REAL,                                  -- multiplier applied when Property.stories=2 for walls
  notes          TEXT,
  updatedAt      TEXT    NOT NULL,
  UNIQUE (surfaceType, material)
);
CREATE INDEX idx_ratecard_pair ON RateCard(surfaceType, material);

-- Seed: concrete driveway at $0.13/sqft per docs/QUOTING-ENGINE.md §3.
-- Other rates left empty so Tyler explicitly fills them — avoids stale
-- defaults bleeding into real quotes.
INSERT INTO RateCard (rateCardId, surfaceType, material, pricePerSqft, storyModifier, notes, updatedAt)
VALUES ('rc_driveway_concrete', 'driveway', 'concrete', 0.13, NULL, 'Seeded from docs/QUOTING-ENGINE.md §3', '2026-06-17T00:00:00Z');
