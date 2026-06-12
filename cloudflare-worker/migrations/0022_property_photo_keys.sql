-- Migration 0022: Property.photoKeys — multi-photo R2 reference array
--
-- Mirrors the Job.photoKeys pattern from migration 0019, but on Property
-- instead of Job. Used by the public quote-form lead-capture photos
-- (uploaded to R2 quote-leads/{leadId}/...) which migrate to property/{id}/
-- on lead→customer conversion via /admin/quote-photo-connect.
--
-- One column:
--   Property.photoKeys — JSON array of R2 keys for the property
--                        e.g. ["property/{propertyId}/lead_1718000001_0.jpg",
--                              "property/{propertyId}/lead_1718000001_1.jpg"]
--
-- ADDITIVE ONLY. No existing table dropped or column modified. Zero behavior
-- change for existing reads. Same storage tier (env.PHOTOS R2 bucket).
--
-- Deployed inside the Rule-15 cutover window alongside migration 0021.
--
-- Date: 2026-06-12

ALTER TABLE Property ADD COLUMN photoKeys TEXT DEFAULT NULL;
