/**
 * susds-indexer — core extraction + decode.
 *
 * Fetches sUSDS Deposit / Withdraw / Drip events from Ethereum mainnet over a
 * public RPC, decodes them, and prints a summary. Console output only; no
 * database yet. Fetching/decoding lives in src/lib/fetch.ts, shared with
 * src/reconcile.ts.
 *
 * Run: npx tsx src/index.ts
 * Env: RPC_URL, FROM_BLOCK, TO_BLOCK, CHUNK_SIZE (all optional)
 */

import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import {
  DEPLOYMENT_BLOCK,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RPC_URL,
  MIN_CHUNK_SIZE,
  fetchLogsInChunks,
  parseBlockEnv,
  type DepositEvent,
  type DripEvent,
  type FetchResult,
  type WithdrawEvent,
} from "./lib/fetch.js";

/** ~7 days of mainnet blocks at 12s/block — the default lookback window. */
const DEFAULT_LOOKBACK_BLOCKS = 50_400n;

const RPC_URL = process.env.RPC_URL ?? DEFAULT_RPC_URL;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Display-only formatting. Stored/summed values remain bigint. */
const fmtUsds = (wei: bigint) =>
  Number(formatUnits(wei, 18)).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });

function printSummary(
  result: FetchResult,
  fromBlock: bigint,
  toBlock: bigint,
): void {
  const deposits = result.events.filter((e): e is DepositEvent => e.kind === "Deposit");
  const withdraws = result.events.filter((e): e is WithdrawEvent => e.kind === "Withdraw");
  const drips = result.events.filter((e): e is DripEvent => e.kind === "Drip");

  const totalDeposited = deposits.reduce((sum, e) => sum + e.assets, 0n);
  const totalWithdrawn = withdraws.reduce((sum, e) => sum + e.assets, 0n);
  const totalAccrued = drips.reduce((sum, e) => sum + e.diff, 0n);

  // Latest chi = the chi of the last Drip in block order (logIndex breaks
  // ties within a block). chi is monotonically increasing, but we order by
  // provenance rather than by value so a decode bug can't hide behind max().
  const latestDrip = drips.reduce<DripEvent | null>((latest, e) => {
    if (latest === null) return e;
    if (e.blockNumber > latest.blockNumber) return e;
    if (e.blockNumber === latest.blockNumber && e.logIndex > latest.logIndex) return e;
    return latest;
  }, null);

  console.log("\n=== sUSDS event summary ===");
  console.log(`Block range covered:   ${fromBlock} - ${toBlock}`);
  console.log(
    `Chunks fetched:        ${result.chunksFetched} (${result.chunkFailures} failed attempts)`,
  );
  console.log(`Deposit events:        ${deposits.length}`);
  console.log(`Withdraw events:       ${withdraws.length}`);
  console.log(`Drip events:           ${drips.length}`);
  console.log(`Total assets deposited: ${fmtUsds(totalDeposited)} USDS (${totalDeposited} wei)`);
  console.log(`Total assets withdrawn: ${fmtUsds(totalWithdrawn)} USDS (${totalWithdrawn} wei)`);
  console.log(`Net asset flow:         ${fmtUsds(totalDeposited - totalWithdrawn)} USDS`);
  console.log(`Total yield accrued:    ${fmtUsds(totalAccrued)} USDS (sum of Drip.diff)`);
  if (latestDrip !== null) {
    console.log(
      `Latest chi observed:    ${latestDrip.chi} (ray) at block ${latestDrip.blockNumber}`,
    );
  } else {
    console.log("Latest chi observed:    none (no Drip events in range)");
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL, { retryCount: 2 }),
  });

  const latestBlock = await client.getBlockNumber();

  // Default window: the last ~7 days, clamped to the deployment block.
  const defaultFrom =
    latestBlock > DEFAULT_LOOKBACK_BLOCKS + DEPLOYMENT_BLOCK
      ? latestBlock - DEFAULT_LOOKBACK_BLOCKS
      : DEPLOYMENT_BLOCK;

  const fromBlock = parseBlockEnv("FROM_BLOCK") ?? defaultFrom;
  const toBlock = parseBlockEnv("TO_BLOCK") ?? latestBlock;
  const chunkSize = parseBlockEnv("CHUNK_SIZE") ?? DEFAULT_CHUNK_SIZE;

  if (fromBlock > toBlock) {
    throw new Error(`FROM_BLOCK (${fromBlock}) is after TO_BLOCK (${toBlock})`);
  }
  if (fromBlock < DEPLOYMENT_BLOCK) {
    console.warn(
      `Note: FROM_BLOCK ${fromBlock} predates sUSDS deployment (${DEPLOYMENT_BLOCK}); ` +
        `blocks before deployment will simply contain no events.`,
    );
  }
  if (chunkSize < MIN_CHUNK_SIZE) {
    throw new Error(`CHUNK_SIZE must be >= ${MIN_CHUNK_SIZE}, got ${chunkSize}`);
  }

  console.log(`RPC:    ${RPC_URL}`);
  console.log(`Range:  ${fromBlock} - ${toBlock} (${toBlock - fromBlock + 1n} blocks)`);

  const result = await fetchLogsInChunks(client, fromBlock, toBlock, chunkSize);
  printSummary(result, fromBlock, toBlock);
}

main().catch((error) => {
  console.error("\nFATAL:", error);
  process.exit(1);
});
