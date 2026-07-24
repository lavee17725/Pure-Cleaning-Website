-- Migration 0042: PhotoQueue — M/W/F GBP photo prep pipeline
--
-- Tyler has ~5.5GB of job photos (local, gitignored website-assets/). Every
-- Mon/Wed/Fri a photo (or before/after pair) should be ready to post to the
-- Google Business Profile with an SEO filename, geotag, and crawlable caption.
-- GBP deprecated photo-upload API for standard profiles, so this is a PREP
-- QUEUE with one-tap manual posting (a third-party scheduler can be swapped in
-- later behind one seam — see docs).
--
-- FLOW: local `npm run photo:scan` registers new files (idempotent on photoId =
-- hash of the source path, so a rescan never re-adds an existing row and never
-- disturbs its status). Tyler tags city/service/type via the web grid. The
-- scheduler assigns tagged photos to upcoming M/W/F slots. `npm run photo:prep`
-- generates the processed copy (HEIC→JPG, geotag, SEO filename) → R2. The
-- posting card (Reviews Hub) shows it for the one-tap post.
--
-- status: untagged → queued (tagged + scheduled) → posted | skipped.
-- posted/skipped NEVER re-enter rotation (the queue always knows what's fresh).
--
-- D1 canonical (Rule 19). photoId deterministic (path hash) so scan is a pure
-- upsert-if-absent. No KV mirror — nothing else consumes this.
--
-- ADDITIVE ONLY. New table. Snapshot via POST /import/snapshot taken before.
-- Date: 2026-07-24

CREATE TABLE PhotoQueue (
  photoId      TEXT PRIMARY KEY,               -- deterministic hash of sourcePath
  sourcePath   TEXT NOT NULL,                  -- relative path under website-assets/
  status       TEXT NOT NULL DEFAULT 'untagged'
               CHECK(status IN ('untagged','queued','posted','skipped')),
  city         TEXT,                           -- tagged (GPS unreliable post-Drive → manual)
  service      TEXT,                           -- roof | driveway | patio | seal | house | ...
  photoType    TEXT DEFAULT 'general'          -- before | after | pair | general
               CHECK(photoType IN ('before','after','pair','general')),
  pairId       TEXT,                           -- links a before/after pair
  scheduledFor TEXT,                           -- YYYY-MM-DD M/W/F slot
  caption      TEXT,                           -- editable SEO caption
  seoFilename  TEXT,                           -- {service}-{city}-fl-pure-cleaning-{date}.jpg
  processedKey TEXT,                           -- R2 key of the prepped copy (set by photo:prep)
  batchDate    TEXT,                           -- inferred from drive-download folder / EXIF (recency)
  ext          TEXT,                           -- heic | jpg | png (drives HEIC conversion)
  postedAt     TEXT,
  createdAt    TEXT NOT NULL,
  modifiedAt   TEXT NOT NULL
);
CREATE INDEX idx_photoq_status    ON PhotoQueue(status);
CREATE INDEX idx_photoq_scheduled ON PhotoQueue(scheduledFor);
CREATE INDEX idx_photoq_pair      ON PhotoQueue(pairId);
