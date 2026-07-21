-- 05: Drip cadence — gaps between consecutive Drip events, and the size of
-- the un-dripped accrual window each gap represents.
--
-- Why this matters: between two drips, the contract's totalAssets() keeps
-- extrapolating chi forward while the event stream stands still. The gap
-- distribution below IS the staleness that makes "compare event sums to
-- totalAssets() with a tolerance" unworkable, and that reconciliation
-- check 4 solves by replicating the extrapolation (this project measured
-- the un-dripped term at 255.77 USDS after a 48 s gap and 511.54 USDS
-- after 96 s at ~4.75B TVL).
--
-- Two distributions, one query:
--   * gap length (blocks exactly; seconds approximately) — how long the
--     window stays stale;
--   * Drip.diff (exact, wei) — how much yield each drip minted, i.e. how
--     much had silently accrued by the time the window closed.
-- Gaps of 0 blocks are real: several user transactions in one block each
-- call drip(); the first mints the block's accrual, the rest emit
-- diff = 0 (same-second else-branch in SUsds.sol — the reason the schema
-- allows diff = 0).
--
-- APPROXIMATION NOTE: seconds = blocks × 12.068872 (measured average, see
-- 01_tvl_daily.sql). Block gaps themselves are exact.

WITH gaps AS (
    SELECT block_number,
           diff,
           block_number - LAG(block_number)
               OVER (ORDER BY block_number, log_index) AS gap_blocks
    FROM drip_events
)
SELECT
    count(*)                                              AS drips,
    count(*) FILTER (WHERE gap_blocks = 0)                AS same_block,
    count(*) FILTER (WHERE diff = 0)                      AS zero_diff,
    percentile_disc(0.50) WITHIN GROUP (ORDER BY gap_blocks) AS p50_gap_blocks,
    percentile_disc(0.90) WITHIN GROUP (ORDER BY gap_blocks) AS p90_gap_blocks,
    percentile_disc(0.99) WITHIN GROUP (ORDER BY gap_blocks) AS p99_gap_blocks,
    max(gap_blocks)                                       AS max_gap_blocks,
    round(percentile_disc(0.50) WITHIN GROUP (ORDER BY gap_blocks) * 12.068872) AS p50_gap_s,
    round(percentile_disc(0.99) WITHIN GROUP (ORDER BY gap_blocks) * 12.068872) AS p99_gap_s,
    round(max(gap_blocks) * 12.068872)                    AS max_gap_s,
    round(percentile_disc(0.50) WITHIN GROUP (ORDER BY diff) / 1e18, 2) AS p50_diff_usds,
    round(percentile_disc(0.99) WITHIN GROUP (ORDER BY diff) / 1e18, 2) AS p99_diff_usds,
    round(max(diff) / 1e18, 2)                            AS max_diff_usds
FROM gaps
WHERE gap_blocks IS NOT NULL;

-- Tested 2026-07-21 against the full local index (watermark 25,583,193):
--  drips          | 286104     (first drip excluded: no predecessor)
--  same_block     | 61467      (21.5% of drips share a block with the prior one)
--  zero_diff      | 61468
--  p50_gap_blocks | 6          -> p50_gap_s  ~72
--  p90_gap_blocks | 40
--  p99_gap_blocks | 164        -> p99_gap_s  ~1979 (~33 min)
--  max_gap_blocks | 2204       -> max_gap_s  ~26600 (~7.4 h, early quiet period)
--  p50_diff_usds  | 356.22
--  p99_diff_usds  | 7867.75
--  max_diff_usds  | 45052.67
--
-- Reading it: the median staleness window is ~72 s, but the tail is long —
-- 1% of windows exceed half an hour, and the worst was 7.4 hours. The
-- median drip mints 356 USDS; the largest minted 45,052 USDS in one event.
-- Any tolerance-based reconciliation would have to absorb that entire
-- distribution; check 4 instead reproduces the extrapolation and stays
-- exact at every point of it.
--
-- The zero_diff/same_block off-by-one is real and exact: drip at block
-- 20,770,669 (logIndex 240) has gap 478 blocks but diff = 0 — it ran
-- inside the vault's FIRST deposit transaction (first deposit block
-- measured during development), when totalSupply was still 0, so
-- diff = supply × Δchi / RAY = 0 despite elapsed time. Every other
-- zero-diff drip is the same-second case.
