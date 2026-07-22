/**
 * susds-indexer — static SVG chart generation.
 *
 * Reads Postgres, writes three SVGs to charts/. Hand-rolled SVG on purpose:
 * the charts need linear scales, ticks, one path or rect loop, and a footer
 * — comparable effort to configuring a charting dependency, with zero deps,
 * and full control over the dark-mode <style> block and fail-loud rules
 * (repo rule 5: no framework, every line explainable).
 *
 * Query logic sharing (drift policy):
 *  - TVL chart EXECUTES queries/01_tvl_daily.sql verbatim at runtime — one
 *    copy of the logic, no drift possible.
 *  - Net-flows and APY charts use VARIANTS inlined below: the .sql files
 *    answer a "last 14 days" / single-scalar version of the question, the
 *    charts need 90 days / a full time series. Each variant carries a
 *    cross-reference comment, and queries/02+03 point back here. If you
 *    change the aggregation logic in either place, change both.
 *
 * Fail-loud thresholds (a chart must never quietly render from a
 * half-populated database):
 *  - TVL:       >= 600 daily rows   (673 exist at time of writing)
 *  - Net flows: exactly 90 rows    (complete UTC days, partial day excluded)
 *  - APY:       >= 570 daily rows   (643 exist: 673 minus the 30-day ramp)
 *
 * Run: npx tsx src/charts.ts
 * Env: DATABASE_URL
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createPool } from "./lib/db.js";

// ---------------------------------------------------------------------------
// Layout + theme
// ---------------------------------------------------------------------------

const W = 920;
const H = 380;
const MARGIN = { top: 44, right: 48, bottom: 56, left: 72 };
const PLOT_W = W - MARGIN.left - MARGIN.right;
const PLOT_H = H - MARGIN.top - MARGIN.bottom;

/**
 * Theme-neutral palette: mid-tone colors legible on GitHub's white AND dark
 * backgrounds (an SVG in an <img> follows the OS color scheme, not GitHub's
 * theme toggle, so neutrality is the baseline and the media query is only
 * an enhancement for text contrast).
 */
const STYLE = `
  text { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; fill: #768390; }
  .title { font-size: 15px; font-weight: 600; fill: #768390; }
  .footer { font-size: 10px; fill: #768390; opacity: 0.85; }
  .axis { stroke: #768390; stroke-width: 1; }
  .grid { stroke: #768390; stroke-width: 0.5; opacity: 0.25; }
  .line { stroke: #4493f8; stroke-width: 1.8; fill: none; }
  .pos { fill: #3fb950; }
  .neg { fill: #f85149; }
  @media (prefers-color-scheme: dark) {
    text, .title, .footer { fill: #9198a1; }
  }
`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------------------------------------------------------------------------
// Scales, ticks, formatting
// ---------------------------------------------------------------------------

const scale = (v: number, d0: number, d1: number, r0: number, r1: number) =>
  r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);

/**
 * 1/2/5×10^k step ticks whose range fully ENCLOSES [min, max] — first tick
 * <= min, last tick >= max. The tick extremes are also the scale domain, so
 * no data point can ever render outside the plot area (the first version
 * capped at the last tick below max, and the TVL peak escaped over the
 * title).
 */
function niceTicks(min: number, max: number): number[] {
  const span = max - min;
  const raw = span / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => span / s <= 6) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; ; v += step) {
    ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    if (v >= max - step / 1e6) break;
  }
  return ticks;
}

/** 4751302119 -> "4.75B", 28089045 -> "28M", -540482324 -> "-540M". */
function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const f = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2))
    .replace(/\.0+$/, "");
  if (a >= 1e9) return `${f(v / 1e9)}B`;
  if (a >= 1e6) return `${f(v / 1e6)}M`;
  if (a >= 1e3) return `${f(v / 1e3)}K`;
  return `${v}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Month-boundary ticks; labels every `every` months ("Jan '25"). */
function dateTicks(days: Date[], every: number): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  while (d <= last) {
    if (d.getUTCMonth() % every === 0) {
      out.push({
        t: d.getTime(),
        label: `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear() % 100).padStart(2, "0")}`,
      });
    }
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SVG assembly
// ---------------------------------------------------------------------------

interface ChartFrame {
  title: string;
  yLabel: string;
  yTicks: number[];
  yMin: number;
  yMax: number;
  xTicks: { t: number; label: string }[];
  xMin: number;
  xMax: number;
  yFmt: (v: number) => string;
  body: string;
  footer: string;
}

function renderSvg(f: ChartFrame): string {
  const x = (t: number) => scale(t, f.xMin, f.xMax, MARGIN.left, MARGIN.left + PLOT_W);
  const y = (v: number) => scale(v, f.yMin, f.yMax, MARGIN.top + PLOT_H, MARGIN.top);
  const grid = f.yTicks
    .map((v) => `<line class="grid" x1="${MARGIN.left}" x2="${MARGIN.left + PLOT_W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`)
    .join("\n  ");
  const yLabels = f.yTicks
    .map((v) => `<text x="${MARGIN.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(f.yFmt(v))}</text>`)
    .join("\n  ");
  const xLabels = f.xTicks
    .map(({ t, label }) => `<text x="${x(t).toFixed(1)}" y="${MARGIN.top + PLOT_H + 18}" text-anchor="middle">${esc(label)}</text>`)
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>${STYLE}</style>
  <text class="title" x="${MARGIN.left}" y="24">${esc(f.title)}</text>
  <text transform="rotate(-90)" x="${-(MARGIN.top + PLOT_H / 2)}" y="16" text-anchor="middle">${esc(f.yLabel)}</text>
  ${grid}
  <line class="axis" x1="${MARGIN.left}" x2="${MARGIN.left + PLOT_W}" y1="${y(Math.max(f.yMin, 0)).toFixed(1)}" y2="${y(Math.max(f.yMin, 0)).toFixed(1)}"/>
  ${yLabels}
  ${xLabels}
  ${f.body}
  <text class="footer" x="${MARGIN.left}" y="${H - 8}">${esc(f.footer)}</text>
</svg>
`;
}

function footer(source: string, watermark: string): string {
  return `source: ${source} · susds-indexer · generated ${new Date().toISOString()} · watermark block ${watermark}`;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pool = createPool();
  const wm = await pool.query("SELECT highest_indexed_block::text AS b FROM indexing_state");
  if (wm.rows.length !== 1) throw new Error("indexing_state is empty — run backfill first.");
  const watermark = Number((wm.rows[0] as { b: string }).b).toLocaleString("en-US");
  mkdirSync("charts", { recursive: true });

  // ---- 1. TVL over time: executes queries/01_tvl_daily.sql verbatim ------
  const tvlSql = readFileSync("queries/01_tvl_daily.sql", "utf8");
  const tvl = await pool.query(tvlSql);
  if (tvl.rows.length < 600) {
    throw new Error(
      `TVL chart: expected >= 600 daily rows (673 at time of writing), got ${tvl.rows.length}. ` +
        `Refusing to render from a partial database.`,
    );
  }
  const tvlPts = tvl.rows.map((r: { day: Date; tvl_usds: string }) => ({
    t: r.day.getTime(),
    v: Number(r.tvl_usds), // display precision only; exact values stay in the DB
  }));
  {
    const days = tvl.rows.map((r: { day: Date }) => r.day);
    const yMax = Math.max(...tvlPts.map((p) => p.v));
    const yTicks = niceTicks(0, yMax);
    const xMin = tvlPts[0]!.t, xMax = tvlPts[tvlPts.length - 1]!.t;
    const x = (t: number) => scale(t, xMin, xMax, MARGIN.left, MARGIN.left + PLOT_W);
    const y = (v: number) => scale(v, 0, yTicks[yTicks.length - 1]!, MARGIN.top + PLOT_H, MARGIN.top);
    const path = tvlPts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    writeFileSync("charts/tvl.svg", renderSvg({
      title: "sUSDS TVL — full history",
      yLabel: "USDS",
      yTicks, yMin: 0, yMax: yTicks[yTicks.length - 1]!,
      xTicks: dateTicks(days, 3), xMin, xMax,
      yFmt: fmtUsd,
      body: `<path class="line" d="${path}"/>`,
      footer: footer("queries/01_tvl_daily.sql (executed verbatim)", watermark),
    }));
  }

  // ---- 2. Daily net flows, last 90 complete days --------------------------
  // VARIANT of queries/03_net_flows_daily.sql (which shows the last 14 days
  // in a table): same aggregation, fixed 90-complete-day window, partial
  // current day excluded so the newest bar is never misleadingly small.
  // If you change the flow logic here, change 03_net_flows_daily.sql too.
  const flows = await pool.query(`
    WITH flows AS (
        SELECT block_number, assets AS in_wei, 0::numeric AS out_wei FROM deposit_events
        UNION ALL
        SELECT block_number, 0::numeric, assets FROM withdraw_events
    )
    SELECT date_trunc('day', b.block_timestamp)::date AS day,
           round(SUM(in_wei)  / 1e18, 0)::float8 AS gross_in,
           round(SUM(out_wei) / 1e18, 0)::float8 AS gross_out
    FROM flows f JOIN blocks b USING (block_number)
    WHERE b.block_timestamp >= (current_date - 90)::timestamptz
      AND b.block_timestamp <  current_date::timestamptz
    GROUP BY 1 ORDER BY 1`);
  if (flows.rows.length !== 90) {
    throw new Error(
      `Net-flows chart: expected exactly 90 complete days, got ${flows.rows.length}. ` +
        `Refusing to render a partial window.`,
    );
  }
  {
    const rows = flows.rows as { day: Date; gross_in: number; gross_out: number }[];
    const days = rows.map((r) => r.day);
    const peak = Math.max(...rows.map((r) => Math.max(r.gross_in, r.gross_out)));
    const yTicks = niceTicks(-peak, peak);
    const yMin = yTicks[0]!, yMax = yTicks[yTicks.length - 1]!;
    const xMin = days[0]!.getTime(), xMax = days[days.length - 1]!.getTime();
    const x = (t: number) => scale(t, xMin, xMax, MARGIN.left, MARGIN.left + PLOT_W);
    const y = (v: number) => scale(v, yMin, yMax, MARGIN.top + PLOT_H, MARGIN.top);
    const bw = (PLOT_W / 90) * 0.75;
    const bars = rows.map((r) => {
      const cx = x(r.day.getTime()) - bw / 2;
      const up = `<rect class="pos" x="${cx.toFixed(1)}" y="${y(r.gross_in).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(r.gross_in)).toFixed(1)}"/>`;
      const dn = `<rect class="neg" x="${cx.toFixed(1)}" y="${y(0).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(-r.gross_out) - y(0)).toFixed(1)}"/>`;
      return up + dn;
    }).join("\n  ");
    writeFileSync("charts/net-flows.svg", renderSvg({
      title: "Daily gross flows, last 90 days — deposits up, withdrawals down",
      yLabel: "USDS / day",
      yTicks, yMin, yMax,
      xTicks: dateTicks(days, 1), xMin, xMax,
      yFmt: (v) => fmtUsd(Math.abs(v)),
      body: bars,
      footer: footer("variant of queries/03_net_flows_daily.sql (90 complete days)", watermark),
    }));
  }

  // ---- 3. Realized APY, trailing 30d, over time ---------------------------
  // VARIANT of queries/02_apy_realized.sql (which computes today's scalar):
  // same chi-ratio + real-seconds annualization, evaluated for EVERY day
  // against the daily chi 30 days earlier. If you change the APY formula
  // here, change 02_apy_realized.sql too.
  const apy = await pool.query(`
    WITH daily AS (
        SELECT DISTINCT ON (date_trunc('day', b.block_timestamp))
               date_trunc('day', b.block_timestamp)::date AS day,
               d.chi, b.block_timestamp AS ts
        FROM drip_events d JOIN blocks b USING (block_number)
        ORDER BY date_trunc('day', b.block_timestamp), d.block_number DESC, d.log_index DESC
    )
    SELECT a.day,
           (exp( ln((a.chi / p.chi)::float8)
                 * (31536000.0 / EXTRACT(EPOCH FROM a.ts - p.ts)::float8) ) - 1) * 100 AS apy_pct
    FROM daily a JOIN daily p ON p.day = a.day - 30
    ORDER BY a.day`);
  if (apy.rows.length < 570) {
    throw new Error(
      `APY chart: expected >= 570 daily rows (643 at time of writing: 673 minus ` +
        `the 30-day ramp), got ${apy.rows.length}. Refusing to render from a partial database.`,
    );
  }
  {
    const rows = apy.rows as { day: Date; apy_pct: number }[];
    const days = rows.map((r) => r.day);
    const yMax = Math.max(...rows.map((r) => r.apy_pct));
    const yTicks = niceTicks(0, yMax);
    const xMin = days[0]!.getTime(), xMax = days[days.length - 1]!.getTime();
    const x = (t: number) => scale(t, xMin, xMax, MARGIN.left, MARGIN.left + PLOT_W);
    const y = (v: number) => scale(v, 0, yTicks[yTicks.length - 1]!, MARGIN.top + PLOT_H, MARGIN.top);
    const path = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(r.day.getTime()).toFixed(1)},${y(r.apy_pct).toFixed(1)}`).join("");
    writeFileSync("charts/apy-30d.svg", renderSvg({
      title: "Realized APY, trailing 30 days",
      yLabel: "% APY",
      yTicks, yMin: 0, yMax: yTicks[yTicks.length - 1]!,
      xTicks: dateTicks(days, 3), xMin, xMax,
      yFmt: (v) => `${v}%`,
      body: `<path class="line" d="${path}"/>`,
      footer: footer("variant of queries/02_apy_realized.sql (30d window per day)", watermark),
    }));
  }

  console.log("charts/tvl.svg, charts/net-flows.svg, charts/apy-30d.svg written.");
  await pool.end();
}

main().catch((error) => {
  console.error("\nFATAL:", error);
  process.exit(1);
});
