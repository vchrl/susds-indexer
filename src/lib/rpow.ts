/**
 * Bigint port of SUsds._rpow (SUsds.sol, verified implementation at
 * 0x4e7991e5c547ce825bdeb665ee14a3274f9f61e0) — Maker's fixed-point
 * exponentiation by squaring in ray (1e27) with half-ray rounding at every
 * multiplication step.
 *
 * The port must match the contract bit-for-bit because reconciliation
 * (check 4) recomputes the contract's virtual rate accumulator
 *   chi_virtual = rpow(ssr, now - rho) * chi / RAY
 * and compares the result against totalAssets() with ZERO tolerance. Any
 * deviation in rounding order would show up as a false divergence.
 *
 * One difference from the Solidity original: the assembly reverts on uint256
 * overflow, while JS bigints cannot overflow. Whenever the on-chain call
 * succeeded (i.e. produced the state we are reconciling against), no revert
 * occurred, so the two implementations agree on every value we compare.
 *
 * Worked example (per-second rate of 1 + 1e-9, squared):
 *   rpow(1_000_000_001_000_000_000_000_000_000n, 2n)
 *     = 1_000_000_002_000_000_001_000_000_000n
 *   i.e. (1 + 1e-9)^2 = 1 + 2e-9 + 1e-18, exact in ray.
 */

export const RAY = 10n ** 27n;

export function rpow(x: bigint, n: bigint): bigint {
  if (x === 0n) return n === 0n ? RAY : 0n;
  let z = n % 2n === 0n ? RAY : x;
  const half = RAY / 2n;
  for (n = n / 2n; n > 0n; n = n / 2n) {
    x = (x * x + half) / RAY;
    if (n % 2n === 1n) z = (z * x + half) / RAY;
  }
  return z;
}
