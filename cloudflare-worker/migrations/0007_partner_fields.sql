-- Migration 0007: Referral Partner fields
ALTER TABLE Person ADD COLUMN customerType TEXT DEFAULT 'residential';
ALTER TABLE Person ADD COLUMN partnerNotes TEXT;
ALTER TABLE Job ADD COLUMN workSiteAddress TEXT;
ALTER TABLE Job ADD COLUMN workSiteCity TEXT;
ALTER TABLE Job ADD COLUMN workSiteZip TEXT;
ALTER TABLE Job ADD COLUMN endCustomerName TEXT;
ALTER TABLE Job ADD COLUMN endCustomerPhone TEXT;
ALTER TABLE Job ADD COLUMN partnerRate REAL;
