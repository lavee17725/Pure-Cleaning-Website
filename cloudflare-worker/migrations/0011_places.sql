-- Migration 0011: Google Places API integration on Property
-- googlePlaceId already existed (cid 1, from initial schema).
-- Adding formattedAddress + googleVerified + place_id index.

ALTER TABLE Property ADD COLUMN formattedAddress TEXT;
-- Google's canonical address string: "1441 NW 10th St, Dania Beach, FL 33004, USA"
-- Used for display; overrides streetAddress/city/zip where shown.

ALTER TABLE Property ADD COLUMN googleVerified INTEGER DEFAULT 0;
-- 1 = address was selected from Places Autocomplete (place_id is canonical)
-- 0 = free-typed / legacy / fallback entry (place_id may be NULL)

CREATE INDEX IF NOT EXISTS idx_property_place_id ON Property(googlePlaceId);
-- Canonical dedup key. Two Property rows with same googlePlaceId = duplicate.
-- Migration 0011 trigger (POST /admin/properties/canonicalize-all) merges these.
