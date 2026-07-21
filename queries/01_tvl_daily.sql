-- 01: Daily TVL (total value locked) in USDS.
--
-- TVL at a moment = share supply × chi at that moment, taken here at each
-- day's LAST Drip event. It is deliberately NOT a running sum of deposits
-- minus withdrawals: that sum misses yield entirely. Value accrues to
-- holders via chi rising, not via new deposits — over this dataset the gap
-- is ~3.6M USDS of minted yield (see drip_events.diff) that a
-- is 263,444,920 USDS of minted yield (SUM(drip_events.diff) over the full
-- index) that a deposit-sum would silently omit.
--
-- Correctness of the calculation:
--   * share supply at any (block, log_index) is the exact cumulative sum of
--     Deposit.shares − Withdraw.shares up to that point (verified == on-chain
--     totalSupply() to the wei; reconciliation check 1);
--   * chi at the day's last Drip is the exact stored accumulator at that
--     point (verified == chi(); check 2);
--   * floor(supply × chi / 1e27) is the contract's own convertToAssets
--     rounding, so each row is what totalAssets() returned at that drip.
--
-- APPROXIMATION NOTE (bucketing only, not values): event rows carry
-- block_number, not timestamps. Days are approximated as 7159-block
-- buckets from the measured average of 12.068 s/block between two
-- timestamped anchors of this project (block 20,777,433 @ 1726661999 and
-- block 25,583,193 @ 1784662103). Bucket EDGES can therefore drift by
-- minutes against calendar days; every VALUE inside a row is exact.

WITH ledger AS (
    SELECT block_number, log_index, shares  AS share_delta, NULL::numeric AS chi
    FROM deposit_events
    UNION ALL
    SELECT block_number, log_index, -shares, NULL::numeric
    FROM withdraw_events
    UNION ALL
    SELECT block_number, log_index, 0, chi
    FROM drip_events
),
running AS (
    SELECT block_number, log_index, chi,
           SUM(share_delta) OVER (ORDER BY block_number, log_index) AS supply
    FROM ledger
),
day_last_drip AS (
    SELECT DISTINCT ON ((block_number - 20677434) / 7159)
           (block_number - 20677434) / 7159 AS day_idx,
           block_number, supply, chi
    FROM running
    WHERE chi IS NOT NULL
    ORDER BY (block_number - 20677434) / 7159, block_number DESC, log_index DESC
)
SELECT
    -- display-only date, reconstructed from the measured anchor
    to_timestamp(1726661999 + (block_number - 20777433) * 12.068872)::date
        AS approx_date,
    block_number                                   AS at_block,
    round(supply / 1e18, 0)                        AS supply_susds,
    floor(supply * chi / power(10::numeric, 27))   AS tvl_wei,
    round(floor(supply * chi / power(10::numeric, 27)) / 1e18, 0) AS tvl_usds
FROM day_last_drip
ORDER BY day_idx;

-- Tested 2026-07-21 against the full local index (watermark 25,583,193).
-- 674 rows. Actual first/last rows:
--  approx_date | at_block | supply_susds |  tvl_usds
--  2024-09-17  | 20770191 |            0 |          0
--  2024-09-18  | 20777643 |        10871 |      10873
--  2024-09-19  | 20784407 |      9588800 |    9591965
--  ...
--  2026-07-20  | 25574185 |   4306655464 | 4752862999
--  2026-07-21  | 25581348 |   4304740884 | 4751209765
--  2026-07-21  | 25583185 |   4304716998 | 4751301181
-- Cross-checks: final supply 4,304,716,998 sUSDS equals the reconciled
-- on-chain totalSupply() (check 1, 0 wei). Final TVL 4,751,301,181 is
-- totalAssets() AS OF the last drip (block 25,583,185); the reconciled
-- totalAssets() at the watermark 8 blocks later is 4,751,302,410 — the
-- difference is post-drip accrual, i.e. exactly the staleness quantified
-- in 05_drip_cadence.sql. The duplicated approx_date on the last two rows
-- is the documented bucket-edge drift, visible in practice.
