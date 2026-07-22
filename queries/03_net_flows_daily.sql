-- 03: Daily deposit volume, withdrawal volume, and net flow, in USDS.
--
-- NOTE: src/charts.ts renders a 90-complete-day VARIANT of this
-- aggregation. If you change the flow logic here, change it there too —
-- the copies are cross-referenced but not shared. (The TVL chart has no
-- copy: it executes 01_tvl_daily.sql verbatim.)
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
-- NUMERIC(78,0) — exact decimal arithmetic, no floats. Days are calendar
-- days (UTC) from real block timestamps. Net flow deliberately excludes
-- Drip.diff: yield is not a flow decision by holders, and mixing it in
-- would overstate inflows by 263.4M USDS over the dataset's lifetime.

WITH flows AS (
    SELECT block_number, assets AS in_wei, 0::numeric AS out_wei
    FROM deposit_events
    UNION ALL
    SELECT block_number, 0::numeric, assets
    FROM withdraw_events
)
SELECT
    date_trunc('day', b.block_timestamp)::date     AS day,
    count(*) FILTER (WHERE in_wei  > 0)            AS deposit_count,
    count(*) FILTER (WHERE out_wei > 0)            AS withdraw_count,
    round(SUM(in_wei)  / 1e18, 0)                  AS gross_deposits_usds,
    round(SUM(out_wei) / 1e18, 0)                  AS gross_withdrawals_usds,
    round((SUM(in_wei) - SUM(out_wei)) / 1e18, 0)  AS net_flow_usds
FROM flows f
JOIN blocks b USING (block_number)
GROUP BY 1
ORDER BY 1 DESC
LIMIT 14;

-- Tested 2026-07-21 against the full local index with real timestamps
-- (watermark 25,584,531). Most recent UTC days first (top row partial):
--     day     | deposit_count | withdraw_count | gross_deposits_usds | gross_withdrawals_usds | net_flow_usds
--  2026-07-21 |           195 |            175 |             6690264 |              324021462 |    -317331198
--  2026-07-20 |           375 |            213 |           465040084 |              462769252 |       2270832
--  2026-07-19 |           291 |            310 |           311942516 |              351998583 |     -40056067
--  2026-07-15 |           243 |            228 |           595903236 |              570157691 |      25745544
--  2026-07-14 |           423 |            336 |           661070390 |              698314224 |     -37243835
-- Gross-vs-net in action: 2026-07-20 saw ~928M USDS of gross churn for a
-- net of only +2.3M. The partial 2026-07-21 row is a genuine -317M
-- outflow morning, visible as the TVL drop in 01_tvl_daily.sql.
