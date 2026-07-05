-- ============================================================================
-- IMPLEMENTATION HEALTH — ANALYTICAL ENGINE, AS SQL (DuckDB)
-- ============================================================================
-- This file IS the recipe. It reproduces audit/verification/engine-core.mjs
-- exactly — same rules, same rounding, same tie-breaks — so its output can be
-- diffed field-for-field against the validated engine before anything ships.
--
-- Inputs (tables created by the host before running this file):
--   records(rid, id, name, product, current_stage, po_ms, live_ms)
--     one row per implementation; rid = import row order (stable tie-break);
--     *_ms = JavaScript epoch milliseconds (the host parses dates; SQL never
--     parses a date string — that kills parser-divergence risk)
--   events(rid, stage, enter_ms, exit_ms)
--     one row per (implementation, stage) the record has touched
--   stages(ord, stage, customer_blocked)
--     the configured pipeline stages in order; terminal stage NOT included
--   cfg  (single row: every threshold from engine-config + terminal,
--         now_ms = snapshot date, period_start_ms = now - windowDays)
--   prev_scalars(record_count, open_total, total_excess, med_lead)  [0 or 1 row]
--   prev_stage(stage, wip)                                          [0+ rows]
--     the PREVIOUS import's engine snapshot (trend memory)
--
-- PARITY NOTES (all verified against official duckdb.org docs — spec §16):
-- * Percentile index floor((p/100) * n): per docs, division involving a DECIMAL
--   literal computes in floating-point and returns DOUBLE (IEEE-754) — the same
--   arithmetic JavaScript uses. Brute force (p in {50,85,95}, all n <= 200,000)
--   additionally proved JS == exact rational floor(p*n/100) at every n.
-- * NO round() anywhere: its .5 tie mode is officially undocumented. Every
--   rounding site uses floor(x + 0.5), which IS JS Math.round by definition
--   (ties and negatives included; pinned by the micro-halfday dataset).
-- * CAST(... AS BIGINT) ROUNDS per docs (never truncates); it is only ever
--   applied to already-integral floor()/ceil() outputs, where it is exact.
-- * greatest()/least() never receive NULL (their NULL handling is undocumented).
-- * Fractional thresholds (cluster_share, keep_pct, ...) arrive as DOUBLE
--   columns carrying the same IEEE-754 bits the JS engine uses.
-- * Consumers of focus/building_rows/notices MUST re-state ORDER BY — a view's
--   internal ORDER BY is only load-bearing for focus's LIMIT row-selection.
-- ============================================================================

-- ---- 1. Completed passes through each configured stage (baseline material) --
CREATE OR REPLACE VIEW durations AS
SELECT e.stage,
       floor((e.exit_ms - e.enter_ms) / 86400000.0 + 0.5) AS dur      -- days(enter, exit)
FROM events e
JOIN stages s USING (stage)                                     -- config stages only
WHERE e.enter_ms IS NOT NULL AND e.exit_ms IS NOT NULL
  AND e.exit_ms >= e.enter_ms;                                  -- backwards pairs excluded

-- ---- 2. Per-stage baseline: n completed passes, p85/p95 of their durations --
-- pctl rule (engine-exact): sorted[LEAST(n, floor((p/100.0)*n) + 1)]  (1-based)
CREATE OR REPLACE VIEW baseline AS
SELECT s.ord, s.stage, s.customer_blocked,
       count(d.dur) AS n,
       CASE WHEN count(d.dur) > 0 THEN
         (list(d.dur ORDER BY d.dur))[LEAST(count(d.dur), CAST(floor((85 / 100.0) * count(d.dur)) AS BIGINT) + 1)]
       END AS p85,
       CASE WHEN count(d.dur) > 0 THEN
         (list(d.dur ORDER BY d.dur))[LEAST(count(d.dur), CAST(floor((95 / 100.0) * count(d.dur)) AS BIGINT) + 1)]
       END AS p95
FROM stages s
LEFT JOIN durations d ON d.stage = s.stage
GROUP BY s.ord, s.stage, s.customer_blocked;

-- ---- 3. WIP census: every open record sitting in a configured stage ---------
-- age = days in stage as of the snapshot; NULL when the entry date is missing
CREATE OR REPLACE VIEW wip AS
SELECT s.stage, r.rid, r.id, r.name, r.product,
       CASE WHEN ev.enter_ms IS NOT NULL
            THEN greatest(0, floor((c.now_ms - ev.enter_ms) / 86400000.0 + 0.5))
       END AS age
FROM records r
JOIN stages s ON r.current_stage = s.stage
CROSS JOIN cfg c
LEFT JOIN events ev ON ev.rid = r.rid AND ev.stage = s.stage;

-- ---- 4. Plausibility clamp: data-error ages never drive the ranking ---------
-- bound = max(age_implausible_abs, age_implausible_mult * p95); ages past it
-- are EXCLUDED from every calculation and surfaced as a data-quality notice.
CREATE OR REPLACE VIEW clamp AS
SELECT b.stage,
       greatest(c.age_implausible_abs, c.age_implausible_mult * coalesce(b.p95, 0)) AS bound
FROM baseline b CROSS JOIN cfg c;

CREATE OR REPLACE VIEW wip_clean AS                    -- the countable WIP
SELECT w.* FROM wip w JOIN clamp cl USING (stage)
WHERE w.age IS NOT NULL AND w.age <= cl.bound;

-- ---- 5. Flow over the reporting window (event log; inclusive bounds) --------
CREATE OR REPLACE VIEW flow AS
SELECT s.stage,
       count(*) FILTER (e.enter_ms IS NOT NULL AND e.enter_ms >= c.period_start_ms AND e.enter_ms <= c.now_ms) AS arrivals,
       count(*) FILTER (e.exit_ms  IS NOT NULL AND e.exit_ms  >= c.period_start_ms AND e.exit_ms  <= c.now_ms) AS departs
FROM stages s
CROSS JOIN cfg c
LEFT JOIN events e ON e.stage = s.stage
GROUP BY s.stage;

-- ---- 6. Per-stage evaluation: every signal the verdict ladder needs ---------
CREATE OR REPLACE VIEW stage_eval AS
SELECT b.ord, b.stage, b.customer_blocked, b.n, b.p85, b.p95,
       coalesce(wc.wip, 0)               AS wip,
       coalesce(wc.missing_age, 0)       AS missing_age,
       coalesce(wc.implausible_count, 0) AS implausible_count,
       coalesce(cl2.oldest, 0)           AS oldest,
       CASE WHEN b.p85 IS NULL THEN 0 ELSE coalesce(cl2.excess, 0) END AS excess,
       CASE WHEN b.p85 IS NULL THEN 0 ELSE coalesce(cl2.c85, 0)    END AS c85,
       CASE WHEN b.p95 IS NULL THEN 0 ELSE coalesce(cl2.c95, 0)    END AS c95,
       coalesce(f.arrivals, 0) AS arrivals,
       coalesce(f.departs, 0)  AS departs,
       coalesce(f.arrivals, 0) - coalesce(f.departs, 0) AS net
FROM baseline b
LEFT JOIN (SELECT w.stage, count(*) AS wip,
                  count(*) FILTER (w.age IS NULL) AS missing_age,
                  count(*) FILTER (w.age IS NOT NULL AND w.age > cl.bound) AS implausible_count
           FROM wip w JOIN clamp cl USING (stage) GROUP BY w.stage) wc ON wc.stage = b.stage
LEFT JOIN (SELECT wc2.stage, max(wc2.age) AS oldest,
                  sum(CASE WHEN b2.p85 IS NULL THEN 0 ELSE greatest(0, wc2.age - b2.p85) END) AS excess,
                  count(*) FILTER (wc2.age > b2.p85) AS c85,
                  count(*) FILTER (wc2.age > b2.p95) AS c95
           FROM wip_clean wc2 JOIN baseline b2 ON b2.stage = wc2.stage
           GROUP BY wc2.stage) cl2 ON cl2.stage = b.stage
LEFT JOIN flow f ON f.stage = b.stage;

-- ---- 7. THE VERDICT LADDER (deterministic priority; never averaged) ---------
-- Checked strictly in this order; the first rule that fires names the stage.
CREATE OR REPLACE VIEW verdicts AS
SELECT e.*,
  CASE
    -- 0. Not enough completed history for a baseline: no verdict at all
    WHEN e.n < c.min_history THEN 'no-history'
    -- 1. AGING: material stuck work (>=1 item past p95 AND (overdue-days >= floor
    --    OR oldest >= 1.25x p95)) OR a material cluster (wip>=4, >30% past p85,
    --    overdue-days >= floor)
    WHEN (e.c95 >= c.stuck_min_count
          AND (e.excess >= c.aging_excess
               OR (e.p95 IS NOT NULL AND e.oldest >= c.aging_oldest_mult * e.p95)))
      OR (e.wip >= c.cluster_min_wip
          AND e.c85 > c.cluster_share * e.wip
          AND e.excess >= c.aging_excess) THEN 'aging'
    -- 2. BACKLOG BUILDING: net inflow >= max(abs floor, 25% of WIP)
    WHEN e.net >= greatest(c.build_abs, CAST(ceil(c.build_pct * greatest(e.wip, 1)) AS BIGINT)) THEN 'building'
    -- 3a. WATCH: something is far past typical but not yet material
    WHEN e.c95 >= c.stuck_min_count THEN 'watch'
    -- 3b. STALLED: work sits, nothing arrived or left all window, oldest >= 45d
    WHEN e.wip > 0 AND e.arrivals = 0 AND e.departs = 0 AND e.oldest >= c.stagnation_days THEN 'stalled'
    -- 4. CLEARING: net outflow at least the building floor
    WHEN e.net <= -c.build_abs THEN 'clearing'
    -- 5. STEADY: everything else
    ELSE 'steady'
  END AS key
FROM stage_eval e CROSS JOIN cfg c;

CREATE OR REPLACE VIEW verdict_words AS
SELECT v.*, CASE v.key
  WHEN 'aging' THEN 'Aging'                WHEN 'building' THEN 'Backlog building'
  WHEN 'watch' THEN 'Watch'                WHEN 'stalled' THEN 'Stalled'
  WHEN 'clearing' THEN 'Clearing'          WHEN 'steady' THEN 'Steady'
  WHEN 'no-history' THEN 'Not enough history' END AS verdict
FROM verdicts v;

-- ---- 8. Severity ranking: the focus list ------------------------------------
-- Rank by overdue customer-days (excess), biggest first; JS sort is stable so
-- equal excess keeps pipeline order -> tie-break on ord. Capped at focus_cap.
CREATE OR REPLACE VIEW focus AS
SELECT v.* FROM verdict_words v CROSS JOIN cfg c
WHERE v.excess > 0
ORDER BY v.excess DESC, v.ord ASC
LIMIT (SELECT focus_cap FROM cfg);

CREATE OR REPLACE VIEW building_rows AS                 -- capacity story, not stuck
SELECT v.* FROM verdict_words v
WHERE v.key = 'building'
ORDER BY v.net DESC, v.ord ASC;

-- ---- 9. Delivery speed (lagging confirmation): PO -> live, window go-lives --
CREATE OR REPLACE VIEW leads AS
SELECT floor((r.live_ms - r.po_ms) / 86400000.0 + 0.5) AS lead
FROM records r CROSS JOIN cfg c
WHERE r.live_ms IS NOT NULL AND r.live_ms >= c.period_start_ms AND r.live_ms <= c.now_ms
  AND r.po_ms IS NOT NULL;

-- ---- 10. Executive rollup: one row of everything the exec band needs --------
CREATE OR REPLACE VIEW exec_band AS
WITH tot AS (
  SELECT sum(excess) AS total_excess,
         sum(arrivals) AS arrivals, sum(departs) AS departs,
         count(*) FILTER (key = 'building') AS building_count,
         count(*) FILTER (n >= (SELECT min_history FROM cfg)) AS history_sufficient
  FROM verdicts
),
conc AS (          -- concentration: the top concentration_top_n of the focus list
  SELECT coalesce(sum(excess), 0) AS top_excess
  FROM (SELECT excess FROM focus LIMIT (SELECT concentration_top_n FROM cfg))
),
opens AS (
  SELECT count(*) FILTER (coalesce(r.current_stage, '') <> c.terminal) AS open_total
  FROM records r CROSS JOIN cfg c
),
speed AS (
  SELECT count(*) AS n_leads,
         CASE WHEN count(*) > 0 THEN
           (list(lead ORDER BY lead))[LEAST(count(*), CAST(floor((50 / 100.0) * count(*)) AS BIGINT) + 1)]
         END AS med_lead
  FROM leads
),
gl AS (
  SELECT count(*) AS go_lives FROM records r CROSS JOIN cfg c
  WHERE r.live_ms IS NOT NULL AND r.live_ms >= c.period_start_ms AND r.live_ms <= c.now_ms
),
pv AS (SELECT * FROM prev_scalars LIMIT 1)
SELECT
  o.open_total,
  (SELECT open_total FROM pv)                                   AS prev_open,
  CASE WHEN (SELECT open_total FROM pv) IS NOT NULL
       THEN o.open_total - (SELECT open_total FROM pv) END      AS open_delta,
  coalesce(t.total_excess, 0)                                   AS total_excess,
  (SELECT total_excess FROM pv)                                 AS prev_excess,
  CASE WHEN coalesce(t.total_excess, 0) > 0
       THEN floor(100.0 * conc.top_excess / t.total_excess + 0.5)
       ELSE 0 END                                               AS concentration_pct,
  coalesce(t.arrivals, 0) AS arrivals, coalesce(t.departs, 0) AS departs,
  -- intake state: |in-out| within max(keep_abs, keep_pct * arrivals) = keeping pace
  CASE WHEN abs(coalesce(t.arrivals, 0) - coalesce(t.departs, 0))
            <= greatest(c.keep_abs, c.keep_pct * coalesce(t.arrivals, 0)) THEN 'keeping-pace'
       WHEN coalesce(t.arrivals, 0) - coalesce(t.departs, 0) > 0 THEN 'behind'
       ELSE 'catching-up' END                                   AS intake_state,
  -- systemic: an inflow surge across many stages is one story, not N fires
  CASE WHEN t.building_count >= c.collapse_n THEN 'intake-surge' END AS systemic,
  g.go_lives, s.med_lead,
  -- speed state vs the previous import's median lead (JS `prevLead || 1` quirk:
  -- a prev median of 0 uses 1 as the percentage base)
  CASE WHEN s.med_lead IS NULL OR (SELECT med_lead FROM pv) IS NULL THEN 'n/a'
       WHEN abs(s.med_lead - (SELECT med_lead FROM pv))
            <= greatest(c.speed_abs, c.speed_pct * (CASE WHEN coalesce((SELECT med_lead FROM pv), 0) = 0
                                                         THEN 1 ELSE (SELECT med_lead FROM pv) END))
            THEN 'about-the-same'
       WHEN s.med_lead < (SELECT med_lead FROM pv) THEN 'faster'
       ELSE 'slower' END                                        AS speed_state,
  t.history_sufficient
FROM opens o, tot t, conc, speed s, gl g, cfg c;

-- ---- 11. Data-quality guard (symmetric; never silently drops) ---------------
-- Emitted in the engine's exact order: count-swing, stage collapses (pipeline
-- order), then per-stage implausible-age / missing-timestamps (pipeline order).
CREATE OR REPLACE VIEW notices AS
SELECT * FROM (
  SELECT 0 AS pri, -1 AS ord, 0 AS sub, 'count-swing' AS type, NULL AS stage
  FROM cfg c, prev_scalars p, (SELECT count(*) AS n FROM records) r
  WHERE p.record_count IS NOT NULL AND p.record_count <> 0
    AND abs(r.n - p.record_count) / CAST(p.record_count AS DOUBLE) > c.count_swing
  UNION ALL
  SELECT 1, v.ord, 0, 'stage-collapse', v.stage
  FROM verdicts v JOIN prev_stage p ON p.stage = v.stage CROSS JOIN cfg c
  WHERE p.wip >= c.collapse_wip_floor AND v.wip <= p.wip * (1 - c.stage_collapse)
  UNION ALL
  SELECT 2, v.ord, 0, 'implausible-age', v.stage FROM verdicts v WHERE v.implausible_count > 0
  UNION ALL
  SELECT 2, v.ord, 1, 'missing-timestamps', v.stage FROM verdicts v WHERE v.missing_age > 0
) ORDER BY pri, ord, sub;

-- ---- 12. Drill-down: the named records behind a stage, oldest first ---------
-- (clamp-aware: an implausible age never appears here either)
CREATE OR REPLACE VIEW items AS
SELECT stage,
       CASE WHEN name IS NULL OR name = '' THEN id ELSE name END AS name,
       product, age,
       row_number() OVER (PARTITION BY stage ORDER BY age DESC, rid ASC) AS pos
FROM wip_clean;
