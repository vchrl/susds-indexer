-- 03: Daily deposit volume, withdrawal volume, and net flow, in USDS.
--
-- Gross and net answer different questions and are kept separate:
--   * gross (deposits, withdrawals independently) measures ACTIVITY —
--     how much money moved through the vault;
--   * net (deposits − withdrawals) measures GROWTH pressure — whether
--     capital entered or left on balance.
-- A day with 500M in and 500M out has enormous gross volume and zero net
-- flow; collapsing the two into one number hides that entirely.
--
-- Correctness: Deposit.assets / Withdraw.assets are the exact USDS amounts
-- that crossed the contract boundary (verified to the wei by
-- reconciliation check 3). Sums are computed by Postgres over
-- NUMERIC(78,0) — exact decimal arithmetic, no floats. Note net flow
-- deliberately excludes Drip.diff: yield is not a flow decision by
-- holders, and mixing it in would overstate inflows by 263.4M USDS over
-- the dataset's lifetime.
--
-- APPROXIMATION NOTE: day buckets are 7159-block windows (measured average
-- 12.068 s/block, anchors as in 01_tvl_daily.sql). Bucket edges are
-- approximate; every summed value is exact.

WITH flows AS (
    SELECT (block_number - 20677434) / 7159 AS day_idx,
           assets      AS in_wei,
           0::numeric  AS out_wei
    FROM deposit_events
    UNION ALL
    SELECT (block_number - 20677434) / 7159,
           0::numeric,
           assets
    FROM withdraw_events
)
SELECT
    to_timestamp(1726661999 + ((day_idx * 7159 + 20677434) - 20777433) * 12.068872)::date
        AS approx_date,
    count(*) FILTER (WHERE in_wei  > 0)            AS deposit_count,
    count(*) FILTER (WHERE out_wei > 0)            AS withdraw_count,
    round(SUM(in_wei)  / 1e18, 0)                  AS gross_deposits_usds,
    round(SUM(out_wei) / 1e18, 0)                  AS gross_withdrawals_usds,
    round((SUM(in_wei) - SUM(out_wei)) / 1e18, 0)  AS net_flow_usds
FROM flows
GROUP BY day_idx
ORDER BY day_idx DESC
LIMIT 14;

-- Tested 2026-07-21 against the full local index (watermark 25,583,193).
-- Most recent ~day-buckets first (top row is the partial current bucket):
--  approx_date | deposit_count | withdraw_count | gross_deposits_usds | gross_withdrawals_usds | net_flow_usds
--  2026-07-21  |            69 |             45 |             3225001 |                3621279 |       -396279
--  2026-07-20  |           410 |            229 |           407626663 |              379537618 |      28089045
--  2026-07-19  |           311 |            310 |           366097856 |              436566369 |     -70468513
--  2026-07-14  |           274 |            320 |           813769500 |              811613366 |       2156134
--  2026-07-13  |           357 |            292 |           365361419 |              905843743 |    -540482324
-- Gross-vs-net in action: on 2026-07-14, 813.8M USDS deposited and 811.6M
-- withdrawn — 1.6B of gross churn for a net of only +2.2M (nearly 3 orders
-- of magnitude apart). The next row down shows the opposite regime: a
-- genuine -540M outflow day on 2026-07-13.
