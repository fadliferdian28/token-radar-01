#!/usr/bin/env node
/**
 * token-radar-01 v2 — entrypoint.
 *
 * Reads the sealed snapshot, fits the size-curve model, ranks the board,
 * runs the six-check backtest, prices the farm economics at four capitals,
 * and writes the board, the dashboard's data, and the dossier.
 *
 * Usage: node main.ts --input <snapshot.json>
 *   MAKEFUN_OUTPUT_DIR (default ./out) is where the outputs go.
 *   The harness runs it twice; both runs must write identical bytes.
 *   Standard library only, no network.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest } from "./lib/backtest.ts";
import {
  allCapitals,
  bestPerHour,
  CAPITALS,
  farmSteps,
  verdictCounts,
} from "./lib/economics.ts";
import {
  comparables,
  fitModel,
  hasToken,
  isRankable,
  rankBoard,
  type Snapshot,
} from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string; outDir: string } {
  let input = "/input/snapshot.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && i + 1 < argv.length) input = argv[i + 1];
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || join(HERE, "out");
  return { input, outDir };
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(src, entry.name), join(dest, entry.name));
    }
  }
}

function main(): void {
  const { input, outDir } = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(
    readFileSync(input, "utf-8"),
  ) as Snapshot;

  const model = fitModel(snapshot);
  const rows = rankBoard(snapshot, model);
  const backtest = runBacktest(snapshot);
  const { list: comps } = comparables(snapshot.protocols);

  // Traded protocols (kept apart) and set-aside protocols (with reasons).
  const traded = snapshot.protocols
    .filter(hasToken)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      chains: p.chains,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd,
      change7d: p.change_7d,
    }))
    .sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  const setAside = snapshot.protocols
    .filter((p) => !hasToken(p) && !isRankable(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      tvl: p.tvl_usd,
      reason: setAsideReason(p),
    }))
    .sort((a, b) => b.tvl - a.tvl);

  // Board rows with farm economics at every capital.
  const boardRows = rows.map((r, i) => {
    const econ = allCapitals(r);
    return {
      slug: r.slug,
      name: r.name,
      rank: i + 1,
      implied_value_usd: Math.round(r.value),
      farm_steps: farmSteps(r, 1000),
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl,
      change_7d: r.change7d,
      age_days: r.ageDays,
      watchlist: r.watchlist,
      value_usd: Math.round(r.value),
      p10_usd: Math.round(r.p10),
      p90_usd: Math.round(r.p90),
      base_value_usd: Math.round(r.baseValue),
      family_offset: r.familyOffset,
      growth_factor: r.growthFactor,
      seasoning_factor: r.seasoningFactor,
      sibling_factor: r.siblingFactor,
      launch_probability: r.launchProb,
      economics: econ.map((e) => ({
        capital: e.capital,
        slice: e.slice,
        expected_usd: e.expected,
        fees_usd: e.fees,
        opportunity_usd: e.opportunity,
        exit_cost_usd: e.exitCost,
        net_usd: e.net,
        verdict: e.verdict,
        net_per_hour: e.netPerHour,
      })),
    };
  });

  // Family offset table (for the calibration panel).
  const offsets = [...model.offsets.entries()]
    .map(([category, o]) => ({ category, offset: o.offset, n: o.n }))
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category));

  // Verdict counts + best-per-hour at each capital.
  const verdicts: Record<number, { FARM: number; THIN: number; SKIP: number }> = {};
  const best: Record<number, { slug: string; name: string; netPerHour: number; net: number } | null> = {};
  const bestWatch: Record<number, { slug: string; name: string; netPerHour: number; net: number } | null> = {};
  const watchRows = rows.filter((r) => r.watchlist);
  for (const c of CAPITALS) {
    verdicts[c] = verdictCounts(rows, c);
    best[c] = bestPerHour(rows, c);
    bestWatch[c] = bestPerHour(watchRows, c);
  }

  const data = {
    asOf: snapshot.as_of,
    source: snapshot.source,
    floorUsd: snapshot.floor_usd,
    counts: {
      ranked: rows.length,
      trading: traded.length,
      setAside: setAside.length,
      total: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
    },
    fit: {
      intercept: model.fit.intercept,
      slope: model.fit.slope,
      rmse: model.fit.rmse,
      n: model.fit.n,
      excludedZeroMcap: model.excludedZeroMcap,
      winsorized: model.winsorized,
    },
    medianAgeDays: model.medianAgeDays,
    offsets,
    backtest,
    verdicts,
    best,
    bestWatch,
    comparables: comps.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      tvl: c.tvl,
      mcap: c.mcap,
    })),
    rows: boardRows,
    traded,
    setAside,
  };

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });

  // board.json: the gate reads rows (slug/name/rank/implied_value_usd/farm_steps).
  writeFileSync(
    join(outDir, "board.json"),
    JSON.stringify({ rows: boardRows }, null, 1) + "\n",
  );
  // data.js: the dashboard's data, beside the page (outside dashboard/).
  writeFileSync(
    join(outDir, "data.js"),
    "window.RADAR_DATA = " + JSON.stringify(data) + ";\n",
  );
  // Dashboard + screenshots, copied verbatim.
  copyDir(join(HERE, "dashboard"), join(outDir, "dashboard"));
  copyDir(join(HERE, "screenshots"), join(outDir, "screenshots"));
  // Dossier, built by the scorer's own library.
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);
}

function setAsideReason(p: {
  name: string;
  category: string | null;
}): string {
  const excluded = new Set([
    "Bridge",
    "Canonical Bridge",
    "Liquid Staking",
    "Liquid Restaking",
    "Restaked BTC",
    "CEX",
    "Centralized Exchange",
  ]);
  if (p.category !== null && excluded.has(p.category)) {
    return `Excluded category: ${p.category}`;
  }
  if (/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/.test(p.name || "")) {
    return "Versioned name (a later version of a protocol)";
  }
  if (/\b(wrapped|staked|staking)\b/i.test(p.name || "")) {
    return "Wrapped or staked product of another protocol";
  }
  const exchanges = [
    "Binance",
    "Coinbase",
    "Bybit",
    "Kraken",
    "Bitget",
    "OKX",
    "Bitfinex",
    "Gemini",
  ];
  for (const ex of exchanges) {
    if ((p.name || "").startsWith(ex)) {
      return `Exchange product (${ex})`;
    }
  }
  return "Set aside by the house rule";
}

main();
