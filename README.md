# susds-indexer

Minimal onchain indexer for [sUSDS](https://etherscan.io/address/0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD) (Sky Savings Rate) on Ethereum mainnet.

Fetches and decodes `Deposit`, `Withdraw` (ERC-4626), and `Drip` (SSR yield
accrual) events, persists them to Postgres, and verifies indexed totals
against live contract state with **zero tolerance** — the reconciliation is
the point of the repo.

```mermaid
flowchart LR
    RPC["Ethereum RPC"] -->|"eth_getLogs, chunked
    (adaptive size)"| FETCH["fetchLogsInChunks
    src/lib/fetch.ts"]
    FETCH --> DECODE["decode + validate
    (missing field = throw)"]
    DECODE -->|"ChunkConsumer hook:
    one txn per chunk"| PG[("Postgres
    events + watermark")]
    PG --> REC["reconcile --from-db
    4 exact checks"]
    RPC -->|"eth_call pinned
    to block N"| REC
    REC -->|"all diffs = 0"| PASS["exit 0"]
    REC -->|"any diff ≠ 0"| FAIL["exit 1"]
```

## Quick start

```sh
npm install
npx tsx src/index.ts        # summary of the last ~7 days, no database needed

docker compose up -d        # local Postgres, no external account
npx tsx src/backfill.ts     # persist full history (first run: ~15 min)
npx tsx src/reconcile.ts --from-db   # verify everything, exact to the wei
```

Uses `https://rpc.mevblocker.io` by default (public, no API key). Any
archive-capable endpoint that serves ~10k-block `eth_getLogs`, historical
`eth_call`, and the `finalized` tag works via `RPC_URL` —
`https://eth.drpc.org` is a known-good alternative, though its free tier
rate-limits heavy use sooner. No Docker? Any Postgres ≥ 14 works: point
`DATABASE_URL` at it.

## How sUSDS accrues yield (read this first)

sUSDS is an ERC-4626 vault over USDS: holder balances never change; instead
the share→asset exchange rate — a single accumulator called `chi` — rises
over time, so a fixed number of shares is worth ever more USDS. `chi` is
stored in ray (27 decimals) and is **not** updated continuously: it only
advances when `drip()` runs, which happens lazily inside every user
deposit/withdraw (or an explicit call), each run emitting a `Drip` event
with the new `chi` and the yield minted since the last one.

The catch for an indexer: `totalAssets()` does not return stored state.
It extrapolates `chi` from the last drip's timestamp (`rho`) to *now*, so
it includes yield that no event has reported yet. An event-derived total
can therefore never exactly equal `totalAssets()` — unless you replicate
the extrapolation, which is exactly what check 4 below does.

## Reconciliation

```sh
npx tsx src/reconcile.ts                         # re-index from RPC, pin to finalized
BLOCK_NUMBER=20777433 npx tsx src/reconcile.ts   # pin to a specific block
npx tsx src/reconcile.ts --from-db               # use stored events, pin to watermark
```

`src/reconcile.ts` takes **every** event from deployment to a pinned block N
(default: the finalized head, never `latest` — reorg safety), reads contract
state at that same block N via `eth_call`, and asserts four invariants. Any
divergence exits non-zero; PASS still prints every number.

### The four invariants

| # | Indexed (from events only) | Contract (read at block N) | Why it must hold |
|---|---|---|---|
| 1 | Σ `Deposit.shares` − Σ `Withdraw.shares` | `totalSupply()` | `totalSupply` changes only in `_mint`/`_burn`, by exactly the emitted share amounts; transfers move balances, never supply |
| 2 | latest `Drip.chi` | `chi()` | stored `chi` is by construction the `nChi` of the last emitted `Drip` |
| 3 | Σ `Deposit.assets` − Σ `Withdraw.assets` + Σ `Drip.diff` | `usds.balanceOf(sUSDS)` | every USDS wei that crosses the contract boundary is exactly an event amount: deposits pull `assets` in, withdrawals push `assets` out, `drip()` mints exactly `diff` |
| 4 | ⌊shares₁ · rpow(`ssr`, tₙ−`rho`) · `chi` / RAY²⌋ | `totalAssets()` | `totalAssets()` does not return stored state — it *extrapolates* `chi` to the block timestamp ([`src/lib/rpow.ts`](src/lib/rpow.ts) replicates the contract's `_rpow` bit-for-bit) |

Checks 1–3 compare event sums directly; only check 4 needs the rpow
extrapolation, because only `totalAssets()` reports extrapolated state:

```mermaid
flowchart LR
    subgraph IDX["Indexed (events only)"]
        S["net shares:
        Σ Deposit.shares − Σ Withdraw.shares"]
        C["latest Drip.chi"]
        B["net assets + accrued:
        Σ in − Σ out + Σ Drip.diff"]
        V["virtual chi:
        rpow(ssr, tN − rho) · chi / RAY"]
    end
    subgraph CHAIN["eth_call at pinned block N"]
        TS["totalSupply()"]
        CHI["chi()"]
        BAL["usds.balanceOf(sUSDS)"]
        TA["totalAssets()"]
    end
    S ---|"check 1: exact"| TS
    C ---|"check 2: exact"| CHI
    B ---|"check 3: exact,
    direction diagnosed"| BAL
    S -.->|shares| V
    C -.->|chi| V
    V ---|"check 4: exact"| TA
```

### Why tolerance is zero

The tempting invariant — `totalAssets() ≈ net deposits + accrued yield` —
is the wrong one. It differs from the event-derived total by the yield
accrued *since the last `Drip`*, which the event stream cannot see; at
current TVL (~4.75B USDS) that error term is ~5.3 USDS **per second** since
the last drip. Any tolerance wide enough to absorb it would be arbitrary
and would mask real bugs.

Instead, all four checks above are exact identities of the contract code:

- Rounding in sUSDS exists, but it lands in the **contract's balance**, not
  in any compared quantity: deposits floor shares, withdrawals ceil them, so
  dust accumulates in the contract's favor (32 wei after the first ~14 days
  of operation) and cancels out of checks 1–4 entirely.
- Check 4 reproduces the extrapolation itself instead of tolerating it,
  using `chi`/`rho`/`ssr` and the timestamp of the same block N that pins
  every `eth_call`.

So a 1-wei divergence is a real finding, and the checks are wired that way:
**diff ≠ 0 → exit 1** (per repo rule: divergence is an error, not a warning).

### Check 3 direction diagnosis

Check 3 is the only invariant an outside actor can perturb, and the
direction of a divergence identifies the cause:

- **balance < indexed sum** — the chain holds less than the events account
  for. Impossible per contract code; means missed or double-counted events,
  i.e. an indexer bug. Always a failure.
- **balance > indexed sum** — unexplained inflow: someone transferred USDS
  directly to the sUSDS contract (a donation). Not an indexer bug, but the
  event set can no longer explain the balance, so it still fails — with the
  diagnosis printed — rather than being absorbed into a tolerance.

### Verified results

All invariants were derived from the verified `SUsds.sol` source
(implementation `0x4e7991e5…61e0`) and verified exact-to-the-wei against
mainnet twice: over the launch window (deployment → block 20,777,433), and
over the full contract history — 572,190 events across 4.9M blocks,
reconciled at finalized block 25,583,097 with **0 wei divergence on all
four checks** (RPC-mode run, 2026-07-21).

Full-range `--from-db` result (2026-07-21): 572,192 stored events
(145,536 deposits, 140,551 withdraws, 286,105 drips) reconciled at
watermark block 25,583,193 — **PASS 4/4, 0 wei divergence on every check**,
after the amounts round-tripped `chain → decode → NUMERIC(78,0) → SUM →
bigint`. Check 4 reproduced `totalAssets()` exactly through 96 s of
un-dripped accrual (511.54 USDS — the error term a tolerance-based check
would have had to absorb).

## Persistence

`src/backfill.ts` persists each chunk's decoded events **and** advances the
`indexing_state` watermark in a single transaction, so a crash leaves the
database at the last fully persisted chunk and the next run resumes exactly
there. Re-running any range inserts nothing new (`ON CONFLICT DO NOTHING`
on the natural key `(block_number, log_index)` — safe because stored blocks
are finalized and therefore immutable). `--from-db` reconciliation pins its
contract reads to the stored watermark block, so stored events and chain
state describe the same block.

### Schema

The four tables, as created by [`src/lib/db.ts`](src/lib/db.ts):

```sql
CREATE TABLE deposit_events (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  sender           CHAR(42)      NOT NULL,
  owner            CHAR(42)      NOT NULL,
  assets           NUMERIC(78,0) NOT NULL CHECK (assets >= 0),
  shares           NUMERIC(78,0) NOT NULL CHECK (shares >= 0),
  PRIMARY KEY (block_number, log_index)
);

CREATE TABLE withdraw_events (
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

CREATE TABLE drip_events (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  chi              NUMERIC(78,0) NOT NULL CHECK (chi > 0),
  diff             NUMERIC(78,0) NOT NULL CHECK (diff >= 0),  -- 0 is real: same-second drip
  PRIMARY KEY (block_number, log_index)
);

-- one row per block containing at least one indexed event: real timestamps
-- for queries. block_hash is stored per block but the reorg tripwire still
-- checks only the watermark hash (available-not-used).
CREATE TABLE blocks (
  block_number    BIGINT      PRIMARY KEY,
  block_timestamp TIMESTAMPTZ NOT NULL,
  block_hash      CHAR(66)    NOT NULL
);

-- single row; advances only inside the same txn that persisted the chunk
CREATE TABLE indexing_state (
  id                    BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
  highest_indexed_block BIGINT      NOT NULL,
  highest_block_hash    CHAR(66)    NOT NULL,  -- reorg tripwire
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Schema decisions

- **One table per event type, not an `events` table with a `kind` column.**
  The three events share only provenance fields; a discriminator table makes
  every event-specific column nullable, at which point a buggy NULL insert
  is legal DDL and `SUM()` skips it silently — the exact zero-fill failure
  mode this repo bans. Per-event tables make `NOT NULL` a whole-row
  invariant the schema itself enforces.
- **`NUMERIC(78,0)` for all amounts** — uint256 max is 78 decimal digits.
  Values travel as strings between JS `bigint` and Postgres; JS `number`
  (2^53 mantissa) never touches an amount, and sums are computed by
  Postgres in exact decimal arithmetic.
- **`(block_number, log_index)` is both the natural key and the range-scan
  index**: `log_index` is unique per block across all event types, and the
  PK's btree has `block_number` as its leading column, so block-range
  queries use it directly — no separate index on `block_number`.
- **`CHECK` constraints assert on-chain semantics**: `assets >= 0`,
  `shares >= 0`, `chi > 0`, but `diff >= 0` — `drip()` really does emit
  `diff = 0` when called twice in the same second (observed on-chain), so
  zero is data, not an error.
- **Every row keeps `block_number`, `transaction_hash`, `log_index`** (repo
  rule 2: every stored row records its source).
- **Indexing only to `finalized` removes reorg unwind logic entirely.** See
  below.

### Reorg safety

The backfill never stores a block that can still reorg: each run walks only
up to the **current finalized block** (~2 epochs / ~13–19 min behind head —
irrelevant for a scheduled batch indexer). A finalized block cannot revert
without ≥1/3 of staked ETH being slashed, so there is no unwind/rollback
code to write, test, or trust.

The stored hash of the watermark block is a tripwire, not a recovery
mechanism: on every resume (and every `--from-db` reconcile) it is
re-checked against the chain. A mismatch means the RPC is serving a
different chain or finality was violated — the run **refuses to proceed**
(exit 1) rather than auto-repairing, because automatic unwind code for an
event that cannot occur under normal consensus is untestable complexity.
Manual recovery: verify the RPC against a second source; if finality was
genuinely violated, truncate the tables and re-index — the chain is the
source of truth, the database is a cache.

## Queries

[`queries/`](queries/) holds analytical SQL demonstrating the data is
usable, not just verifiable. Each file states what it answers, why the
calculation is correct, and ends with actual results from the full local
index. Day buckets and elapsed seconds come from real block timestamps in
the `blocks` table (populated during backfill; one-off historical fill via
`npx tsx src/backfill-timestamps.ts`), so time math is exact — no
blocks-per-second approximation.

| File | Answers |
|---|---|
| [`01_tvl_daily.sql`](queries/01_tvl_daily.sql) | Daily TVL — share supply × chi at each day's last drip (not a deposit sum, which would miss the 263.4M USDS of minted yield) |
| [`02_apy_realized.sql`](queries/02_apy_realized.sql) | Realized APY, trailing 7d/30d, from chi growth annualized (3.59% at time of writing) |
| [`03_net_flows_daily.sql`](queries/03_net_flows_daily.sql) | Daily gross deposit/withdrawal volume vs net flow — different questions, kept separate |
| [`04_holder_concentration.sql`](queries/04_holder_concentration.sql) | Net-minted position per address, ranked — explicitly **not** full holder data (Transfers are not indexed; the file documents the visible proof) |
| [`05_drip_cadence.sql`](queries/05_drip_cadence.sql) | Drip gap distribution — quantifies the staleness window reconciliation check 4 must handle (median ~72 s, p99 ~33 min, max ~7.4 h) |

## Scheduled runs

[`.github/workflows/index.yml`](.github/workflows/index.yml) runs daily (and
on `workflow_dispatch`): backfill to finalized, then `--from-db`
reconciliation; any check diverging fails the workflow. It is a **CI
correctness check, not a persistent store** — the Postgres service container
is empty every run. A `pg_dump` carried via `actions/cache` lets backfill
resume from `indexing_state` on cache hits; on a miss (first run, eviction)
it re-indexes from deployment, because the four checks are only defined over
the full event history. The zero-tolerance checks make the cache safe: stale
or corrupt restored state trips the hash check or a reconciliation check —
it cannot produce a false PASS. `RPC_URL` comes from a repo secret when set,
falling back to the public default.

## Configuration

| Env var      | Default                | Used by | Meaning                 |
| ------------ | ---------------------- | ------- | ----------------------- |
| `RPC_URL`    | `https://rpc.mevblocker.io` | all | Ethereum mainnet JSON-RPC |
| `DATABASE_URL` | `postgres://susds:susds@localhost:5432/susds` | backfill, `--from-db` | Postgres connection |
| `CHUNK_SIZE` | 10,000                 | all     | Initial blocks per `getLogs` |
| `FROM_BLOCK` | latest − 50,400        | index   | Start of range (decimal) |
| `TO_BLOCK`   | latest / finalized     | index, backfill | End of range; backfill caps it at finalized |
| `BLOCK_NUMBER` | finalized            | reconcile (RPC mode) | Pin block N |

### Adaptive chunking

`CHUNK_SIZE` is only the starting point. Public RPCs fail requests for two
distinct reasons — the range is too wide, or the endpoint is transiently
unhealthy — and the fetcher treats them differently: halving fixes the
first, waiting fixes the second. Only when neither can help (repeated
failure at the 500-block minimum) does it abort:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Fetch
    Fetch --> Fetch: ok — advance, grow +1000
    Fetch --> Backoff: error — halve, floor 500
    Fetch --> Abort: floor + streak > 3
    Backoff --> Fetch: wait 3s × streak
    Abort --> [*]: exit 1
```

In full: a successful chunk advances the cursor, resets the failure streak,
and grows the chunk size by 1,000 blocks back toward the initial size. A
failed request increments the streak, halves the chunk size (never below
the 500-block floor), and waits 3 s × streak (capped at 15 s) before
retrying the same window. If a request fails while the chunk is already at
the floor and the streak exceeds 3, shrinking is ruled out and waiting has
been tried — the walk aborts with exit 1 and the underlying RPC error
attached as `cause`.

### Provider constraints

Findings from running the full pipeline against keyless endpoints
(2026-07):

- Keyless endpoints throttle on **sustained** load, not per-request: one
  endpoint served 100-header batches in ~2 s each, then temp-banned the IP
  (Cloudflare 1015) after ~150 back-to-back batches. `src/backfill-timestamps.ts`
  paces deliberately (250-block slices, 1 s between, endpoint rotation) for
  this reason — don't "optimize" the delays away.
- Retry backoff must outlast the throttle window: 30 s retries all died
  inside one endpoint's 429 window; the script waits 30/60/120/180 s.
- Capabilities are per call type, not per endpoint: publicnode refuses
  historical `getLogs`/`getCode` as archive requests but serves batched
  historical block headers fine (headers aren't archive state).
- Verified working (2026-07): `rpc.mevblocker.io` — 10k-block `getLogs`,
  historical `eth_call`, `finalized` tag, batched headers; `eth.drpc.org` —
  same but ≤10k `getLogs` and earlier bans on heavy use;
  `ethereum-rpc.publicnode.com` — batched headers and recent-range calls
  only.
- If a run dies mid-way anyway, nothing is lost: both backfills resume
  from what's stored (watermark / missing-blocks query).

### Example: historical range

sUSDS was deployed at block **20,677,434** (2024-09-04); first deposit
activity begins around block **20,770,669** (Sky public launch, 2024-09-17).
To index the launch window:

```sh
FROM_BLOCK=20770000 TO_BLOCK=20790000 npx tsx src/index.ts
```
