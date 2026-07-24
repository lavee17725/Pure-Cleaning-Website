-- Migration 0041: Job.priceTbd — "priced after the job" bookings
--
-- Some long-trusted customers (e.g. Steve Wenner, booked 7/28) are priced
-- AFTER completion — the customer trusts the price and full scope isn't known
-- until the work is done. TBD is the ABSENCE of a price, NOT $0 (T1.21 honesty):
-- amount stays NULL and priceTbd=1. A TBD job books/schedules normally, displays
-- as "TBD" everywhere (never $0, never a broken blank), contributes 0 to day/rig
-- money math but is COUNTED separately ("+N TBD") so totals are never silently
-- understated, and must be priced at/after completion before it can flow into
-- jobHistory / lifetimeSpend / receipts. Setting a real amount clears the flag.
--
-- Boolean stored as INTEGER (D1/SQLite convention, mirrors isMultiDayParent etc.).
--
-- ADDITIVE ONLY. New nullable column, default 0 = every existing job is
-- normally-priced (byte-identical behavior). Snapshot via POST /import/snapshot
-- taken before this ran.
--
-- Date: 2026-07-24

ALTER TABLE Job ADD COLUMN priceTbd INTEGER DEFAULT 0;
