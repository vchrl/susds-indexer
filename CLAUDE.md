# susds-indexer

## What this is
A minimal onchain indexer for sUSDS (Sky Savings Rate) on Ethereum mainnet.
Extracts ERC-4626 Deposit/Withdraw events over raw JSON-RPC, decodes them,
stores them in SQLite, and reconciles the indexed totals against live
contract state.

Built as a portfolio/reference project. Clarity beats cleverness.

## Contract
sUSDS: 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD (Ethereum mainnet)

## Stack
- TypeScript, run via tsx
- viem for RPC (getLogs, readContract)
- Postgres for storage (next feature; the fetcher exposes a per-chunk consumer hook for it)
- GitHub Actions for scheduling

## Non-negotiable rules
1. **Fail loudly, never silently.** If a value is missing or a decode fails,
   throw or flag it. Never zero-fill, never default to 0 to make a number look right.
2. **Every stored row records its source.** Block number and tx hash on every event row.
3. **Reconciliation is the point.** Indexed totals must be checked against
   contract reads. Divergence beyond tolerance is an error, not a warning.
4. **Handle reorgs.** Do not treat the latest N blocks as final.
5. No ORM, no framework. Plain viem + SQL so every line is explainable.
6. Small files, heavy comments explaining *why*, not *what*.

## Style
- Explicit over clever
- No `any` types
- Every RPC call wrapped with error handling and retry