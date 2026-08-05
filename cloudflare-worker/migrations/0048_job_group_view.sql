-- 0048: JobGroup — ONE definition of "what is this job group worth"
--
-- Four call sites computed this independently (scheduledStatus builder, trends,
-- monthly-breakdown, comped-summary) and had already drifted: July 2026 read
-- $29,275.03 / 53 jobs on one board and $30,150.03 / 56 on another. Three
-- separate causes, including a NULL-unsafe `isRigSegment = 0` that would
-- silently drop a child from its parent's total, and a comped filter that
-- reached one query and not the other six hours after it was written.
--
-- A view is a definition the database enforces, not a convention four call
-- sites have to remember.
--
-- WHAT A GROUP IS: a head row — not a rig segment, not a day-child. Its worth
-- is its own amount plus its non-cancelled day-children. Rig segments are $0
-- attribution markers and never contribute (DL-06); day-children carry the
-- slices of a multi-day job whose parent row holds only Day 1.
--
-- WHAT THIS VIEW DELIBERATELY DOES NOT DO: filter. Whether to INCLUDE a group
-- — state, priceMode, date window, source — stays at each call site, because
-- those genuinely differ by question. Conflating "what is it worth" with "does
-- it count" is exactly how monthly-breakdown ended up reporting scheduled work
-- as revenue.

DROP VIEW IF EXISTS JobGroup;

CREATE VIEW JobGroup AS
SELECT
  j.jobId                                          AS jobId,
  j.payerId                                        AS payerId,
  j.scheduledDate                                  AS scheduledDate,
  j.state                                          AS state,
  j.priceMode                                      AS priceMode,
  j.source                                         AS source,
  COALESCE(j.amount, 0)                            AS parentAmount,
  -- The rollup. COALESCE on isRigSegment is load-bearing: `isRigSegment = 0`
  -- evaluates to NULL (not true) for a NULL flag, silently dropping that child.
  (COALESCE(j.amount, 0) + COALESCE((
     SELECT SUM(c.amount) FROM Job c
      WHERE c.parentJobId = j.jobId
        AND c.state != 'cancelled'
        AND COALESCE(c.isRigSegment, 0) = 0
  ), 0))                                           AS groupAmount,
  (SELECT COUNT(*) FROM Job d
    WHERE d.parentJobId = j.jobId
      AND COALESCE(d.isRigSegment, 0) = 0)         AS dayChildCount,
  (SELECT COUNT(*) FROM Job s
    WHERE s.parentJobId = j.jobId
      AND s.isRigSegment = 1)                      AS rigSegCount
FROM Job j
WHERE COALESCE(j.isRigSegment, 0) = 0
  AND j.parentJobId IS NULL;
