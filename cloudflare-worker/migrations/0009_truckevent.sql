-- Migration 0009: TruckEvent table — Bouncie full event stream persistence
-- Every truck movement captured: drive segments, job arrivals, POI stops, home base.
-- Foundation for: ML quoting, schedule density optimization, real labor cost analysis.
-- Source: Bouncie Full Event Stream doc (10Qeyqs1TRufTpOxSxbwpuwU240GfL-9J)

CREATE TABLE IF NOT EXISTS TruckEvent (
  id               TEXT    NOT NULL PRIMARY KEY,
  rigId            TEXT    NOT NULL,
  eventType        TEXT    NOT NULL,  -- 'depart_home'|'arrive_home'|'drive'|'job_arrival'|'poi_stop'|'unknown_stop'
  startedAt        TEXT    NOT NULL,
  endedAt          TEXT,
  durationSeconds  INTEGER,
  startLat         REAL,
  startLng         REAL,
  endLat           REAL,
  endLng           REAL,
  distanceMiles    REAL,
  jobId            TEXT,              -- FK → Job.jobId (only for job_arrival events)
  poiCategory      TEXT,              -- 'gas'|'chemicals'|'lunch'|'home_base'|null
  poiName          TEXT,
  source           TEXT    NOT NULL,  -- 'bouncie_cron'|'bouncie_backfill'|'manual'
  bouncieTripId    TEXT,              -- synthetic: '{rigId}-drive-{startTime}' for drive events
  matchConfidence  TEXT,
  createdAt        TEXT    NOT NULL,
  modifiedAt       TEXT    NOT NULL,
  FOREIGN KEY (jobId) REFERENCES Job(jobId)
);

-- Primary access pattern: rig × date range (route playback, nightly cron dedup)
CREATE INDEX IF NOT EXISTS idx_truckevent_rig_date  ON TruckEvent(rigId, startedAt);

-- Job linkage: find drive times surrounding a specific job
CREATE INDEX IF NOT EXISTS idx_truckevent_job        ON TruckEvent(jobId);

-- Type + date: find all drive segments in a window, all POI stops, etc.
CREATE INDEX IF NOT EXISTS idx_truckevent_type_date  ON TruckEvent(eventType, startedAt);
