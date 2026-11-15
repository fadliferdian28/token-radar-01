/**
 * token-radar-01 v2 — out-of-sample backtest.
 *
 * Six checks, each against two naive baselines (the flat global median
 * multiple and the starter's flat 0.25x multiple), computed at run time
 * from the snapshot's traded comparables. The backtest predicts from the
 * size curve and the family offset alone; growth and seasoning are small
 * ranking-time adjustments (at most +15% and +/-10%) and are not part of
 * the held-out prediction, which the method tab states.
 *
 * Determinism: the bootstrap uses a fixed-seed generator, never Math.random.
 */

import {
  comparables,
  familyOffsets,
  olsFit,
  type Comparable,
  type CurveFit,
  type Protocol,
  type Snapshot,
} from "./model.ts";

/** One held-out prediction and its error. */
interface Prediction {
  actual: number;
  predicted: number;
}

/** Median absolute error as a multiple, plus supporting stats. */
export interface ErrorStats {
  medianMultiple: number;
  meanMultiple: number;
  within2x: number;
  within3x: number;
  n: number;
}

export interface BacktestResult {
  loo: { model: ErrorStats; flatMedian: ErrorStats; flat025: ErrorStats };
  timeSplit: {
    model: ErrorStats;
    flatMedian: ErrorStats;
    flat025: ErrorStats;
    trainN: number;
    testN: number;
    undatedN: number;
  };
  bandCoverage: { p50: number; p80: number; n: number };
  categoryHeldOut: { model: ErrorStats; flatMedian: ErrorStats; n: number };
  bootstrap: {
    slopeMean: number;
    slopeSd: number;
    slopeP5: number;
    slopeP95: number;
    interceptMean: number;
    interceptSd: number;
    draws: number;
  };
  /** Median signed log-ten error: positive means the model over-predicts. */
  bias: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length;
  if (m === 0) return 0;
  return m % 2 === 1 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

function errorStats(preds: Prediction[]): ErrorStats {
  const multiples = preds.map(
    (p) => Math.pow(10, Math.abs(Math.log10(p.predicted / p.actual))),
  );
  const n = multiples.length;
  return {
    medianMultiple: median(multiples),
    meanMultiple: multiples.reduce((a, b) => a + b, 0) / n,
    within2x: multiples.filter((m) => m <= 2).length / n,
    within3x: multiples.filter((m) => m <= 3).length / n,
    n,
  };
}

function predictWithCurve(
  c: Comparable,
  fit: CurveFit,
  offsets: Map<string, { offset: number; n: number }>,
): number {
  const off = offsets.get(c.category) ?? { offset: 0, n: 0 };
  return Math.pow(
    10,
    fit.intercept + fit.slope * Math.log10(c.tvl) + off.offset,
  );
}

function flatMedianMultiple(list: Comparable[]): number {
  return median(list.map((c) => c.mcap / c.tvl));
}

/** Fixed-seed generator (LCG) — deterministic across runs. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const BOOTSTRAP_DRAWS = 200;
const BOOTSTRAP_SEED = 20261114;

export function runBacktest(snapshot: Snapshot): BacktestResult {
  const { list } = comparables(snapshot.protocols);
  const n = list.length;

  /* --- 1. Leave-one-out --- */
  const looModel: Prediction[] = [];
  const looFlat: Prediction[] = [];
  const loo025: Prediction[] = [];
  const signedLogErrors: number[] = [];
  for (let i = 0; i < n; i++) {
    const train = list.filter((_, j) => j !== i);
    const held = list[i];
    const fit = olsFit(train);
    const offsets = familyOffsets(train, fit);
    const pred = predictWithCurve(held, fit, offsets);
    looModel.push({ actual: held.mcap, predicted: pred });
    signedLogErrors.push(Math.log10(pred / held.mcap));
    const med = flatMedianMultiple(train);
    looFlat.push({ actual: held.mcap, predicted: med * held.tvl });
    loo025.push({ actual: held.mcap, predicted: 0.25 * held.tvl });
  }

  /* --- 2. Time split: fit pre-2024, test post-2024 (undated excluded). --- */
  const dated = list.filter((c) => c.listedAt !== null);
  const undatedN = n - dated.length;
  const train = dated.filter((c) => (c.listedAt as string) < "2024-01-01");
  const test = dated.filter((c) => (c.listedAt as string) >= "2024-01-01");
  const tsFit = olsFit(train);
  const tsOffsets = familyOffsets(train, tsFit);
  const tsMed = flatMedianMultiple(train);
  const tsModel: Prediction[] = [];
  const tsFlat: Prediction[] = [];
  const ts025: Prediction[] = [];
  for (const c of test) {
    tsModel.push({
      actual: c.mcap,
      predicted: predictWithCurve(c, tsFit, tsOffsets),
    });
    tsFlat.push({ actual: c.mcap, predicted: tsMed * c.tvl });
    ts025.push({ actual: c.mcap, predicted: 0.25 * c.tvl });
  }

  /* --- 3+4. Band coverage on the LOO predictions. --- */
  // Recompute each held-out band from its training fit's residual spread.
  let inP50 = 0;
  let inP80 = 0;
  for (let i = 0; i < n; i++) {
    const trainI = list.filter((_, j) => j !== i);
    const held = list[i];
    const fit = olsFit(trainI);
    const offsets = familyOffsets(trainI, fit);
    const pred = predictWithCurve(held, fit, offsets);
    const fam = offsets.get(held.category) ?? { offset: 0, n: 0 };
    const rmseAdj = fit.rmse * (1 + 0.25 / Math.sqrt(Math.max(1, fam.n)));
    const logErr = Math.abs(Math.log10(held.mcap / pred));
    if (logErr <= 0.6745 * rmseAdj) inP50 += 1;
    if (logErr <= 1.2816 * rmseAdj) inP80 += 1;
  }

  /* --- 5. Leave-one-category-out. --- */
  const categories = [...new Set(list.map((c) => c.category))];
  const catModel: Prediction[] = [];
  const catFlat: Prediction[] = [];
  for (const cat of categories) {
    const trainC = list.filter((c) => c.category !== cat);
    const heldC = list.filter((c) => c.category === cat);
    if (trainC.length < 10 || heldC.length === 0) continue;
    const fit = olsFit(trainC);
    const offsets = familyOffsets(trainC, fit);
    const med = flatMedianMultiple(trainC);
    for (const c of heldC) {
      catModel.push({
        actual: c.mcap,
        predicted: predictWithCurve(c, fit, offsets),
      });
      catFlat.push({ actual: c.mcap, predicted: med * c.tvl });
    }
  }

  /* --- 6. Bootstrap stability (fixed seed). --- */
  const rand = seededRandom(BOOTSTRAP_SEED);
  const slopes: number[] = [];
  const intercepts: number[] = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const sample: Comparable[] = [];
    for (let i = 0; i < n; i++) {
      sample.push(list[Math.floor(rand() * n)]);
    }
    const fit = olsFit(sample);
    slopes.push(fit.slope);
    intercepts.push(fit.intercept);
  }
  const slopeMean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const intMean = intercepts.reduce((a, b) => a + b, 0) / intercepts.length;
  const slopeSd = Math.sqrt(
    slopes.reduce((a, b) => a + (b - slopeMean) ** 2, 0) / slopes.length,
  );
  const intSd = Math.sqrt(
    intercepts.reduce((a, b) => a + (b - intMean) ** 2, 0) / intercepts.length,
  );
  const sortedSlopes = [...slopes].sort((a, b) => a - b);
  const p5 = sortedSlopes[Math.floor(0.05 * slopes.length)];
  const p95 = sortedSlopes[Math.floor(0.95 * slopes.length)];

  return {
    loo: {
      model: errorStats(looModel),
      flatMedian: errorStats(looFlat),
      flat025: errorStats(loo025),
    },
    timeSplit: {
      model: errorStats(tsModel),
      flatMedian: errorStats(tsFlat),
      flat025: errorStats(ts025),
      trainN: train.length,
      testN: test.length,
      undatedN,
    },
    bandCoverage: { p50: inP50 / n, p80: inP80 / n, n },
    categoryHeldOut: {
      model: errorStats(catModel),
      flatMedian: errorStats(catFlat),
      n: catModel.length,
    },
    bootstrap: {
      slopeMean,
      slopeSd,
      slopeP5: p5,
      slopeP95: p95,
      interceptMean: intMean,
      interceptSd: intSd,
      draws: BOOTSTRAP_DRAWS,
    },
    bias: median(signedLogErrors),
  };
}

export type { Protocol };
