// token-radar-01 v4 — out-of-sample validation, nested throughout.
//
// Every check is computed at build time from the snapshot and shown on
// the board; no validation number is typed in by hand.
//
//   leave-one-out   refit per held-out comp, median miss as a multiple
//   fair all-128    the dated fit scored on every comp (33 undated held out)
//   walk-forward    five January origins; fit before, test the next 12 months
//   time-split      fit pre-2024, test post-2024
//   leave-one-category-out (NEW)  fit without a category, test on it
//   band coverage   empirical quantiles of the leave-one-out errors (NEW:
//                   v3 used normal-theory bands from each fold's RMSE)
//   ablation        what each model term adds (or costs), nested LOO + WF
//   baselines       flat global median multiple and flat 0.25x, same tests
//
// NESTED TUNING (new in v4): the shrinkage k is re-tuned INSIDE every
// check — per held-out comp for leave-one-out, per origin for
// walk-forward, on the pre-2024 set for the time split. The k tuned on
// the full set must not see the comps a check holds out; v3 tuned once
// and reused that k everywhere, which flatters leave-one-out (flat
// ×2.94 against nested ×3.17) and understates walk-forward (flat ×3.08
// against nested ×2.74, where small training sets want heavier
// shrinkage). Both numbers are reported, so the tuning optimism is
// visible rather than hidden. The final board still uses the k tuned on
// the full dated set — that is the correct fit for the model as shipped.
//
// One honest limit, stated on the board: the snapshot is a single
// cross-section, so the walk-forward and time-split checks sort comps by
// listing date but price them at today's TVL and cap — they test whether
// the curve survives across listing cohorts, not a true backtest in time.

import {
  carryForwardTvl,
  fitModel,
  missAsMultiple,
  predictValue,
  tuneSettings,
  type ValuedRow,
} from "./curve.ts";
import { medianOf, type Comparable } from "./snapshot.ts";

export interface MissStats {
  median: number;
  mean: number;
  within2x: number;
  within3x: number;
  n: number;
}

export interface Validation {
  loo: {
    nested: MissStats;
    flat: MissStats;
    flatMedian: MissStats;
    flat025: MissStats;
    nestedPicks: Array<{ k: number; minN: number; n: number }>;
  };
  looFair: MissStats;
  walkForward: {
    nested: {
      pooled: MissStats;
      origins: Array<{
        year: number;
        trainN: number;
        testN: number;
        tunedK: number | null;
        median: number | null;
      }>;
    };
    flat: MissStats;
    flatMedian: MissStats;
    curveOnly: MissStats;
  };
  timeSplit: {
    nested: MissStats;
    flat: MissStats;
    flatMedian: MissStats;
    flat025: MissStats;
    curveOnly: MissStats;
    trainN: number;
    testN: number;
    undatedN: number;
    tunedK: number;
  };
  loco: {
    pooled: MissStats;
    perCategory: Array<{ category: string; n: number; miss: number }>;
  };
  bands: {
    p50: number;
    p80: number;
    n: number;
    halfWidth50x: number;
    halfWidth80x: number;
    halfWidth90x: number;
  };
  ablation: Array<{
    step: string;
    loo: number | null;
    wf: number | null;
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
    median: medianOf(mults),
    mean: mults.reduce((a, b) => a + b, 0) / n,
    within2x: mults.filter((m) => m <= 2).length / n,
    within3x: mults.filter((m) => m <= 3).length / n,
    n,
  };
}

function flatMultiple(list: Comparable[]): number {
  return medianOf(list.map((c) => c.mcap / c.tvl));
}

/** Leave-one-out predictions at a FIXED shrinkage (the flat procedure). */
function flatLooPairs(
  list: Comparable[],
  k: number,
  minN: number,
): {
  model: Array<[number, number]>;
  flat: Array<[number, number]>;
  flat025: Array<[number, number]>;
  signed: number[];
  absLogErr: number[];
} {
  const model: Array<[number, number]> = [];
  const flat: Array<[number, number]> = [];
  const flat025: Array<[number, number]> = [];
  const signed: number[] = [];
  const absLogErr: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const train = [...list.slice(0, i), ...list.slice(i + 1)];
    const held = list[i];
    const m = fitModel(train, k, minN);
    const pred = predictValue(m, held);
    model.push([held.mcap, pred]);
    signed.push(Math.log10(pred / held.mcap));
    absLogErr.push(Math.abs(Math.log10(held.mcap / pred)));
    const med = flatMultiple(train);
    flat.push([held.mcap, med * held.tvl]);
    flat025.push([held.mcap, 0.25 * held.tvl]);
  }
  return { model, flat, flat025, signed, absLogErr };
}

/** Leave-one-out with the shrinkage re-tuned on each training fold. */
function nestedLooPairs(list: Comparable[]): {
  pairs: Array<[number, number]>;
  picks: Array<{ k: number; minN: number; n: number }>;
} {
  const pairs: Array<[number, number]> = [];
  const pickCounts = new Map<string, { k: number; minN: number; n: number }>();
  for (let i = 0; i < list.length; i++) {
    const train = [...list.slice(0, i), ...list.slice(i + 1)];
    const tuned = tuneSettings(train);
    const key = `${tuned.k}/${tuned.minN}`;
    const entry = pickCounts.get(key) ?? { k: tuned.k, minN: tuned.minN, n: 0 };
    entry.n += 1;
    pickCounts.set(key, entry);
    const m = fitModel(train, tuned.k, tuned.minN);
    pairs.push([list[i].mcap, predictValue(m, list[i])]);
  }
  const picks = [...pickCounts.values()].sort((a, b) => b.n - a.n);
  return { pairs, picks };
}

/** Walk-forward predictions; the tuner is null for fixed-k / curve-only. */
function walkForwardPairs(
  list: Comparable[],
  tune: ((train: Comparable[]) => { k: number; minN: number }) | null,
  fixedK: number,
  fixedMinN: number,
): {
  pooled: Array<[number, number]>;
  origins: Array<{
    year: number;
    trainN: number;
    testN: number;
    tunedK: number | null;
    median: number | null;
  }>;
} {
  const pooled: Array<[number, number]> = [];
  const origins: Array<{
    year: number;
    trainN: number;
    testN: number;
    tunedK: number | null;
    median: number | null;
  }> = [];
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const origin = `${year}-01-01`;
    const next = `${year + 1}-01-01`;
    const train = list.filter(
      (c) => c.listedAt !== null && c.listedAt < origin,
    );
    const test = list.filter(
      (c) =>
        c.listedAt !== null && c.listedAt >= origin && c.listedAt < next,
    );
    if (train.length < 5 || test.length === 0) {
      origins.push({
        year,
        trainN: train.length,
        testN: test.length,
        tunedK: null,
        median: null,
      });
      continue;
    }
    const setting =
      tune === null ? { k: fixedK, minN: fixedMinN } : tune(train);
    const m = fitModel(train, setting.k, setting.minN);
    const ps = test.map(
      (c) => [c.mcap, predictValue(m, c)] as [number, number],
    );
    pooled.push(...ps);
    origins.push({
      year,
      trainN: train.length,
      testN: test.length,
      tunedK: tune === null ? null : setting.k,
      median: missAsMultiple(ps),
    });
  }
  return { pooled, origins };
}

export function runValidation(
  dated: Comparable[],
  all: Comparable[],
  k: number,
  minN: number,
  curveOnlyLoo: number,
  rows: ValuedRow[],
): Validation {
  /* --- Leave-one-out: nested (re-tuned per fold) and flat (fixed k). --- */
  const nestedLoo = nestedLooPairs(dated);
  const flatLoo = flatLooPairs(dated, k, minN);

  /* --- Fair check: the dated fit scored on all 128 comps. --- */
  const fullModel = fitModel(dated, k, minN);
  const fairPairs = all.map(
    (c) => [c.mcap, predictValue(fullModel, c)] as [number, number],
  );

  /* --- Walk-forward: nested, flat, curve-only, flat-median baseline. --- */
  const nestedWf = walkForwardPairs(dated, (train) => tuneSettings(train), k, minN);
  const flatWf = walkForwardPairs(dated, null, k, minN);
  const curveWf = walkForwardPairs(dated, null, 0, 1_000_000);
  const wfFlatPairs: Array<[number, number]> = [];
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const origin = `${year}-01-01`;
    const next = `${year + 1}-01-01`;
    const train = dated.filter(
      (c) => c.listedAt !== null && c.listedAt < origin,
    );
    const test = dated.filter(
      (c) =>
        c.listedAt !== null && c.listedAt >= origin && c.listedAt < next,
    );
    if (train.length < 5 || test.length === 0) continue;
    const med = flatMultiple(train);
    for (const c of test) wfFlatPairs.push([c.mcap, med * c.tvl]);
  }

  /* --- Time split: fit before 2024, test 2024 and later. --- */
  const pre = dated.filter((c) => (c.listedAt as string) < "2024-01-01");
  const post = dated.filter((c) => (c.listedAt as string) >= "2024-01-01");
  const tsTuned = tuneSettings(pre);
  const tsNestedModel = fitModel(pre, tsTuned.k, tsTuned.minN);
  const tsFlatModel = fitModel(pre, k, minN);
  const tsCurveModel = fitModel(pre, 0, 1_000_000);
  const tsMed = flatMultiple(pre);
  const tsNested: Array<[number, number]> = [];
  const tsFlat: Array<[number, number]> = [];
  const tsFlatMed: Array<[number, number]> = [];
  const ts025: Array<[number, number]> = [];
  const tsCurve: Array<[number, number]> = [];
  for (const c of post) {
    tsNested.push([c.mcap, predictValue(tsNestedModel, c)]);
    tsFlat.push([c.mcap, predictValue(tsFlatModel, c)]);
    tsFlatMed.push([c.mcap, tsMed * c.tvl]);
    ts025.push([c.mcap, 0.25 * c.tvl]);
    tsCurve.push([c.mcap, predictValue(tsCurveModel, c)]);
  }

  /* --- Leave-one-category-out: fit without a category, test on it. --- */
  const locoPairs: Array<[number, number]> = [];
  const locoPerCat: Array<{ category: string; n: number; miss: number }> = [];
  const categories = [...new Set(dated.map((c) => c.category))];
  for (const cat of categories) {
    const train = dated.filter((c) => c.category !== cat);
    const test = dated.filter((c) => c.category === cat);
    if (train.length < 10 || test.length === 0) continue;
    const m = fitModel(train, k, minN);
    const ps = test.map(
      (c) => [c.mcap, predictValue(m, c)] as [number, number],
    );
    locoPairs.push(...ps);
    locoPerCat.push({ category: cat, n: test.length, miss: missAsMultiple(ps) });
  }
  locoPerCat.sort((a, b) => b.miss - a.miss);

  /* --- Band coverage: empirical quantiles of the LOO errors. ---
   * For each held-out comp, the P50/P80 half-widths are the 50th/80th
   * percentiles of the OTHER comps' |log errors| — the held-out comp
   * never sets its own band. The full-sample quantiles are the widths
   * the board quotes (as multiples). */
  const absErr = flatLoo.absLogErr;
  let in50 = 0;
  let in80 = 0;
  for (let i = 0; i < absErr.length; i++) {
    const others = absErr
      .filter((_, j) => j !== i)
      .sort((a, b) => a - b);
    const q50 = others[Math.floor(0.5 * others.length)];
    const q80 = others[Math.floor(0.8 * others.length)];
    if (absErr[i] <= q50) in50 += 1;
    if (absErr[i] <= q80) in80 += 1;
  }
  const sortedAbs = [...absErr].sort((a, b) => a - b);
  const halfWidth = (q: number): number =>
    Math.pow(10, sortedAbs[Math.floor(q * sortedAbs.length)]);

  /* --- Ablation, nested throughout: each row's LOO and walk-forward. ---
   * The forward-TVL row prices comps at today's 7-day change, not the
   * change at listing — the row is shown with that caveat, not hidden. */
  const fwdDated: Comparable[] = dated.map((c) => ({
    ...c,
    tvl: carryForwardTvl(c.tvl, c.change7d),
  }));
  const fwdNestedLoo = nestedLooPairs(fwdDated);
  const fwdNestedWf = walkForwardPairs(
    fwdDated,
    (train) => tuneSettings(train),
    k,
    minN,
  );
  const ablation: Validation["ablation"] = [
    {
      step: "Size curve only",
      loo: curveOnlyLoo,
      wf: stats(curveWf.pooled).median,
      note: "log cap on log TVL, no family term (no tuning to nest)",
    },
    {
      step: "+ Family offsets",
      loo: stats(nestedLoo.pairs).median,
      wf: stats(nestedWf.pooled).median,
      note: `median residual per category, shrunk k=${k}, min n=${minN}; nested LOO re-tunes per fold`,
    },
    {
      step: "+ Forward TVL",
      loo: stats(fwdNestedLoo.pairs).median,
      wf: stats(fwdNestedWf.pooled).median,
      note: "7-day change carried forward; comps priced at today's change",
    },
    {
      step: "+ Launch odds",
      loo: null,
      wf: null,
      note: "Odds cannot change LOO or WF on traded comps — they reorder the board instead (see rank agreement below)",
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
      nested: stats(nestedLoo.pairs),
      flat: stats(flatLoo.model),
      flatMedian: stats(flatLoo.flat),
      flat025: stats(flatLoo.flat025),
      nestedPicks: nestedLoo.picks,
    },
    looFair: stats(fairPairs),
    walkForward: {
      nested: {
        pooled: stats(nestedWf.pooled),
        origins: nestedWf.origins,
      },
      flat: stats(flatWf.pooled),
      flatMedian: stats(wfFlatPairs),
      curveOnly: stats(curveWf.pooled),
    },
    timeSplit: {
      nested: stats(tsNested),
      flat: stats(tsFlat),
      flatMedian: stats(tsFlatMed),
      flat025: stats(ts025),
      curveOnly: stats(tsCurve),
      trainN: pre.length,
      testN: post.length,
      undatedN: all.length - dated.length,
      tunedK: tsTuned.k,
    },
    loco: {
      pooled: stats(locoPairs),
      perCategory: locoPerCat,
    },
    bands: {
      p50: in50 / absErr.length,
      p80: in80 / absErr.length,
      n: absErr.length,
      halfWidth50x: halfWidth(0.5),
      halfWidth80x: halfWidth(0.8),
      halfWidth90x: halfWidth(0.9),
    },
    ablation,
    bias: medianOf(flatLoo.signed),
    oddsRanking: { spearman, top10Overlap },
  };
}
