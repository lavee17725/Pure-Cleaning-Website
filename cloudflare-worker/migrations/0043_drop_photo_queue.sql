-- Migration 0043: drop PhotoQueue — the M/W/F GBP photo pipeline is retired.
--
-- WHY: Google deprecated the photo-upload API for standard Business Profiles,
-- so the pipeline could never do the one thing it was built for (auto-post).
-- Everything downstream of tagging was manual, and Tyler dropped it 2026-07-31.
--
-- Removed alongside this table: /admin/photo-queue/* routes, the scheduler +
-- posting card handlers, the nightly schedule cron, the tagging page and its
-- hub tile, photo:scan / photo:thumb / photo:prep, and the pure-cleaning-gbp-photos
-- R2 bucket binding.
--
-- DATA: 1,536 rows at drop time — 1,509 untagged (filename records only), 7
-- queued (tagged + captioned + scheduled, never posted), 20 skipped. The 27
-- rows holding actual human decisions are archived verbatim in
-- snapshots/photoqueue_final_2026-07-31.md, and a full KV snapshot was taken
-- immediately before (customer_db_backup_2026-07-31T19-49-23).
--
-- NOT AFFECTED: website-assets/ (Tyler's ~5.5GB of source photos on his Mac)
-- and the crew/job photo system (env.PHOTOS R2, /photos, /admin/photos/*,
-- Job.photoKeys, Property.photoKeys) — a separate system that stays live.

DROP INDEX IF EXISTS idx_photoq_pair;
DROP INDEX IF EXISTS idx_photoq_scheduled;
DROP INDEX IF EXISTS idx_photoq_status;
DROP TABLE IF EXISTS PhotoQueue;
