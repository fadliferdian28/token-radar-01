// token-radar-01 v3 — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the size curve on the dated
// comparables, prices every rankable protocol, multiplies in the launch
// odds, runs the out-of-sample validation suite, costs the farm plans,
// and writes the board, the dashboard's data, and the dossier.
//
//   node main.ts --input <snapshot.json>
//   MAKEFUN_OUTPUT_DIR stands in for /output outside the grader.
// The grader runs it twice; both runs write identical bytes (fixed
// seeds, no clocks, no randomness anywhere in the outputs).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapRanks,
  buildOddsTable,
  familyShifts,
  fitLine,
  priceRows,
  tuneShrinkage,
  type PricedRow,
} from "./lib/pricing.ts";
import { runValidation } from "./lib/validate.ts";
import {
  breakEvenDeposit,
  DEFAULT_DEPOSIT,
  DEFAULT_SHARE,
  farmPlan,
  priceEcon,
  verdictTally,
} from "./lib/farm.ts";
import {
  buildComps,
  rankable,
  recordsToken,
  setAsideWhy,
  type Snap,
} from "./lib/snap.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const ROOTDIR = dirname(fileURLToPath(import.meta.url));

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? null : eq.slice(name.length + 3);
}

function copyTree(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    copyFileSync(join(from, name), join(to, name));
    names.push(name);
  }
  return names.sort();
}

/** The gate's board rules, checked here so a bad board never ships. */
function boardProblem(
  rows: Array<{
    slug: string;
    rank: number;
    implied_value_usd: number;
    farm_steps: string[];
  }>,
  snap: Snap,
): string | null {
  if (rows.length < 100 || rows.length > 4000) {
    return `board holds ${rows.length} rows, outside 100–4000`;
  }
  const known = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Infinity;
  for (const r of rows) {
    if (!known.has(r.slug)) return `row names ${r.slug}, not in the snapshot`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (r.implied_value_usd <= 0 || !Number.isInteger(r.implied_value_usd)) {
      return `row ${r.slug} has a non-positive or non-integer implied value`;
    }
    if (r.implied_value_usd > prev) {
      return `implied value rises at rank ${r.rank}`;
    }
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.slug} holds ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) {
        return `row ${r.slug} holds a farm step of ${len} characters`;
      }
    }
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `ranks are not exactly 1–${rows.length}`;
  }
  for (const slug of snap.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing`;
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length > 1 && values.size === 1) {
    return "every implied value is the same";
  }
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputArg = flagValue(argv, "input") ?? "/input";
  const inputFile = inputArg.endsWith(".json")
    ? inputArg
    : join(inputArg, "snapshot.json");
  if (!existsSync(inputFile)) {
    process.stderr.write(
      `token radar v3: no snapshot at ${inputFile} (pass --input <snapshot.json|directory>)\n`,
    );
    process.exit(2);
  }
  const outDir =
    flagValue(argv, "output") ??
    process.env.MAKEFUN_OUTPUT_DIR ??
    "/output";

  const snap = JSON.parse(readFileSync(inputFile, "utf-8")) as Snap;

  /* --- Fit: dated comparables, shrinkage tuned by leave-one-out. --- */
  const { list: comps, droppedZeroCap, winsorized } = buildComps(
    snap.protocols,
  );
  const dated = comps.filter((c) => c.listedAt !== null);
  const tuning = tuneShrinkage(dated);
  const line = fitLine(dated);
  const shifts = familyShifts(dated, line, tuning.k, tuning.minN);

  /* --- Price the board; odds multiply into the ranking value. --- */
  const oddsTable = buildOddsTable(snap);
  const board = snap.protocols.filter(rankable);
  const rows: PricedRow[] = priceRows(snap, board, line, shifts, oddsTable);
  const slopeStats = bootstrapRanks(
    snap,
    board,
    dated,
    tuning.k,
    tuning.minN,
    oddsTable,
    rows,
  );

  /* --- Validate out of sample. --- */
  const validation = runValidation(
    dated,
    comps,
    tuning.k,
    tuning.minN,
    tuning.curveOnlyLoo,
    rows,
  );

  /* --- Farm economics at the default deposit and drop share. --- */
  const boardRows = rows.map((r, i) => {
    const econ = priceEcon(r, DEFAULT_DEPOSIT, DEFAULT_SHARE);
    return {
      slug: r.slug,
      name: r.name,
      rank: i + 1,
      implied_value_usd: Math.round(r.implied),
      farm_steps: farmPlan(r, DEFAULT_DEPOSIT),
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl,
      change_7d: r.change7d,
      age_days: r.ageDays,
      watchlist: r.watchlist,
      forward_tvl_usd: Math.round(r.forwardTvl),
      curve_value_usd: Math.round(r.curveValue),
      family_offset: r.familyOffset,
      family_n: r.familyN,
      value_if_launches_usd: Math.round(r.valueIfLaunches),
      category_rate: r.categoryRate,
      age_bucket: r.ageBucket,
      age_factor: r.ageFactor,
      launch_odds: r.odds,
      rank_lo: r.rankLo,
      rank_hi: r.rankHi,
      same_name_trades: r.sameNameTrades,
      econ_default: {
        deposit: econ.deposit,
        share: econ.share,
        slice: econ.slice,
        expected_usd: econ.expected,
        fees_usd: econ.fees,
        forgone_usd: econ.forgone,
        exit_cost_usd: econ.exitCost,
        net_usd: econ.net,
        per_hour_usd: econ.perHour,
        verdict: econ.verdict,
      },
      break_even_usd: breakEvenDeposit(r, DEFAULT_SHARE),
    };
  });

  const problem = boardProblem(boardRows, snap);
  if (problem !== null) {
    process.stderr.write(`token radar v3: the board fails its own check: ${problem}\n`);
    process.exit(1);
  }

  /* --- The protocols kept apart: trading, and set aside with reasons. --- */
  const traded = snap.protocols
    .filter(recordsToken)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      chains: p.chains,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
    }))
    .sort((a, b) => (b.mcap ?? -1) - (a.mcap ?? -1));
  const setAside = snap.protocols
    .filter((p) => !recordsToken(p) && !rankable(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      tvl: p.tvl_usd,
      reason: setAsideWhy(p),
    }))
    .sort((a, b) => b.tvl - a.tvl);
  const asideBreakdown = new Map<string, number>();
  for (const s of setAside) {
    asideBreakdown.set(s.reason, (asideBreakdown.get(s.reason) ?? 0) + 1);
  }

  const offsets = [...shifts.entries()]
    .map(([category, o]) => ({ category, offset: o.shift, n: o.n }))
    .sort((a, b) => a.n === b.n ? a.category.localeCompare(b.category) : b.n - a.n);

  const data = {
    asOf: snap.as_of,
    source: snap.source,
    floorUsd: snap.floor_usd,
    counts: {
      total: snap.protocols.length,
      ranked: rows.length,
      trading: traded.length,
      setAside: setAside.length,
      watchlist: snap.watchlist.length,
      watchCovered: rows.filter((r) => r.watchlist).length,
    },
    asideBreakdown: [...asideBreakdown.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n),
    fit: {
      intercept: line.intercept,
      slope: line.slope,
      rmse: line.rmse,
      n: line.n,
      allComps: comps.length,
      datedComps: dated.length,
      undatedComps: comps.length - dated.length,
      droppedZeroCap,
      winsorized,
      k: tuning.k,
      minN: tuning.minN,
      tuningGrid: tuning.grid,
      curveOnlyLoo: tuning.curveOnlyLoo,
    },
    odds: {
      globalLaunched: oddsTable.globalLaunched,
      globalTotal: oddsTable.globalTotal,
      globalRate: oddsTable.globalRate,
      datedRate: oddsTable.datedRate,
      buckets: oddsTable.buckets,
      typicalWaitDays: oddsTable.typicalWaitDays,
    },
    validation,
    slopeStats,
    offsets,
    econParams: {
      deposits: [100, 1000, 5000, 10000],
      shares: [0.035, 0.07, 0.14],
      defaultDeposit: DEFAULT_DEPOSIT,
      defaultShare: DEFAULT_SHARE,
      planWeeks: 12,
      planDays: 84,
      planHours: 8.5,
      sliceCap: 0.001,
      tbill: 0.0432,
      farmLine: 5,
      floatAtLaunch: 0.15,
      dailyTurnover: 0.05,
      slipK: 0.1,
      txPerPlan: 5,
      gas: {
        Ethereum: 10,
        Base: 0.05,
        Arbitrum: 0.08,
        Optimism: 0.08,
        Polygon: 0.03,
        Ink: 0.05,
        Solana: 0.003,
        Tron: 0.3,
        "BNB Chain": 0.12,
        Bittensor: 1.0,
      },
      gasFallback: 2,
    },
    verdictsDefault: verdictTally(rows, DEFAULT_DEPOSIT, DEFAULT_SHARE),
    comparables: comps.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      tvl: c.tvl,
      mcap: c.mcap,
      dated: c.listedAt !== null,
    })),
    rows: boardRows,
    traded,
    setAside,
  };

  /* --- Write the outputs. --- */
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "board.json"),
    `${JSON.stringify({ rows: boardRows }, null, 1)}\n`,
  );
  writeFileSync(
    join(outDir, "data.js"),
    `window.RADAR_DATA = ${JSON.stringify(data)};\n`,
  );
  copyTree(join(ROOTDIR, "dashboard"), join(outDir, "dashboard"));
  const shots = copyTree(join(ROOTDIR, "screenshots"), join(outDir, "screenshots"));
  if (shots.length < 3) {
    process.stderr.write(
      `token radar v3: screenshots/ holds ${shots.length} image(s): hand in 3 or 4\n`,
    );
    process.exit(1);
  }
  writeFileSync(
    join(outDir, "dossier.json"),
    buildDossier(outDir, { text_max_bytes: 65536 }),
  );

  const v = data.verdictsDefault;
  process.stdout.write(
    `token radar v3: ${snap.protocols.length} protocols, ${rows.length} ranked, ` +
      `${data.counts.watchCovered}/${snap.watchlist.length} watchlist\n` +
      `token radar v3: curve slope ${line.slope.toFixed(3)} intercept ${line.intercept.toFixed(3)} ` +
      `RMSE ${line.rmse.toFixed(3)} on ${line.n} dated comps (k=${tuning.k}, minN=${tuning.minN})\n` +
      `token radar v3: LOO x${validation.loo.model.median.toFixed(2)}, ` +
      `walk-forward x${validation.walkForward.pooled.median.toFixed(2)}, ` +
      `time-split x${validation.timeSplit.model.median.toFixed(2)}\n` +
      `token radar v3: verdicts at $${DEFAULT_DEPOSIT} / ${(DEFAULT_SHARE * 100).toFixed(0)}%: ` +
      `FARM ${v.FARM} / MARGINAL ${v.MARGINAL} / SKIP ${v.SKIP}\n` +
      `token radar v3: wrote ${join(outDir, "board.json")}, ${join(outDir, "data.js")}, ` +
      `${join(outDir, "dashboard")}, ${shots.length} screenshots, ${join(outDir, "dossier.json")}\n`,
  );
}

main();
