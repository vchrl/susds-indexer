-- 02: Realized APY over trailing 7-day and 30-day windows.
--
-- NOTE: src/charts.ts renders a per-day time-series VARIANT of this
-- calculation (same chi-ratio + real-seconds annualization). If you change
-- the formula here, change it there too — the copies are cross-referenced
-- but not shared.
--
-- Basis: chi growth, NOT a sum of Drip.diff. chi is the per-share
-- accumulator, so chi_end / chi_start is exactly the growth factor every
-- share experienced over the window, independent of deposits and
-- withdrawals. Summing Drip.diff instead would divide "total yield minted"
-- by an ever-changing supply — with billions flowing in and out (see
-- 03_net_flows_daily.sql), that ratio measures flow timing, not the rate
-- holders actually earned.
--
-- Annualization: realized rate compounds, so
--     APY = (chi_end / chi_start) ^ (seconds_per_year / elapsed_seconds) − 1
-- with seconds_per_year = 31,536,000 (365 days) and elapsed_seconds taken
-- from REAL block timestamps (blocks table) — the exponent is exact, not
-- estimated from block counts. Window anchors are the last drip at/before
-- (latest drip timestamp − 7d/30d). Computed via exp/ln in double
-- precision — acceptable because APY is a derived display metric, never a
-- stored amount (the repo's bigint rule applies to storage; chi stays
-- NUMERIC until the final ratio).

WITH latest AS (
    SELECT d.block_number, d.chi, b.block_timestamp AS ts
    FROM drip_events d
    JOIN blocks b USING (block_number)
    ORDER BY d.block_number DESC, d.log_index DESC
    LIMIT 1
),
windows(label, span) AS (
    VALUES ('7d', interval '7 days'), ('30d', interval '30 days')
),
anchors AS (
    SELECT w.label, w.span,
           l.block_number AS end_block,  l.chi AS end_chi,  l.ts AS end_ts,
           s.block_number AS start_block, s.chi AS start_chi, s.ts AS start_ts
    FROM windows w
    CROSS JOIN latest l
    CROSS JOIN LATERAL (
        SELECT d.block_number, d.chi, b.block_timestamp AS ts
        FROM drip_events d
        JOIN blocks b USING (block_number)
        WHERE b.block_timestamp <= l.ts - w.span
        ORDER BY d.block_number DESC, d.log_index DESC
        LIMIT 1
    ) s
)
SELECT
    label,
    start_block,
    end_block,
    round(EXTRACT(EPOCH FROM end_ts - start_ts) / 86400, 3) AS days,
    round(((end_chi / start_chi)::numeric - 1) * 100, 4)    AS window_growth_pct,
    round((
        exp( ln((end_chi / start_chi)::double precision)
             * (31536000.0 / EXTRACT(EPOCH FROM end_ts - start_ts)::double precision) ) - 1
    )::numeric * 100, 3) AS apy_pct
FROM anchors
ORDER BY span;

-- Tested 2026-07-21 against the full local index with real timestamps
-- (watermark 25,584,531):
--  label | start_block | end_block |  days  | window_growth_pct | apy_pct
--  7d    |    25534306 |  25584528 |  7.000 |            0.0679 |   3.600
--  30d   |    25369389 |  25584528 | 30.001 |            0.2911 |   3.600
-- The windows are now exactly 7.000/30.001 days by construction. Versus
-- the earlier block-count approximation, APY moved from 3.592/3.594 to
-- 3.600/3.600 (+0.6-0.8bp): the 12.068 s/block lifetime average slightly
-- overstated elapsed time in these windows, understating the rate.
-- Sanity, from this project's own measurements: the trailing week minted
-- 3.23M USDS of yield on ~4.75B TVL — 0.068%/week ≈ 3.6% annualized,
-- matching the chi-derived figure.
