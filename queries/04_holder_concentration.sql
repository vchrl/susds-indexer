-- 04: Share positions per address, ranked, with cumulative share of supply.
--
-- KNOWN LIMITATION — READ BEFORE USING: this is NOT full holder data.
-- sUSDS is a transferable ERC-20, and this indexer stores only
-- Deposit/Withdraw (mint/burn) events, not Transfer events. Each row is
-- therefore an address's NET MINTED position: shares it received at
-- deposit time minus shares burned from it at withdrawal time. An address
-- that bought sUSDS on a DEX appears with 0 (absent); one that deposited
-- and then sent the tokens elsewhere still shows the full amount; and an
-- address can show a NEGATIVE position (it withdrew shares it received via
-- transfer). The negative rows are direct, visible proof of the gap.
-- What IS exact: the SUM over all rows equals on-chain totalSupply() to
-- the wei (reconciliation check 1) — the total is right, the attribution
-- is mint/burn-based only. Full balances would require indexing Transfer
-- events (not done; see NOTES for what that would take).
--
-- (This query has no time dimension, so it does not join the blocks
-- table — it is current-state as of the watermark.)
--
-- "owner" is the correct attribution column: in _mint the owner receives
-- the shares, in _burn the owner's shares are burned (sender/receiver are
-- transaction mechanics, not position holders).

WITH positions AS (
    SELECT owner, SUM(delta) AS shares
    FROM (
        SELECT owner, shares  AS delta FROM deposit_events
        UNION ALL
        SELECT owner, -shares AS delta FROM withdraw_events
    ) mints_burns
    GROUP BY owner
    HAVING SUM(delta) <> 0
),
total AS (
    SELECT SUM(shares) AS supply FROM positions   -- == totalSupply(), check 1
)
SELECT
    rank() OVER (ORDER BY p.shares DESC)                       AS rank,
    p.owner,
    round(p.shares / 1e18, 0)                                  AS net_minted_susds,
    round(100 * p.shares / t.supply, 2)                        AS pct_of_supply,
    round(100 * SUM(p.shares) OVER (ORDER BY p.shares DESC)
                / t.supply, 2)                                 AS cumulative_pct
FROM positions p, total t
ORDER BY p.shares DESC
LIMIT 15;

-- Companion sanity numbers (run separately):
--   SELECT count(*) FROM positions;                    -- distinct nonzero positions
--   SELECT count(*) FROM positions WHERE shares < 0;   -- transfer-gap proof
--
-- Tested 2026-07-21 against the full local index (watermark 25,584,531).
-- 6,692 nonzero net-minted positions, of which 1,169 are NEGATIVE — the
-- visible footprint of un-indexed transfers described above. Actual top 5:
--  rank |                   owner                    | net_minted_susds | pct_of_supply | cumulative_pct
--     1 | 0x3300f198988e4C9C63F75dF86De36421f06af8c4 |        801875711 |         19.94 |          19.94
--     2 | 0x00836Fe54625BE242BcFA286207795405ca4fD10 |        725564514 |         18.05 |          37.99
--     3 | 0xbA1333333333a1BA1108E8412f11850A5C319bA9 |        697647177 |         17.35 |          55.34
--     4 | 0xD00e0079B8CAB524F3fa20EA879a7736E512a5Fc |        650807495 |         16.19 |          71.53
--     5 | 0x93904eeC579e5bF7a57C2DD4AfbEA0F1C3e6A1D1 |        606025807 |         15.07 |          86.60
-- Note the cumulative column passes 100%: positive net-minted positions
-- alone exceed totalSupply, offset by the 1,169
-- negative ones so the grand total still equals supply exactly. That is
-- the transfer gap showing up in the arithmetic — a reminder to read this
-- as "who minted", not "who holds". (All top-3 rows are smart contracts,
-- verified via eth_getCode — protocols minting on behalf of many end
-- users, another reason mint attribution ≠ holdings.)
