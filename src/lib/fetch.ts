/**
 * Shared chunked log fetcher + decoder for sUSDS events.
 *
 * Consumed by src/index.ts (summary) and src/reconcile.ts (invariant checks).
 * The optional per-chunk callback exists so a future DB writer (Postgres) can
 * persist each chunk's decoded events transactionally as the walk progresses,
 * instead of buffering the whole range in memory.
 */

import { parseAbi, type PublicClient } from "viem";

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/**
 * sUSDS is an ERC-1967 proxy. All logs are emitted from THIS proxy address,
 * while the event definitions live in the implementation contract behind it.
 * Always filter logs by the proxy address, never the implementation address —
 * pointing an indexer at the implementation (which emits nothing) is a
 * classic way to silently index zero events.
 */
export const SUSDS_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD" as const;

/** Block in which the sUSDS proxy was deployed (2024-09-04). No logs exist before it. */
export const DEPLOYMENT_BLOCK = 20_677_434n;

/**
 * dRPC's free tier caps eth_getLogs at 10,000 blocks per request and returns
 * an explicit error above that, so 10,000 is the largest chunk worth trying.
 */
export const DEFAULT_CHUNK_SIZE = 10_000n;

/**
 * Floor for the adaptive chunk size. If a request still fails at this size,
 * the problem is not the range width (it's an outage, rate limit, or a bad
 * range), so we abort instead of shrinking forever.
 */
export const MIN_CHUNK_SIZE = 500n;

/** Pause between chunk requests to stay under free-tier rate limits. */
const INTER_REQUEST_DELAY_MS = 250;

/**
 * Extra pause after a failed request, multiplied by the consecutive-failure
 * count. Halving the chunk only helps when the failure is about range width;
 * public RPCs also throw transient routing/rate errors ("can't route your
 * request...") where the fix is waiting, not shrinking. Without this, a
 * few-second upstream blip burns through every halving and aborts a
 * multi-minute walk.
 */
const FAILURE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 15_000;

/**
 * Consecutive failures tolerated at MIN_CHUNK_SIZE before aborting. At the
 * minimum size the range width is ruled out, but we still allow a transient
 * outage to pass before concluding the RPC genuinely cannot serve the range.
 */
const MAX_FAILURES_AT_MIN_CHUNK = 3;

/**
 * Default endpoint. Needs 10k-block eth_getLogs, historical eth_call, and
 * the `finalized` tag, all keyless; any archive-capable endpoint works via
 * RPC_URL. dRPC (https://eth.drpc.org) also qualifies but rate-bans heavy
 * use faster.
 */
export const DEFAULT_RPC_URL = "https://rpc.mevblocker.io";

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

/**
 * Explicit event ABI (no wildcard fetch). Signatures verified against live
 * mainnet logs and the verified SUsds.sol source:
 *  - Deposit/Withdraw are the standard ERC-4626 events.
 *  - Drip is the Sky Savings Rate accrual event: `chi` is the share/asset
 *    accumulator in ray (1e27), `diff` is the yield (wei) minted to the
 *    contract by this drip. Deposit + Withdraw alone cannot explain changes
 *    in totalAssets — yield accrues via chi — so Drip is required for
 *    reconciliation. Note drip() legitimately emits diff = 0 when called
 *    twice in the same second; summing diff is unaffected.
 */
export const susdsEvents = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Drip(uint256 chi, uint256 diff)",
]);

// ---------------------------------------------------------------------------
// Decoded event types — amounts stay bigint end to end, never float.
// ---------------------------------------------------------------------------

/** Provenance every decoded event must retain. */
export interface EventSource {
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
}

export interface DepositEvent extends EventSource {
  kind: "Deposit";
  sender: `0x${string}`;
  owner: `0x${string}`;
  assets: bigint;
  shares: bigint;
}

export interface WithdrawEvent extends EventSource {
  kind: "Withdraw";
  sender: `0x${string}`;
  receiver: `0x${string}`;
  owner: `0x${string}`;
  assets: bigint;
  shares: bigint;
}

export interface DripEvent extends EventSource {
  kind: "Drip";
  chi: bigint;
  diff: bigint;
}

export type SusdsEvent = DepositEvent | WithdrawEvent | DripEvent;

// ---------------------------------------------------------------------------
// Decode helpers — fail loudly, never zero-fill.
// ---------------------------------------------------------------------------

/**
 * Asserts a decoded field is present. viem only leaves an arg undefined when
 * the raw log did not match the ABI; substituting 0 there would corrupt every
 * downstream total, so a missing value is always a thrown error.
 */
function requireField<T>(
  value: T | undefined,
  field: string,
  source: EventSource,
): T {
  if (value === undefined) {
    throw new Error(
      `Decode failure: missing "${field}" in log at block ${source.blockNumber}, ` +
        `tx ${source.transactionHash}, logIndex ${source.logIndex}`,
    );
  }
  return value;
}

type RawLog = Awaited<ReturnType<typeof getLogsForRange>>[number];

function decodeLog(log: RawLog): SusdsEvent {
  // A log with a null blockNumber/hash is pending, which must not appear in a
  // bounded historical range — treat it as an error rather than guessing.
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    throw new Error(`Received pending log in historical range: ${JSON.stringify(log)}`);
  }
  const source: EventSource = {
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };

  switch (log.eventName) {
    case "Deposit":
      return {
        kind: "Deposit",
        ...source,
        sender: requireField(log.args.sender, "sender", source),
        owner: requireField(log.args.owner, "owner", source),
        assets: requireField(log.args.assets, "assets", source),
        shares: requireField(log.args.shares, "shares", source),
      };
    case "Withdraw":
      return {
        kind: "Withdraw",
        ...source,
        sender: requireField(log.args.sender, "sender", source),
        receiver: requireField(log.args.receiver, "receiver", source),
        owner: requireField(log.args.owner, "owner", source),
        assets: requireField(log.args.assets, "assets", source),
        shares: requireField(log.args.shares, "shares", source),
      };
    case "Drip":
      return {
        kind: "Drip",
        ...source,
        chi: requireField(log.args.chi, "chi", source),
        diff: requireField(log.args.diff, "diff", source),
      };
    default:
      // Unreachable given the topic filter, but if the RPC returns something
      // off-filter we want to know, not skip it.
      throw new Error(
        `Unexpected event in filtered response at block ${source.blockNumber}: ` +
          `${JSON.stringify(log)}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Paginated fetch with adaptive chunk size
// ---------------------------------------------------------------------------

function getLogsForRange(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
) {
  // `strict: false` so viem never silently drops a log that fails to decode:
  // mismatches surface as undefined args, which decodeLog() then rejects
  // loudly. With strict: true, a corrupt log would just vanish from results.
  return client.getLogs({
    address: SUSDS_ADDRESS,
    events: susdsEvents,
    strict: false,
    fromBlock,
    toBlock,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchResult {
  events: SusdsEvent[];
  chunksFetched: number;
  chunkFailures: number;
}

/**
 * Called after each successfully fetched+decoded chunk, in block order.
 * Future DB writers hook in here to persist per-chunk; a thrown error aborts
 * the walk (a chunk that can't be persisted must not be silently skipped).
 */
export type ChunkConsumer = (
  events: SusdsEvent[],
  fromBlock: bigint,
  toBlock: bigint,
) => void | Promise<void>;

/**
 * Walks [fromBlock, toBlock] in chunks. Public RPCs cap eth_getLogs by range
 * width (and sometimes result count), so one request for the whole range is
 * not an option. On a failed request the same window is retried with half the
 * chunk size; on success the chunk size recovers additively. An empty result
 * array is valid data (blocks with no sUSDS activity exist) and is never
 * treated as a failure — only a thrown RPC error triggers shrinking. A
 * failure at MIN_CHUNK_SIZE aborts with the RPC error attached as `cause`.
 */
export async function fetchLogsInChunks(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  initialChunkSize: bigint,
  onChunk?: ChunkConsumer,
): Promise<FetchResult> {
  const events: SusdsEvent[] = [];
  let chunkSize = initialChunkSize;
  let cursor = fromBlock;
  let chunksFetched = 0;
  let chunkFailures = 0;
  let failureStreak = 0;

  while (cursor <= toBlock) {
    const chunkEnd =
      cursor + chunkSize - 1n > toBlock ? toBlock : cursor + chunkSize - 1n;

    try {
      const logs = await getLogsForRange(client, cursor, chunkEnd);
      const decoded = logs.map(decodeLog);
      events.push(...decoded);
      if (onChunk !== undefined) await onChunk(decoded, cursor, chunkEnd);
      chunksFetched++;
      failureStreak = 0;
      console.log(
        `  blocks ${cursor}-${chunkEnd}: ${logs.length} logs (chunk size ${chunkSize})`,
      );
      cursor = chunkEnd + 1n;
      // Recover gently after a shrink rather than jumping straight back to a
      // size that just failed.
      if (chunkSize < initialChunkSize) {
        chunkSize =
          chunkSize + 1_000n > initialChunkSize
            ? initialChunkSize
            : chunkSize + 1_000n;
      }
    } catch (error) {
      chunkFailures++;
      failureStreak++;
      if (chunkSize <= MIN_CHUNK_SIZE && failureStreak > MAX_FAILURES_AT_MIN_CHUNK) {
        // Shrinking can't help and waiting didn't either; surface the
        // underlying RPC error.
        throw new Error(
          `eth_getLogs failed for blocks ${cursor}-${chunkEnd} ${failureStreak} times in a row ` +
            `at the minimum chunk size (${MIN_CHUNK_SIZE}); giving up.`,
          { cause: error },
        );
      }
      const halved = chunkSize / 2n;
      chunkSize = halved < MIN_CHUNK_SIZE ? MIN_CHUNK_SIZE : halved;
      const backoff = Math.min(FAILURE_BACKOFF_MS * failureStreak, MAX_BACKOFF_MS);
      console.warn(
        `  blocks ${cursor}-${chunkEnd} failed (${(error as Error).message.split("\n")[0]}); ` +
          `retrying with chunk size ${chunkSize} after ${backoff}ms`,
      );
      await sleep(backoff);
    }

    await sleep(INTER_REQUEST_DELAY_MS);
  }

  return { events, chunksFetched, chunkFailures };
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

export function parseBlockEnv(name: string): bigint | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new Error(`${name} must be a decimal block number, got "${raw}"`);
  }
  if (value < 0n) throw new Error(`${name} must be non-negative, got ${value}`);
  return value;
}
