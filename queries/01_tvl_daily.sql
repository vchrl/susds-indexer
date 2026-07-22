-- 01: Daily TVL (total value locked) in USDS.
--
-- TVL at a moment = share supply × chi at that moment, taken here at each
-- day's LAST Drip event. It is deliberately NOT a running sum of deposits
-- minus withdrawals: that sum misses yield entirely. Value accrues to
-- holders via chi rising, not via new deposits — over this dataset the gap
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
--     rounding, so each row is what totalAssets() returned at that drip;
--   * days are calendar days (UTC) from real block timestamps in the
--     blocks table — no approximation.

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
    SELECT DISTINCT ON (date_trunc('day', b.block_timestamp))
           date_trunc('day', b.block_timestamp)::date AS day,
           r.block_number, r.supply, r.chi
    FROM running r
    JOIN blocks b USING (block_number)
    WHERE r.chi IS NOT NULL
    ORDER BY date_trunc('day', b.block_timestamp),
             r.block_number DESC, r.log_index DESC
)
SELECT
    day,
    block_number                                   AS at_block,
    round(supply / 1e18, 0)                        AS supply_susds,
    floor(supply * chi / power(10::numeric, 27))   AS tvl_wei,
    round(floor(supply * chi / power(10::numeric, 27)) / 1e18, 0) AS tvl_usds
FROM day_last_drip
ORDER BY day;

-- Tested 2026-07-21 against the full local index with real timestamps
-- (watermark 25,584,531). 673 rows — one per UTC calendar day. First/last:
--     day     | at_block | supply_susds |  tvl_usds
--  2024-09-17 | 20775392 |        10647 |      10649
--  2024-09-18 | 20782703 |      9255682 |    9258371
--  2024-09-19 | 20789561 |     20109756 |   20118798
--  ...
--  2026-07-19 | 25571988 |   4306237634 | 4752260791
--  2026-07-20 | 25579150 |   4308294609 | 4754991090
--  2026-07-21 | 25584528 |   4020793951 | 4438003680
-- (The last row's ~314M drop is real: 2026-07-21 saw −317M of net
-- outflows — see 03_net_flows_daily.sql.)
