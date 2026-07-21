/**
 * susds-indexer — backfill events into Postgres.
 *
 * Walks from the stored watermark (or deployment on first run) up to the
 * CURRENT FINALIZED BLOCK — never head. Finalized blocks cannot reorg
 * without a consensus catastrophe, so staying ~2 epochs (~13-19 min) behind
 * head removes the need for any unwind logic. Each chunk's events and the
 * watermark advance commit in one transaction, so resume is exact.
 *
 * Reorg tripwire: before resuming, the stored hash of the watermark block is
 * compared against the chain. A mismatch means a finality violation or an
 * RPC on the wrong chain — the run refuses to continue (exit 1), no
 * automatic rollback. Recovery is manual: verify the RPC against a second
 * source; if finality was genuinely violated, truncate and re-index (the
 * chain is the source of truth, the DB is a cache).
 *
 * Run: npx tsx src/backfill.ts
 * Env: DATABASE_URL, RPC_URL, CHUNK_SIZE,
 *      TO_BLOCK (testing aid; must be <= finalized, the reorg rule is not
 *      overridable)
 */

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import {
  DEPLOYMENT_BLOCK,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RPC_URL,
  fetchLogsInChunks,
  parseBlockEnv,
} from "./lib/fetch.js";
import {
  createPool,
  getIndexingState,
  initSchema,
  persistChunk,
  type PersistCounts,
} from "./lib/db.js";

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { retryCount: 2 }),
  });
  const pool = createPool();
  await initSchema(pool);

  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null) {
    throw new Error("RPC returned a pending block for the finalized tag");
  }

  const toOverride = parseBlockEnv("TO_BLOCK");
  if (toOverride !== null && toOverride > finalized.number) {
    throw new Error(
      `TO_BLOCK ${toOverride} is beyond the finalized block ${finalized.number}; ` +
        `indexing non-finalized blocks is not supported (reorg safety).`,
    );
  }
  const toBlock = toOverride ?? finalized.number;

  // Resume point + reorg tripwire.
  const state = await getIndexingState(pool);
  let fromBlock: bigint;
  if (state === null) {
    fromBlock = DEPLOYMENT_BLOCK;
    console.log(`Fresh database; starting at deployment block ${DEPLOYMENT_BLOCK}.`);
  } else {
    const anchor = await client.getBlock({
      blockNumber: state.highestIndexedBlock,
    });
    if (anchor.hash !== state.highestBlockHash) {
      throw new Error(
        `REORG TRIPWIRE: stored hash for block ${state.highestIndexedBlock} is ` +
          `${state.highestBlockHash} but the chain reports ${anchor.hash}. ` +
          `This block was finalized when stored — either the RPC is serving a ` +
          `different chain or finality was violated. Refusing to index; see ` +
          `README "Reorg safety" for manual recovery.`,
      );
    }
    fromBlock = state.highestIndexedBlock + 1n;
    console.log(
      `Resuming after block ${state.highestIndexedBlock} (stored hash verified against chain).`,
    );
  }

  if (fromBlock > toBlock) {
    console.log(
      `Nothing to do: watermark ${fromBlock - 1n} is at or past target ${toBlock}.`,
    );
    await pool.end();
    return;
  }

  const chunkSize = parseBlockEnv("CHUNK_SIZE") ?? DEFAULT_CHUNK_SIZE;
  console.log(`RPC:    ${rpcUrl}`);
  console.log(
    `Range:  ${fromBlock} -> ${toBlock} (finalized: ${finalized.number}, ` +
      `head lag ~2 epochs)`,
  );

  const inserted: PersistCounts = { deposits: 0, withdraws: 0, drips: 0 };
  const result = await fetchLogsInChunks(
    client,
    fromBlock,
    toBlock,
    chunkSize,
    async (events, _chunkFrom, chunkTo) => {
      // The chunk-end hash anchors the watermark for the next run's tripwire.
      const endBlock = await client.getBlock({ blockNumber: chunkTo });
      const counts = await persistChunk(pool, events, chunkTo, endBlock.hash);
      inserted.deposits += counts.deposits;
      inserted.withdraws += counts.withdraws;
      inserted.drips += counts.drips;
    },
  );

  const skipped = result.events.length - inserted.deposits - inserted.withdraws - inserted.drips;
  console.log(`\n=== backfill complete ===`);
  console.log(`Watermark:         block ${toBlock}`);
  console.log(`Events fetched:    ${result.events.length} in ${result.chunksFetched} chunks (${result.chunkFailures} failed attempts)`);
  console.log(`Rows inserted:     ${inserted.deposits} deposits, ${inserted.withdraws} withdraws, ${inserted.drips} drips`);
  console.log(`Already present:   ${skipped} (idempotent re-index)`);
  await pool.end();
}

main().catch((error) => {
  console.error("\nFATAL:", error);
  process.exit(1);
});
