/**
 * susds-indexer — reconciliation against live contract state.
 *
 * Indexes every Deposit/Withdraw/Drip event from deployment to a pinned
 * block N, then verifies four invariants against contract state read at N.
 * All four checks are EXACT (tolerance zero) — see README "Reconciliation"
 * for the derivation. Any divergence exits non-zero (CLAUDE.md rule 3:
 * divergence is an error, not a warning).
 *
 * Run: npx tsx src/reconcile.ts             (re-index from RPC, ~500 chunks,
 *                                            several minutes on a public RPC)
 *      npx tsx src/reconcile.ts --from-db   (use events stored by backfill;
 *                                            pins to the stored watermark)
 * Env: RPC_URL, CHUNK_SIZE, DATABASE_URL (--from-db only),
 *      BLOCK_NUMBER (RPC mode only; default: finalized)
 */

import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import {
  SUSDS_ADDRESS,
  DEPLOYMENT_BLOCK,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RPC_URL,
  fetchLogsInChunks,
  parseBlockEnv,
  type DripEvent,
} from "./lib/fetch.js";
import { RAY, rpow } from "./lib/rpow.js";
import { createPool, getIndexingState, getStoredTotals } from "./lib/db.js";

const readAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function chi() view returns (uint192)",
  "function rho() view returns (uint64)",
  "function ssr() view returns (uint256)",
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

interface CheckResult {
  name: string;
  indexed: bigint;
  contract: bigint;
  pass: boolean;
  diagnosis?: string;
}

const fmtRel = (diff: bigint, reference: bigint): string => {
  if (reference === 0n) return diff === 0n ? "0" : "inf";
  // Float is fine here: display only, never stored or compared.
  return `${((Number(diff) / Number(reference)) * 100).toExponential(2)}%`;
};

function printCheck(c: CheckResult): void {
  const diff = c.indexed > c.contract ? c.indexed - c.contract : c.contract - c.indexed;
  console.log(`\nCheck: ${c.name} — ${c.pass ? "PASS" : "FAIL"}`);
  console.log(`  indexed value:  ${c.indexed}`);
  console.log(`  contract value: ${c.contract}`);
  console.log(`  absolute diff:  ${diff} wei`);
  console.log(`  relative diff:  ${fmtRel(diff, c.contract)}`);
  if (!c.pass && c.diagnosis !== undefined) console.log(`  diagnosis:      ${c.diagnosis}`);
}

/** Event-derived quantities the four checks consume, whatever their source. */
interface IndexedTotals {
  depositShares: bigint;
  withdrawShares: bigint;
  depositAssets: bigint;
  withdrawAssets: bigint;
  accrued: bigint;
  lastDrip: { chi: bigint; blockNumber: bigint; logIndex: number };
}

async function main(): Promise<void> {
  const fromDb = process.argv.includes("--from-db");
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { retryCount: 2 }),
  });

  // Pin block N. In RPC mode: the finalized head (reorg safety) or a
  // BLOCK_NUMBER override. In --from-db mode: the stored watermark, so that
  // stored events and contract state describe the same block — BLOCK_NUMBER
  // is rejected there rather than silently ignored. There is deliberately NO
  // fallback to "latest": if the RPC cannot serve the pin block, or any
  // pinned read below fails (e.g. no archive data), the resulting throw
  // propagates to the FATAL handler and the process exits non-zero.
  // The block's timestamp — needed for check 4's rpow extrapolation — comes
  // from the same eth_getBlockByNumber response that fixes N, so timestamp
  // and eth_call pins always describe the same block on the same RPC.
  const override = parseBlockEnv("BLOCK_NUMBER");
  let totals: IndexedTotals;
  let N: bigint;
  let timestampN: bigint;
  let pinLabel: string;

  if (fromDb) {
    if (override !== null) {
      throw new Error(
        "BLOCK_NUMBER cannot be combined with --from-db: the pin is always the stored " +
          "watermark, because stored events only describe the chain up to that block.",
      );
    }
    const pool = createPool();
    const state = await getIndexingState(pool);
    if (state === null) {
      throw new Error("indexing_state is empty — run src/backfill.ts before --from-db.");
    }
    const block = await client.getBlock({ blockNumber: state.highestIndexedBlock });
    if (block.hash !== state.highestBlockHash) {
      throw new Error(
        `REORG TRIPWIRE: stored hash for watermark block ${state.highestIndexedBlock} is ` +
          `${state.highestBlockHash} but the chain reports ${block.hash}. Stored events ` +
          `cannot be trusted against this RPC; see README "Reorg safety".`,
      );
    }
    N = state.highestIndexedBlock;
    timestampN = block.timestamp;
    pinLabel = "stored watermark";
    const stored = await getStoredTotals(pool);
    await pool.end();
    if (stored.lastDrip === null) {
      throw new Error("No Drip events stored; the database does not contain a full index.");
    }
    totals = { ...stored, lastDrip: stored.lastDrip };
    console.log(`RPC:   ${rpcUrl}`);
    console.log(`Pin:   block ${N} (${pinLabel}, timestamp ${timestampN})`);
    console.log(
      `Using stored events: ${stored.depositCount} deposits, ${stored.withdrawCount} withdraws, ` +
        `${stored.dripCount} drips (watermark hash verified against chain).`,
    );
  } else {
    const block =
      override !== null
        ? await client.getBlock({ blockNumber: override })
        : await client.getBlock({ blockTag: "finalized" });
    if (block.number === null || block.timestamp === null) {
      throw new Error(`RPC returned a pending block for the reconciliation pin: ${JSON.stringify(block)}`);
    }
    N = block.number;
    timestampN = block.timestamp;
    pinLabel = override !== null ? "BLOCK_NUMBER override" : "finalized";
    if (N < DEPLOYMENT_BLOCK) {
      throw new Error(
        `Reconciliation block ${N} predates sUSDS deployment (${DEPLOYMENT_BLOCK}); nothing to reconcile.`,
      );
    }

    const chunkSize = parseBlockEnv("CHUNK_SIZE") ?? DEFAULT_CHUNK_SIZE;
    console.log(`RPC:   ${rpcUrl}`);
    console.log(`Pin:   block ${N} (${pinLabel}, timestamp ${timestampN})`);
    console.log(`Range: ${DEPLOYMENT_BLOCK} -> ${N} (~${(N - DEPLOYMENT_BLOCK) / 10_000n} chunks; a full run takes several minutes)\n`);

    const { events, chunksFetched, chunkFailures } = await fetchLogsInChunks(
      client,
      DEPLOYMENT_BLOCK,
      N,
      chunkSize,
    );

    let depositShares = 0n, withdrawShares = 0n;
    let depositAssets = 0n, withdrawAssets = 0n;
    let accrued = 0n;
    let lastDrip: DripEvent | null = null;
    for (const e of events) {
      if (e.kind === "Deposit") {
        depositShares += e.shares;
        depositAssets += e.assets;
      } else if (e.kind === "Withdraw") {
        withdrawShares += e.shares;
        withdrawAssets += e.assets;
      } else {
        accrued += e.diff;
        // Events arrive in block/logIndex order, but re-derive "latest" from
        // provenance rather than trusting array order or max(chi).
        if (
          lastDrip === null ||
          e.blockNumber > lastDrip.blockNumber ||
          (e.blockNumber === lastDrip.blockNumber && e.logIndex > lastDrip.logIndex)
        ) {
          lastDrip = e;
        }
      }
    }
    if (lastDrip === null) {
      throw new Error(
        `No Drip events indexed over ${DEPLOYMENT_BLOCK}-${N}; the full range must contain drips. ` +
          `This indicates a fetch gap, not an empty chain.`,
      );
    }
    totals = { depositShares, withdrawShares, depositAssets, withdrawAssets, accrued, lastDrip };
    console.log(
      `\nIndexed ${events.length} events in ${chunksFetched} chunks (${chunkFailures} failed attempts).`,
    );
  }

  const { accrued, lastDrip } = totals;
  const indexedShares = totals.depositShares - totals.withdrawShares;
  const indexedBalance = totals.depositAssets - totals.withdrawAssets + accrued;

  // ---- Contract reads, all pinned to block N -------------------------------
  const readAt = <F extends "totalSupply" | "totalAssets" | "chi" | "rho" | "ssr" | "asset">(fn: F) =>
    client.readContract({ address: SUSDS_ADDRESS, abi: readAbi, functionName: fn, blockNumber: N });
  const [totalSupply, totalAssets, chi, rho, ssr, usdsAddress, sharePrice] = await Promise.all([
    readAt("totalSupply"),
    readAt("totalAssets"),
    readAt("chi"),
    readAt("rho"),
    readAt("ssr"),
    readAt("asset"),
    client.readContract({
      address: SUSDS_ADDRESS, abi: readAbi, functionName: "convertToAssets",
      args: [10n ** 18n], blockNumber: N,
    }),
  ]);
  const usdsBalance = await client.readContract({
    address: usdsAddress,
    abi: readAbi,
    functionName: "balanceOf",
    args: [SUSDS_ADDRESS],
    blockNumber: N,
  });

  // ---- Check 4 inputs: replicate the contract's virtual accumulator --------
  // totalAssets() extrapolates chi to the current timestamp (SUsds.sol
  // convertToAssets): chi_ = rpow(ssr, now - rho) * chi / RAY when now > rho.
  // We recompute it from the INDEXED chi (check 2 asserts it equals the
  // stored one) plus ssr/rho reads and the pinned block's timestamp.
  const dt = timestampN - rho;
  if (dt < 0n) {
    throw new Error(
      `rho (${rho}) is after block ${N}'s timestamp (${timestampN}); ` +
        `the RPC served inconsistent state.`,
    );
  }
  const virtualChi = dt > 0n ? (rpow(ssr, dt) * lastDrip.chi) / RAY : lastDrip.chi;

  const checks: CheckResult[] = [
    {
      name: "1: net Deposit/Withdraw shares == totalSupply()",
      indexed: indexedShares,
      contract: totalSupply,
      pass: indexedShares === totalSupply,
      diagnosis:
        "Share conservation is exact by construction (_mint/_burn move exactly the emitted shares); " +
        "any diff means missed or double-counted events.",
    },
    {
      name: "2: latest indexed Drip.chi == chi()",
      indexed: lastDrip.chi,
      contract: chi,
      pass: lastDrip.chi === chi,
      diagnosis:
        `Stored chi is by construction the nChi of the last Drip (last indexed: block ${lastDrip.blockNumber}, ` +
        `logIndex ${lastDrip.logIndex}); any diff means a missed Drip event.`,
    },
    {
      name: "3: net assets + accrued yield == usds.balanceOf(sUSDS)",
      indexed: indexedBalance,
      contract: usdsBalance,
      pass: indexedBalance === usdsBalance,
      diagnosis:
        usdsBalance > indexedBalance
          ? "Contract holds MORE than events account for: unexplained external inflow, most likely a " +
            "direct USDS transfer (donation) — invisible to Deposit/Withdraw/Drip."
          : "Contract holds LESS than events account for: missed or double-counted events, or an RPC " +
            "gap. Treat as an indexer bug until proven otherwise.",
    },
    {
      name: "4: floor(indexedShares * rpow(ssr, tN-rho) * chi / RAY / RAY) == totalAssets()",
      indexed: (indexedShares * virtualChi) / RAY,
      contract: totalAssets,
      pass: (indexedShares * virtualChi) / RAY === totalAssets,
      diagnosis:
        "The rpow extrapolation replicates SUsds.convertToAssets exactly; a diff means wrong " +
        "indexed shares/chi, a non-matching rpow port, or a timestamp not belonging to block N.",
    },
  ];

  // Secondary sanity for check 4: the same virtual chi must reproduce the
  // quoted share price. Uses only contract-read inputs, so it isolates the
  // rpow port from indexing errors.
  const expectedSharePrice = (10n ** 18n * virtualChi) / RAY;
  console.log(
    `\nShare price sanity: convertToAssets(1e18) = ${sharePrice}, ` +
      `floor(1e18 * virtualChi / RAY) = ${expectedSharePrice} ` +
      `(match=${sharePrice === expectedSharePrice})`,
  );
  if (sharePrice !== expectedSharePrice) {
    checks[3]!.pass = false;
    checks[3]!.diagnosis =
      "convertToAssets(1e18) does not match the replicated virtual chi — the rpow port or the " +
      "chi/rho/ssr/timestamp inputs are wrong (independent of indexed events).";
  }

  console.log(`\n=== sUSDS reconciliation @ block ${N} ===`);
  console.log(`totalAssets: ${formatUnits(totalAssets, 18)} USDS | totalSupply: ${formatUnits(totalSupply, 18)} sUSDS`);
  console.log(`undripped accrual included in totalAssets: ${formatUnits(totalAssets - (totalSupply * chi) / RAY, 18)} USDS (${dt}s since last drip)`);
  for (const c of checks) printCheck(c);

  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(`\nRESULT: FAIL (${failed.length}/${checks.length} checks diverged)`);
    process.exit(1);
  }
  console.log(`\nRESULT: PASS (${checks.length}/${checks.length} checks exact)`);
}

main().catch((error) => {
  console.error("\nFATAL:", error);
  process.exit(1);
});
