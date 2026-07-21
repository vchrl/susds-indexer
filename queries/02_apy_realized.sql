-- 02: Realized APY over trailing 7-day and 30-day windows.
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
-- with seconds_per_year = 31,536,000 (365 days). Computed via exp/ln in
-- double precision — acceptable here because APY is a derived display
-- metric, never a stored amount (the repo's bigint rule applies to
-- storage; chi itself stays NUMERIC until the final ratio).
--
-- APPROXIMATION NOTE: the schema stores block numbers, not timestamps, so
-- elapsed_seconds = elapsed_blocks × 12.068872 s/block — the measured
-- average between this project's two timestamped anchors (block 20,777,433
-- @ 1726661999, block 25,583,193 @ 1784662103). Window edges land on the
-- nearest drip at/before the target block. Error from block-time variance
-- over ≥7-day windows is well under 0.1% relative — it shifts the exponent,
-- not the exactly-known chi ratio.

WITH latest AS (
    SELECT block_number, chi
    FROM drip_events
    ORDER BY block_number DESC, log_index DESC
    LIMIT 1
),
windows(label, blocks_back) AS (
    VALUES ('7d', 7159 * 7), ('30d', 7159 * 30)
),
anchors AS (
    SELECT w.label,
           w.blocks_back,
           l.block_number AS end_block,
           l.chi          AS end_chi,
           d.block_number AS start_block,
           d.chi          AS start_chi
    FROM windows w
    CROSS JOIN latest l
    CROSS JOIN LATERAL (
        SELECT block_number, chi
        FROM drip_events
        WHERE block_number <= l.block_number - w.blocks_back
        ORDER BY block_number DESC, log_index DESC
        LIMIT 1
    ) d
)
SELECT
    label,
    start_block,
    end_block,
    round((end_block - start_block) * 12.068872 / 86400, 2) AS approx_days,
    round(((end_chi / start_chi)::numeric - 1) * 100, 4)    AS window_growth_pct,
    round((
        exp( ln((end_chi / start_chi)::double precision)
             * (31536000.0 / ((end_block - start_block) * 12.068872)) ) - 1
    )::numeric * 100, 3) AS apy_pct
FROM anchors
ORDER BY blocks_back;

-- Tested 2026-07-21 against the full local index (watermark 25,583,193):
--  label | start_block | end_block | approx_days | window_growth_pct | apy_pct
--  7d    |    25533063 |  25583185 |        7.00 |            0.0677 |   3.592
--  30d   |    25368415 |  25583185 |       30.00 |            0.2906 |   3.594
-- Sanity, from this project's own measurements: the trailing week minted
-- 3.23M USDS of yield (sum of Drip.diff over the last ~50,400 blocks,
-- measured during development) on ~4.75B TVL — 0.068%/week, which
-- annualizes to ~3.6%, matching the chi-derived figure. 7d and 30d agree
-- to 0.2bp, consistent with a stable rate over the trailing month.
