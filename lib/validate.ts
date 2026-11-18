// token-radar-01 v3 — out-of-sample validation.
//
// Every check is computed at build time from the snapshot and shown on
// the board; no validation number is typed in by hand.
//
//   leave-one-out   refit per held-out comp, median miss as a multiple
//   fair all-128    the dated fit scored on every comp (33 undated held out)
//   walk-forward    five January origins; fit before, test the next 12 months
//   time-split      fit pre-2024, test post-2024
//   band coverage   share of held-out caps inside the P50 / P80 bands
//   ablation        what each model term adds (or costs) in LOO
//   baselines       flat global median multiple and flat 0.25x, same tests
//
// One honest limit, stated on the board: the snapshot is a single
// cross-section, so the walk-forward and time-split checks sort comps by
// listing date but price them at today's TVL and cap — they test whether
// the curve survives across listing cohorts, not a true backtest in time.

import {
  familyShifts,
  fitLine,
  forwardTvl,
  medianMiss,
  predictCap,
  type PricedRow,
} from "./pricing.ts";
import { middle, type Comp } from "./snap.ts";

export interface MissStats {
  median: number;
  mean: number;
  within2x: number;
  within3x: number;
  n: number;
}

export interface Validation {
  loo: { model: MissStats; flatMedian: MissStats; flat025: MissStats };
  looFair: MissStats;
  walkForward: {
    pooled: MissStats;
    pooledFlat: MissStats;
    pooledCurveOnly: MissStats;
    origins: Array<{
      year: number;
      trainN: number;
      testN: number;
      median: number | null;
    }>;
  };
  timeSplit: {
    model: MissStats;
    flatMedian: MissStats;
    flat025: MissStats;
    curveOnly: MissStats;
    trainN: number;
    testN: number;
    undatedN: number;
  };
  bands: { p50: number; p80: number; n: number };
  ablation: Array<{
    step: string;
    loo: number | null;
    note: string;
  }>;
  bias: number;
  /** Rank agreement between the value-if-launches order and the implied order. */
  oddsRanking: { spearman: number; top10Overlap: number };
}

function stats(pairs: Array<[number, number]>): MissStats {
  const mults = pairs.map(([actual, pred]) =>
    Math.pow(10, Math.abs(Math.log10(pred / actual))),
  );
  const n = mults.length;
  return {
    median: middle(mults),
    mean: mults.reduce((a, b) => a + b, 0) / n,
    within2x: mults.filter((m) => m <= 2).length / n,
    within3x: mults.filter((m) => m <= 3).length / n,
    n,
  };
}

function flatMultiple(list: Comp[]): number {
  return middle(list.map((c) => c.mcap / c.tvl));
}

/** Leave-one-out predictions for the model and both baselines. */
function looPredictions(
  list: Comp[],
  k: number,
  minN: number,
): {
  model: Array<[number, number]>;
  flat: Array<[number, number]>;
  flat025: Array<[number, number]>;
  signed: number[];
  bands: Array<{ logErr: number; rmse: number }>;
} {
  const model: Array<[number, number]> = [];
  const flat: Array<[number, number]> = [];
  const flat025: Array<[number, number]> = [];
  const signed: number[] = [];
  const bands: Array<{ logErr: number; rmse: number }> = [];
  for (let i = 0; i < list.length; i++) {
    const train = [...list.slice(0, i), ...list.slice(i + 1)];
    const held = list[i];
    const line = fitLine(train);
    const shifts = familyShifts(train, line, k, minN);
    const pred = predictCap(held, line, shifts);
    model.push([held.mcap, pred]);
    signed.push(Math.log10(pred / held.mcap));
    bands.push({ logErr: Math.abs(Math.log10(held.mcap / pred)), rmse: line.rmse });
    const med = flatMultiple(train);
    flat.push([held.mcap, med * held.tvl]);
    flat025.push([held.mcap, 0.25 * held.tvl]);
  }
  return { model, flat, flat025, signed, bands };
}

export function runValidation(
  dated: Comp[],
  all: Comp[],
  k: number,
  minN: number,
  curveOnlyLoo: number,
  rows: PricedRow[],
): Validation {
  /* --- Leave-one-out on the fitted set, plus baselines. --- */
  const loo = looPredictions(dated, k, minN);

  /* --- Fair check: the dated fit scored on all 128 comps. --- */
  const fullLine = fitLine(dated);
  const fullShifts = familyShifts(dated, fullLine, k, minN);
  const fairPairs = all.map(
    (c) => [c.mcap, predictCap(c, fullLine, fullShifts)] as [number, number],
  );

  /* --- Walk-forward: five January origins. --- */
  const origins: Validation["walkForward"]["origins"] = [];
  const pooled: Array<[number, number]> = [];
  const pooledFlat: Array<[number, number]> = [];
  const pooledCurve: Array<[number, number]> = [];
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const origin = `${year}-01-01`;
    const next = `${year + 1}-01-01`;
    const train = dated.filter(
      (c) => c.listedAt !== null && c.listedAt < origin,
    );
    const test = dated.filter(
      (c) => c.listedAt !== null && c.listedAt >= origin && c.listedAt < next,
    );
    if (train.length < 5 || test.length === 0) {
      origins.push({ year, trainN: train.length, testN: test.length, median: null });
      continue;
    }
    const line = fitLine(train);
    const shifts = familyShifts(train, line, k, minN);
    const med = flatMultiple(train);
    for (const c of test) {
      pooled.push([c.mcap, predictCap(c, line, shifts)]);
      pooledFlat.push([c.mcap, med * c.tvl]);
      pooledCurve.push([
        c.mcap,
        Math.pow(10, line.intercept + line.slope * Math.log10(c.tvl)),
      ]);
    }
    origins.push({
      year,
      trainN: train.length,
      testN: test.length,
      median: medianMiss(test.map((c) => [c.mcap, predictCap(c, line, shifts)] as [number, number])),
    });
  }

  /* --- Time split: fit before 2024, test 2024 and later. --- */
  const pre = dated.filter((c) => (c.listedAt as string) < "2024-01-01");
  const post = dated.filter((c) => (c.listedAt as string) >= "2024-01-01");
  const tsLine = fitLine(pre);
  const tsShifts = familyShifts(pre, tsLine, k, minN);
  const tsMed = flatMultiple(pre);
  const tsModel: Array<[number, number]> = [];
  const tsFlat: Array<[number, number]> = [];
  const ts025: Array<[number, number]> = [];
  const tsCurve: Array<[number, number]> = [];
  for (const c of post) {
    tsModel.push([c.mcap, predictCap(c, tsLine, tsShifts)]);
    tsFlat.push([c.mcap, tsMed * c.tvl]);
    ts025.push([c.mcap, 0.25 * c.tvl]);
    tsCurve.push([
      c.mcap,
      Math.pow(10, tsLine.intercept + tsLine.slope * Math.log10(c.tvl)),
    ]);
  }

  /* --- Band coverage: each fold's own residual spread sets the bands. --- */
  let in50 = 0;
  let in80 = 0;
  for (const b of loo.bands) {
    if (b.logErr <= 0.6745 * b.rmse) in50 += 1;
    if (b.logErr <= 1.2816 * b.rmse) in80 += 1;
  }

  /* --- Ablation: LOO per term. --- */
  // Forward TVL on comps uses today's 7-day change, not the change at
  // listing — the row is shown with that caveat, not hidden.
  const fwdPairs: Array<[number, number]> = [];
  for (let i = 0; i < dated.length; i++) {
    const train = [...dated.slice(0, i), ...dated.slice(i + 1)];
    const held = dated[i];
    const line = fitLine(train);
    const shifts = familyShifts(train, line, k, minN);
    const fwdHeld: Comp = {
      ...held,
      tvl: forwardTvl(held.tvl, held.change7d),
    };
    fwdPairs.push([held.mcap, predictCap(fwdHeld, line, shifts)]);
  }
  const looModel = stats(loo.model).median;
  const ablation: Validation["ablation"] = [
    {
      step: "Size curve only",
      loo: curveOnlyLoo,
      note: "log cap on log TVL, no family term",
    },
    {
      step: "+ Family offsets",
      loo: looModel,
      note: `median residual per category, shrunk k=${k}, min n=${minN}`,
    },
    {
      step: "+ Forward TVL",
      loo: medianMiss(fwdPairs),
      note: "7-day change carried forward; comps priced at today's change",
    },
    {
      step: "+ Launch odds",
      loo: null,
      note: "Odds cannot change LOO on traded comps — they reorder the board instead (see rank agreement below)",
    },
  ];

  /* --- Odds ranking change: Spearman + top-10 overlap. --- */
  const byVil = [...rows]
    .sort((a, b) => b.valueIfLaunches - a.valueIfLaunches)
    .map((r) => r.slug);
  const rankInImplied = new Map(rows.map((r, i) => [r.slug, i + 1]));
  let d2 = 0;
  byVil.forEach((slug, i) => {
    d2 += (i + 1 - (rankInImplied.get(slug) ?? 0)) ** 2;
  });
  const n = rows.length;
  const spearman = 1 - (6 * d2) / (n * (n * n - 1));
  const top10Overlap = byVil
    .slice(0, 10)
    .filter((s) => (rankInImplied.get(s) ?? 99) <= 10).length;

  return {
    loo: {
      model: stats(loo.model),
      flatMedian: stats(loo.flat),
      flat025: stats(loo.flat025),
    },
    looFair: stats(fairPairs),
    walkForward: {
      pooled: stats(pooled),
      pooledFlat: stats(pooledFlat),
      pooledCurveOnly: stats(pooledCurve),
      origins,
    },
    timeSplit: {
      model: stats(tsModel),
      flatMedian: stats(tsFlat),
      flat025: stats(ts025),
      curveOnly: stats(tsCurve),
      trainN: pre.length,
      testN: post.length,
      undatedN: all.length - dated.length,
    },
    bands: {
      p50: in50 / dated.length,
      p80: in80 / dated.length,
      n: dated.length,
    },
    ablation,
    bias: middle(loo.signed),
    oddsRanking: { spearman, top10Overlap },
  };
}
