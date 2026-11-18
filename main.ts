// token-radar-01 v4 — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the size curve on the dated
// comparables, calibrates the launch-odds model by cross-fitting,
// prices every board-eligible protocol, multiplies in the odds, runs
// the nested out-of-sample validation suite, costs the farm plans, and
// writes the board, the dashboard's data, and the dossier.
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
  bootstrapRankBands,
  fitModel,
  tuneSettings,
  valueBoard,
  type ValuedRow,
} from "./lib/curve.ts";
import { AGE_BANDS, calibrateOdds, oddsFromLogit } from "./lib/odds.ts";
import { runValidation } from "./lib/checks.ts";
import {
  buildFarmPlan,
  countOutcomes,
  evaluatePlan,
  findBreakEven,
  DEPOSIT_CHOICES,
  HORIZON_DAYS,
  HORIZON_WEEKS,
  HOURS_PER_PLAN,
  FARM_THRESHOLD,
  LAUNCH_FLOAT,
  SHARE_CHOICES,
  SLICE_MAX,
  SLIPPAGE_K,
  STANDARD_DEPOSIT,
  STANDARD_SHARE,
  TBILL_YIELD,
  TX_COST_DEFAULT,
  TX_COST_USD,
  TX_COUNT,
  TURNOVER_DAILY,
} from "./lib/farm.ts";
import {
  collectComparables,
  exclusionReason,
  hasTokenRecord,
  isBoardEligible,
  type Snapshot,
} from "./lib/snapshot.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read a `--name value` or `--name=value` flag from argv. */
function readFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? null : eq.slice(name.length + 3);
}

/** Copy a flat directory (no dotfiles), returning the copied names. */
function copyDir(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    copyFileSync(join(from, name), join(to, name));
    names.push(name);
  }
  return names.sort();
}

interface BoardRowCheck {
  slug: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/**
 * The gate's board rules, checked here so a bad board never ships.
 * Returns every problem found (empty when the board is clean).
 */
function checkBoard(rows: BoardRowCheck[], snap: Snapshot): string[] {
  const problems: string[] = [];
  if (rows.length < 100 || rows.length > 4000) {
    problems.push(`board holds ${rows.length} rows, outside 100–4000`);
  }
  const known = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Infinity;
  for (const r of rows) {
    if (!known.has(r.slug)) problems.push(`row names ${r.slug}, not in the snapshot`);
    if (seen.has(r.slug)) problems.push(`duplicate slug ${r.slug}`);
    seen.add(r.slug);
    if (r.implied_value_usd <= 0 || !Number.isInteger(r.implied_value_usd)) {
      problems.push(`row ${r.slug} has a non-positive or non-integer implied value`);
    }
    if (r.implied_value_usd > prev) {
      problems.push(`implied value rises at rank ${r.rank}`);
    }
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      problems.push(`row ${r.slug} holds ${r.farm_steps.length} farm steps`);
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) {
        problems.push(`row ${r.slug} holds a farm step of ${len} characters`);
      }
    }
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) {
      problems.push(`ranks are not exactly 1–${rows.length}`);
      break;
    }
  }
  for (const slug of snap.watchlist) {
    if (!seen.has(slug)) problems.push(`watchlist slug ${slug} is missing`);
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length > 1 && values.size === 1) {
    problems.push("every implied value is the same");
  }
  return problems;
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputArg = readFlag(argv, "input") ?? "/input";
  const inputFile = inputArg.endsWith(".json")
    ? inputArg
    : join(inputArg, "snapshot.json");
  if (!existsSync(inputFile)) {
    process.stderr.write(
      `token radar v4: no snapshot at ${inputFile} (pass --input <snapshot.json|directory>)\n`,
    );
    process.exit(2);
  }
  const outDir =
    readFlag(argv, "output") ??
    process.env.MAKEFUN_OUTPUT_DIR ??
    "/output";

  const snap = JSON.parse(readFileSync(inputFile, "utf-8")) as Snapshot;

  /* --- Fit: dated comparables, shrinkage tuned by leave-one-out. ---
   * This tuning is for the FINAL fit only. The validation suite in
   * lib/checks.ts re-tunes inside every check (nested tuning). */
  const { list: comps, droppedZeroCap, winsorized } = collectComparables(
    snap.protocols,
  );
  const dated = comps.filter((c) => c.listedAt !== null);
  const tuning = tuneSettings(dated);
  const model = fitModel(dated, tuning.k, tuning.minN);

  /* --- Odds: ridge-logit, lambda picked + calibrated by cross-fit. --- */
  const { calibration, finalModel: oddsModel } = calibrateOdds(
    snap.protocols,
    snap.as_of,
  );
  const oddsFor = (p: Snapshot["protocols"][number]) =>
    oddsFromLogit(oddsModel, p, snap.as_of);

  /* --- Price the board; odds multiply into the ranking value. --- */
  const board = snap.protocols.filter(isBoardEligible);
  const rows: ValuedRow[] = valueBoard(snap, board, model, oddsFor);
  const slopeStats = bootstrapRankBands(
    snap,
    board,
    dated,
    tuning.k,
    tuning.minN,
    oddsFor,
    rows,
  );

  /* --- Validate out of sample (nested tuning throughout). --- */
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
    const econ = evaluatePlan(r, STANDARD_DEPOSIT, STANDARD_SHARE);
    return {
      slug: r.slug,
      name: r.name,
      rank: i + 1,
      implied_value_usd: Math.round(r.implied),
      farm_steps: buildFarmPlan(r, STANDARD_DEPOSIT),
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
      age_bucket: r.ageBucket,
      cat_effect: r.catEffect,
      age_effect: r.ageEffect,
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
      break_even_usd: findBreakEven(r, STANDARD_SHARE),
    };
  });

  const problems = checkBoard(boardRows, snap);
  if (problems.length > 0) {
    process.stderr.write(
      `token radar v4: the board fails its own check:\n${problems.map((p) => `  - ${p}\n`).join("")}`,
    );
    process.exit(1);
  }

  /* --- The rest of the snapshot, for the dashboard's accounting. --- */
  const traded = snap.protocols
    .filter(hasTokenRecord)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
    }))
    .sort((a, b) => b.tvl - a.tvl);
  /* Set aside: tokenless AND failing the house rule (traded protocols
   * are the anchors, not the set-aside — they have their own table). */
  const aside = snap.protocols.filter(
    (p) => !hasTokenRecord(p) && !isBoardEligible(p),
  );
  const asideBreakdown = [...new Set(aside.map((p) => exclusionReason(p)))]
    .map((reason) => ({
      reason,
      n: aside.filter((p) => exclusionReason(p) === reason).length,
    }))
    .sort((a, b) => b.n - a.n);

  /* --- Everything the dashboard renders. --- */
  const data = {
    asOf: snap.as_of,
    source: "DefiLlama snapshot bundled with the starter (as_of 2026-11-14)",
    floorUsd: snap.floor_usd,
    counts: {
      total: snap.protocols.length,
      ranked: rows.length,
      trading: traded.length,
      setAside: aside.length,
      watchlist: snap.watchlist.length,
      watchCovered: boardRows.filter((r) => r.watchlist).length,
    },
    asideBreakdown,
    fit: {
      intercept: model.curve.intercept,
      slope: model.curve.slope,
      rmse: model.curve.rmse,
      n: dated.length,
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
      model: "ridge-logit (category + age bucket)",
      lambda: calibration.lambdaPicked,
      lambdaGrid: calibration.lambdaGrid,
      intercept: oddsModel.intercept,
      ageEffects: AGE_BANDS.map((band) => ({
        band,
        effect: oddsModel.ageEffects.get(band) ?? 0,
        launched: oddsModel.bandCounts.get(band)?.launched ?? 0,
        total: oddsModel.bandCounts.get(band)?.total ?? 0,
      })),
      catEffects: [...oddsModel.catEffects.entries()]
        .map(([category, effect]) => ({
          category,
          effect,
          launched: oddsModel.catCounts.get(category)?.launched ?? 0,
          total: oddsModel.catCounts.get(category)?.total ?? 0,
        }))
        .sort((a, b) => b.effect - a.effect),
      typicalWaitDays: oddsModel.typicalWaitDays,
      globalLaunched: oddsModel.globalLaunched,
      globalTotal: oddsModel.globalTotal,
      globalRate: oddsModel.globalLaunched / oddsModel.globalTotal,
      undatedLaunched: oddsModel.bandCounts.get("unknown")?.launched ?? 0,
      undatedTotal: oddsModel.bandCounts.get("unknown")?.total ?? 0,
      calibration,
    },
    validation,
    slopeStats,
    offsets: [...model.offsets.entries()]
      .map(([category, o]) => ({ category, offset: o.shift, n: o.n }))
      .sort((a, b) => b.offset - a.offset),
    econParams: {
      deposits: DEPOSIT_CHOICES,
      shares: SHARE_CHOICES,
      defaultDeposit: STANDARD_DEPOSIT,
      defaultShare: STANDARD_SHARE,
      planWeeks: HORIZON_WEEKS,
      planDays: HORIZON_DAYS,
      planHours: HOURS_PER_PLAN,
      sliceCap: SLICE_MAX,
      tbill: TBILL_YIELD,
      farmLine: FARM_THRESHOLD,
      floatAtLaunch: LAUNCH_FLOAT,
      dailyTurnover: TURNOVER_DAILY,
      slipK: SLIPPAGE_K,
      txPerPlan: TX_COUNT,
      gas: TX_COST_USD,
      gasFallback: TX_COST_DEFAULT,
    },
    verdictsDefault: countOutcomes(rows, STANDARD_DEPOSIT, STANDARD_SHARE),
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
    setAside: aside.map((p) => ({
      slug: p.slug,
      name: p.name,
      tvl: p.tvl_usd,
      category: p.category,
      reason: exclusionReason(p),
    })),
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
  copyDir(join(HERE, "dashboard"), join(outDir, "dashboard"));
  const shotDir = join(HERE, "screenshots");
  const shotNames = existsSync(shotDir)
    ? copyDir(shotDir, join(outDir, "screenshots"))
    : [];
  if (shotNames.length < 3) {
    process.stderr.write(
      `token radar v4: screenshots/ holds ${shotNames.length} image(s): hand in 3 or 4\n`,
    );
    process.exit(1);
  }
  writeFileSync(
    join(outDir, "dossier.json"),
    buildDossier(outDir, { text_max_bytes: 65536 }),
  );

  const f = data.fit;
  const v = data.validation;
  const o = data.odds.calibration;
  const multBrier =
    o.baselines.find((b) => b.name.startsWith("Multiplicative"))?.brier ?? NaN;
  console.log(
    `token radar v4: fit on ${f.n} dated comps ` +
      `(slope ${f.slope.toFixed(3)}, intercept ${f.intercept.toFixed(3)}, RMSE ${f.rmse.toFixed(3)}, ` +
      `shrinkage k=${f.k}, min n=${f.minN}); ` +
      `LOO nested x${v.loo.nested.median.toFixed(2)} (flat x${v.loo.flat.median.toFixed(2)}), ` +
      `walk-forward nested x${v.walkForward.nested.pooled.median.toFixed(2)} (flat x${v.walkForward.flat.median.toFixed(2)}), ` +
      `time-split nested x${v.timeSplit.nested.median.toFixed(2)}, ` +
      `LOCO x${v.loco.pooled.median.toFixed(2)}; ` +
      `odds cross-fitted Brier ${o.brier.toFixed(4)} (multiplicative ${multBrier.toFixed(4)}), ` +
      `AUC ${o.auc.toFixed(3)}, ECE ${o.ece.toFixed(4)}; ` +
      `${rows.length} rows, verdicts ${JSON.stringify(data.verdictsDefault)}, ` +
      `${shotNames.length} screenshots, dossier at ${join(outDir, "dossier.json")}`,
  );
}

main();
