-- Migration 0044: Quote.customerType — pick Residential / Partner / Commercial
-- at Log Quote time so the booking hand-off opens on the right flow.
--
-- Extends the EXISTING concept (Person.customerType, same three values) rather
-- than introducing a parallel one. Quote rows created before this migration
-- read as 'residential', which is what they were.
--
-- Downstream this only steers: the hand-off target, the type stamped on a
-- newly-created Person, and the Quote Pool insights split. Pricing, print,
-- driver text, invoicing, reactivation and review requests are unchanged —
-- they already branch off Person.customerType.

ALTER TABLE Quote ADD COLUMN customerType TEXT NOT NULL DEFAULT 'residential'
  CHECK(customerType IN ('residential','partner_referral','commercial'));

CREATE INDEX IF NOT EXISTS idx_quote_customertype ON Quote(customerType);
