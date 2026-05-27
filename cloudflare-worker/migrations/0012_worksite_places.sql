-- Migration 0012: Add Google Places canonicalization to Job work site address.
-- workSitePlaceId: Google place_id for the work site (null for historical/manual entries).
-- workSiteGoogleVerified: 1 if captured via Places autocomplete, 0 if manually typed.
ALTER TABLE Job ADD COLUMN workSitePlaceId TEXT;
ALTER TABLE Job ADD COLUMN workSiteGoogleVerified INTEGER DEFAULT 0;
