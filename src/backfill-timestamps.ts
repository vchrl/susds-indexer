/**
 * One-off: populate the blocks table for event blocks indexed before the
 * blocks table existed. Safe to re-run — it only fetches blocks that have
 * events but no blocks row, so an interrupted run simply resumes.
 *
 * Uses JSON-RPC batching (measured: 100 getBlockByNumber per HTTP request
 * in ~2 s on the default endpoint), giving ~25-40 min for the ~225k
 * historical event blocks instead of ~15 h serially.
 *
 * Run: npx tsx src/backfill-timestamps.ts
 * Env: DATABASE_URL, RPC_URL
 */

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { createPool, initSchema, insertBlocks, type BlockRow } from "./lib/db.js";

const SLICE = 250; // blocks per DB round-trip; the transport batches RPC calls

/**
 * Endurance settings, tuned against observed public-RPC behavior during
 * this project's own historical run: full-speed batching earned a
 * Cloudflare 1015 temp-ban from one endpoint after ~150 back-to-back batch
 * requests, and a 429 from a second under 10-concurrent-batch slices. So:
 * small slices, a pause between them, round-robin across two endpoints to
 * halve per-endpoint pressure, and minutes-scale backoff (throttle windows
 * outlast a 30 s wait). The run is resumable — only missing blocks are
 * fetched — so even a hard failure loses no work.
 */
const INTER_SLICE_DELAY_MS = 1_000;
const RETRIES = 4;
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 180_000] as const;
const DEFAULT_HEADER_RPCS =
  "https://rpc.mevblocker.io,https://ethereum-rpc.publicnode.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // RPC_URL may be a comma-separated list; slices round-robin across them,
  // and a retry hops to the next endpoint rather than re-hitting the one
  // that just throttled us.
  const rpcUrls = (process.env.RPC_URL ?? DEFAULT_HEADER_RPCS).split(",");
  const clients = rpcUrls.map((url) =>
    createPublicClient({
      chain: mainnet,
      transport: http(url.trim(), { retryCount: 1, batch: { batchSize: 50, wait: 25 } }),
    }),
  );
  const pool = createPool();
  await initSchema(pool);

  const missing = await pool.query(
    `SELECT DISTINCT block_number::text AS bn FROM (
       SELECT block_number FROM deposit_events
       UNION ALL SELECT block_number FROM withdraw_events
       UNION ALL SELECT block_number FROM drip_events
     ) e
     WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.block_number = e.block_number)
     ORDER BY 1`,
  );
  const blockNumbers = missing.rows.map((r: { bn: string }) => BigInt(r.bn));
  console.log(`${blockNumbers.length} event blocks lack a timestamp row.`);

  let done = 0;
  let sliceIndex = 0;
  for (let i = 0; i < blockNumbers.length; i += SLICE) {
    const slice = blockNumbers.slice(i, i + SLICE);
    sliceIndex++;
    let rows: BlockRow[] | null = null;
    for (let attempt = 0; ; attempt++) {
      const client = clients[(sliceIndex + attempt) % clients.length]!;
      try {
        rows = await Promise.all(
          slice.map(async (bn) => {
            const b = await client.getBlock({ blockNumber: bn });
            // getBlock throws on a missing block; a null field here would mean
            // a pending block, impossible for indexed (finalized) history.
            return { blockNumber: bn, timestamp: b.timestamp, hash: b.hash };
          }),
        );
        break;
      } catch (error) {
        if (attempt >= RETRIES) throw error;
        const backoff = RETRY_BACKOFF_MS[attempt] ?? 180_000;
        console.warn(
          `  slice at ${slice[0]} failed (${(error as Error).message.split("\n")[0]}); ` +
            `retry ${attempt + 1}/${RETRIES} on next endpoint in ${backoff / 1000}s`,
        );
        await sleep(backoff);
      }
    }
    const dbClient = await pool.connect();
    try {
      await insertBlocks(dbClient, rows);
    } finally {
      dbClient.release();
    }
    done += slice.length;
    if (done % 10_000 === 0 || done === blockNumbers.length) {
      console.log(`  ${done}/${blockNumbers.length}`);
    }
    await sleep(INTER_SLICE_DELAY_MS);
  }
  console.log("Timestamp backfill complete.");
  await pool.end();
}

main().catch((error) => {
  console.error("\nFATAL:", error);
  process.exit(1);
});
