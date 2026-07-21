/**
 * Postgres persistence for decoded sUSDS events. Raw SQL via `pg`, no ORM.
 *
 * Amounts travel as strings between JS bigint and NUMERIC(78,0) — never
 * through JS number, which would corrupt anything above 2^53.
 */

import pg from "pg";

export const DEFAULT_DATABASE_URL =
  "postgres://susds:susds@localhost:5432/susds";

export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
}

/**
 * Schema notes:
 *  - One table per event type, not a discriminator column: the three events
 *    share only provenance fields, and a single table would force every
 *    event-specific column to be nullable — at which point a buggy NULL
 *    insert is legal DDL and SUM() skips it silently. Per-event tables make
 *    NOT NULL a whole-row invariant (CLAUDE.md rule 1 enforced by the
 *    schema itself).
 *  - NUMERIC(78,0): uint256 max is 78 decimal digits. Never float/bigint8.
 *  - PRIMARY KEY (block_number, log_index) is the natural key (log_index is
 *    unique per block across all event types) and doubles as the range-scan
 *    index: a btree on (block_number, log_index) has block_number as its
 *    leading column, so WHERE block_number BETWEEN ... uses it directly.
 *    No separate index on block_number needed.
 *  - CHECK (diff >= 0), not (diff > 0): drip() emits diff = 0 whenever it is
 *    called twice in the same second (SUsds.sol takes the no-accrual branch
 *    and still emits). Observed on-chain; zero is real data, not an error.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deposit_events (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  sender           CHAR(42)      NOT NULL,
  owner            CHAR(42)      NOT NULL,
  assets           NUMERIC(78,0) NOT NULL CHECK (assets >= 0),
  shares           NUMERIC(78,0) NOT NULL CHECK (shares >= 0),
  PRIMARY KEY (block_number, log_index)
);

CREATE TABLE IF NOT EXISTS withdraw_events (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  sender           CHAR(42)      NOT NULL,
  receiver         CHAR(42)      NOT NULL,
  owner            CHAR(42)      NOT NULL,
  assets           NUMERIC(78,0) NOT NULL CHECK (assets >= 0),
  shares           NUMERIC(78,0) NOT NULL CHECK (shares >= 0),
  PRIMARY KEY (block_number, log_index)
);

CREATE TABLE IF NOT EXISTS drip_events (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  chi              NUMERIC(78,0) NOT NULL CHECK (chi > 0),
  diff             NUMERIC(78,0) NOT NULL CHECK (diff >= 0),
  PRIMARY KEY (block_number, log_index)
);

-- Single row (id is always TRUE). highest_indexed_block is contiguous by
-- construction: it only advances inside the same transaction that persisted
-- every event of the chunk ending at that block.
CREATE TABLE IF NOT EXISTS indexing_state (
  id                    BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
  highest_indexed_block BIGINT      NOT NULL,
  highest_block_hash    CHAR(66)    NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function initSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

export interface IndexingState {
  highestIndexedBlock: bigint;
  highestBlockHash: `0x${string}`;
}

export async function getIndexingState(
  pool: pg.Pool,
): Promise<IndexingState | null> {
  const res = await pool.query(
    "SELECT highest_indexed_block::text AS block, highest_block_hash AS hash FROM indexing_state",
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as { block: string; hash: string };
  return {
    highestIndexedBlock: BigInt(row.block),
    highestBlockHash: row.hash.trim() as `0x${string}`,
  };
}

import type { SusdsEvent } from "./fetch.js";

export interface PersistCounts {
  deposits: number;
  withdraws: number;
  drips: number;
}

/**
 * Persists one chunk's events and advances indexing_state to chunkEnd, all
 * in a single transaction: a crash mid-walk leaves the state pointing at the
 * last fully persisted chunk, so resume is exact with no partial chunks.
 *
 * ON CONFLICT DO NOTHING is safe idempotency, not silent error-swallowing:
 * we only ever store finalized blocks, so a row at (block_number, log_index)
 * is immutable — a conflict can only be the identical row again.
 */
export async function persistChunk(
  pool: pg.Pool,
  events: SusdsEvent[],
  chunkEnd: bigint,
  chunkEndHash: `0x${string}`,
): Promise<PersistCounts> {
  const deposits = events.filter((e) => e.kind === "Deposit");
  const withdraws = events.filter((e) => e.kind === "Withdraw");
  const drips = events.filter((e) => e.kind === "Drip");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const dep = await client.query(
      `INSERT INTO deposit_events (block_number, log_index, transaction_hash, sender, owner, assets, shares)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[])
       ON CONFLICT (block_number, log_index) DO NOTHING`,
      [
        deposits.map((e) => e.blockNumber.toString()),
        deposits.map((e) => e.logIndex),
        deposits.map((e) => e.transactionHash),
        deposits.map((e) => e.sender),
        deposits.map((e) => e.owner),
        deposits.map((e) => e.assets.toString()),
        deposits.map((e) => e.shares.toString()),
      ],
    );
    const wd = await client.query(
      `INSERT INTO withdraw_events (block_number, log_index, transaction_hash, sender, receiver, owner, assets, shares)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[])
       ON CONFLICT (block_number, log_index) DO NOTHING`,
      [
        withdraws.map((e) => e.blockNumber.toString()),
        withdraws.map((e) => e.logIndex),
        withdraws.map((e) => e.transactionHash),
        withdraws.map((e) => e.sender),
        withdraws.map((e) => e.receiver),
        withdraws.map((e) => e.owner),
        withdraws.map((e) => e.assets.toString()),
        withdraws.map((e) => e.shares.toString()),
      ],
    );
    const dr = await client.query(
      `INSERT INTO drip_events (block_number, log_index, transaction_hash, chi, diff)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::numeric[], $5::numeric[])
       ON CONFLICT (block_number, log_index) DO NOTHING`,
      [
        drips.map((e) => e.blockNumber.toString()),
        drips.map((e) => e.logIndex),
        drips.map((e) => e.transactionHash),
        drips.map((e) => e.chi.toString()),
        drips.map((e) => e.diff.toString()),
      ],
    );

    // Advance the watermark, forward-only. A non-advancing update means a
    // concurrent or misordered run — fail loudly rather than index twice.
    const state = await client.query(
      `INSERT INTO indexing_state (id, highest_indexed_block, highest_block_hash)
       VALUES (TRUE, $1, $2)
       ON CONFLICT (id) DO UPDATE
         SET highest_indexed_block = EXCLUDED.highest_indexed_block,
             highest_block_hash    = EXCLUDED.highest_block_hash,
             updated_at            = now()
         WHERE indexing_state.highest_indexed_block < EXCLUDED.highest_indexed_block`,
      [chunkEnd.toString(), chunkEndHash],
    );
    if (state.rowCount !== 1) {
      throw new Error(
        `indexing_state did not advance to ${chunkEnd}; another run has moved the ` +
          `watermark past this chunk. Refusing to continue.`,
      );
    }

    await client.query("COMMIT");
    return {
      deposits: dep.rowCount ?? 0,
      withdraws: wd.rowCount ?? 0,
      drips: dr.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface StoredTotals {
  depositCount: number;
  withdrawCount: number;
  dripCount: number;
  depositAssets: bigint;
  depositShares: bigint;
  withdrawAssets: bigint;
  withdrawShares: bigint;
  accrued: bigint;
  lastDrip: { chi: bigint; blockNumber: bigint; logIndex: number } | null;
}

/**
 * Aggregates for reconciliation. Sums are computed by Postgres over NUMERIC
 * (exact decimal arithmetic) and returned as strings, then converted to
 * bigint — JS number never touches an amount.
 */
export async function getStoredTotals(pool: pg.Pool): Promise<StoredTotals> {
  const [dep, wd, dr, last] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(assets), 0)::text AS assets,
              COALESCE(SUM(shares), 0)::text AS shares FROM deposit_events`,
    ),
    pool.query(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(assets), 0)::text AS assets,
              COALESCE(SUM(shares), 0)::text AS shares FROM withdraw_events`,
    ),
    pool.query(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(diff), 0)::text AS accrued FROM drip_events`,
    ),
    pool.query(
      `SELECT chi::text AS chi, block_number::text AS block, log_index
       FROM drip_events ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    ),
  ]);
  const d = dep.rows[0] as { n: string; assets: string; shares: string };
  const w = wd.rows[0] as { n: string; assets: string; shares: string };
  const r = dr.rows[0] as { n: string; accrued: string };
  const l = last.rows[0] as
    | { chi: string; block: string; log_index: number }
    | undefined;
  return {
    depositCount: Number(d.n),
    withdrawCount: Number(w.n),
    dripCount: Number(r.n),
    depositAssets: BigInt(d.assets),
    depositShares: BigInt(d.shares),
    withdrawAssets: BigInt(w.assets),
    withdrawShares: BigInt(w.shares),
    accrued: BigInt(r.accrued),
    lastDrip:
      l === undefined
        ? null
        : {
            chi: BigInt(l.chi),
            blockNumber: BigInt(l.block),
            logIndex: l.log_index,
          },
  };
}
