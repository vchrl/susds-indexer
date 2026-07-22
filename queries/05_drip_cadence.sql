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
--   * gap length — in blocks and in REAL seconds (difference of block
--     timestamps from the blocks table; exact, not estimated);
--   * Drip.diff (exact, wei) — how much yield each drip minted, i.e. how
--     much had silently accrued by the time the window closed.
-- Gaps of 0 blocks are real: several user transactions in one block each
-- call drip(); the first mints the block's accrual, the rest emit
-- diff = 0 (same-second else-branch in SUsds.sol — the reason the schema
-- allows diff = 0).

WITH gaps AS (
    SELECT d.block_number,
           d.diff,
           d.block_number - LAG(d.block_number) OVER w AS gap_blocks,
           EXTRACT(EPOCH FROM
               b.block_timestamp - LAG(b.block_timestamp) OVER w)::bigint AS gap_s
    FROM drip_events d
    JOIN blocks b USING (block_number)
    WINDOW w AS (ORDER BY d.block_number, d.log_index)
)
SELECT
    count(*)                                                 AS drips,
    count(*) FILTER (WHERE gap_blocks = 0)                   AS same_block,
    count(*) FILTER (WHERE diff = 0)                         AS zero_diff,
    percentile_disc(0.50) WITHIN GROUP (ORDER BY gap_blocks) AS p50_gap_blocks,
    percentile_disc(0.90) WITHIN GROUP (ORDER BY gap_blocks) AS p90_gap_blocks,
    percentile_disc(0.99) WITHIN GROUP (ORDER BY gap_blocks) AS p99_gap_blocks,
    max(gap_blocks)                                          AS max_gap_blocks,
    percentile_disc(0.50) WITHIN GROUP (ORDER BY gap_s)      AS p50_gap_s,
    percentile_disc(0.90) WITHIN GROUP (ORDER BY gap_s)      AS p90_gap_s,
    percentile_disc(0.99) WITHIN GROUP (ORDER BY gap_s)      AS p99_gap_s,
    max(gap_s)                                               AS max_gap_s,
    round(percentile_disc(0.50) WITHIN GROUP (ORDER BY diff) / 1e18, 2) AS p50_diff_usds,
    round(percentile_disc(0.99) WITHIN GROUP (ORDER BY diff) / 1e18, 2) AS p99_diff_usds,
    round(max(diff) / 1e18, 2)                               AS max_diff_usds
FROM gaps
WHERE gap_blocks IS NOT NULL;

-- Tested 2026-07-21 against the full local index with real timestamps
-- (watermark 25,584,531):
--  drips          | 286157     (first drip excluded: no predecessor)
--  same_block     | 61472      (21.5% of drips share a block with the prior one)
--  zero_diff      | 61473
--  p50_gap_blocks | 6            p50_gap_s | 72      (real seconds)
--  p90_gap_blocks | 40           p90_gap_s | 492
--  p99_gap_blocks | 164          p99_gap_s | 1980
--  max_gap_blocks | 2204         max_gap_s | 26568   (~7.4 h, early quiet period)
--  p50_diff_usds  | 356.24
--  p99_diff_usds  | 7869.75
--  max_diff_usds  | 45052.67
--
-- Reading it: the median staleness window is 72 s, but the tail is long —
-- 1% of windows exceed half an hour, and the worst was 7.4 hours. The
-- median drip mints 356 USDS; the largest minted 45,052 USDS in one event.
-- Any tolerance-based reconciliation would have to absorb that entire
-- distribution; check 4 instead reproduces the extrapolation and stays
-- exact at every point of it. (Real seconds barely moved the p50/p99
-- versus the old blocks×12.068 estimate, but p90 shifted 483→492 s: the
-- percentile is now taken over actual timestamp gaps, where missed slots
-- cluster, rather than over scaled block counts.)
--
-- The zero_diff/same_block off-by-one is real and exact: drip at block
-- 20,770,669 (logIndex 240) has gap 478 blocks but diff = 0 — it ran
-- inside the vault's FIRST deposit transaction (first deposit block
-- measured during development), when totalSupply was still 0, so
-- diff = supply × Δchi / RAY = 0 despite elapsed time. Every other
-- zero-diff drip is the same-second case.
