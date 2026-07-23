-- Migration 0039: Quote table — the digital yellow pad
--
-- Darla logs every phone quote on a paper yellow pad; only quotes that
-- convert ever entered the CRM, so acceptance rate / quote volume / price
-- elasticity were invisible (survivorship bias in all pricing data).
-- This table is the pad: one row per phone quote, in timestamp order,
-- captured in ~15 seconds mid-call. Enrichment (address, roof, sq ft)
-- happens ONLY on accept, via the existing booking flow — never here.
--
-- D1 is canonical (DL-09); NO KV mirror — nothing downstream consumes
-- this yet, and the insights tab reads D1 directly.
--
-- personId is set on accept-conversion when the booking-flow save creates
-- (or matches) the Person — 'accepted' with personId NULL = "accepted,
-- not yet booked" (surfaced in the pool so it can't silently vanish).
-- phone is digits-only 10 (KV convention, NOT E.164 — Rule 17 does not
-- apply: this row predates the Person and joins via _d1PersonId at link
-- time, never by string-comparing primaryPhone).
--
-- declineReason 'price'/'not_now' rows are the future reactivation feed
-- ("we quoted your driveway in July" angles) — queryable now, cadence
-- wiring deliberately out of scope.
--
-- ADDITIVE ONLY. No existing table changed. Snapshot via
-- POST /import/snapshot taken before this ran.
--
-- Date: 2026-07-23

CREATE TABLE Quote (
  quoteId       TEXT    PRIMARY KEY,
  createdAt     TEXT    NOT NULL,                 -- ISO; yellow-pad order
  quotedBy      TEXT,                             -- 'darla' | 'tyler' | 'tony'
  firstName     TEXT,
  lastName      TEXT,
  phone         TEXT    NOT NULL,                 -- digits-only 10; dedupe/join key
  city          TEXT,
  services      TEXT,                             -- JSON array of chip keys
  priceQuoted   REAL,
  status        TEXT    NOT NULL DEFAULT 'quoted'
                        CHECK(status IN ('quoted','accepted','declined')),
  declineReason TEXT    CHECK(declineReason IN ('price','competitor','not_now','ghost') OR declineReason IS NULL),
  resolvedAt    TEXT,                             -- when accepted/declined was marked
  personId      TEXT,                             -- FK Person, set on accept-conversion
  notes         TEXT,
  source        TEXT    DEFAULT 'phone',          -- future-proofs web-form quotes
  modifiedAt    TEXT    NOT NULL,
  FOREIGN KEY (personId) REFERENCES Person(personId)
);
CREATE INDEX idx_quote_status_created ON Quote(status, createdAt);
CREATE INDEX idx_quote_phone          ON Quote(phone);
