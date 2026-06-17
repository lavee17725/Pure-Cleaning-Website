-- Migration 0023: Satellite image calibration fields
--
-- Quoting calibration requires knowing the exact scale of each saved satellite
-- image. meters_per_pixel = 156543.03 * cos(latitude) / 2^zoom — so as long as
-- zoom + center latitude are recorded at capture time, the true scale of any
-- saved image can be derived even when zoom varies across the dataset.
--
-- New columns on Property:
--   satelliteZoom         INTEGER  Google Static Maps zoom level used for fetch
--   satelliteCapturedLat  REAL     Center latitude used (= geocoded lat at capture)
--   satelliteCapturedLng  REAL     Center longitude used
--   satelliteCapturedAt   TEXT     ISO-8601 timestamp the image was written
--
-- ADDITIVE ONLY. No existing table dropped or column modified. Zero behavior
-- change on deploy — writes are added by the backfill + auto-satellite paths
-- in the same release.
--
-- Date: 2026-06-15

ALTER TABLE Property ADD COLUMN satelliteZoom        INTEGER DEFAULT NULL;
ALTER TABLE Property ADD COLUMN satelliteCapturedLat REAL    DEFAULT NULL;
ALTER TABLE Property ADD COLUMN satelliteCapturedLng REAL    DEFAULT NULL;
ALTER TABLE Property ADD COLUMN satelliteCapturedAt  TEXT    DEFAULT NULL;
