// token-radar-01 v4 — size curve and board pricing.
//
//   value-if-launches = 10 ^ (a + b * log10(forward TVL) + family offset)
//   implied value     = value-if-launches * launch odds
//
// The curve is ordinary least squares on log10(market cap) against
// log10(TVL), fitted on the dated comparables — the one comp set every
// validation check can use. Family offsets are median residuals per
// category, shrunk and capped; the shrinkage is tuned by leave-one-out.
// The odds come from lib/odds.ts (a ridge logistic model) and arrive
// here as a function, so this module never sees how odds are fitted.
//
// Tuning discipline (new in v4): the shrinkage tuned on the full set is
// used ONLY for the final fit. Every validation check re-tunes inside
// itself (see lib/checks.ts) — the tuning that picked k must not see the
// comps the check holds out. The flat numbers are still reported beside
// the nested ones, so the tuning optimism is visible, not hidden.

import {
  categoryOf,
  hasTokenRecord,
  medianOf,
  protocolAge,
  type Comparable,
  type Protocol,
  type Snapshot,
} from "./snapshot.ts";

export interface CurveFit {
  intercept: number;
  slope: number;
  rmse: number;
  n: number;
}

export interface ValuedRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  change7d: number | null;
  ageDays: number | null;
  watchlist: boolean;
  forwardTvl: number;
  curveValue: number;
  familyOffset: number;
  familyN: number;
  valueIfLaunches: number;
  odds: number;
  catEffect: number;
  ageEffect: number;
  ageBucket: string;
  implied: number;
  sameNameTrades: boolean;
  rankLo: number;
  rankHi: number;
}

/** What the odds module hands each row: the odds and its log-odds parts. */
export interface OddsParts {
  odds: number;
  catEffect: number;
  ageEffect: number;
  ageBucket: string;
}

/** Family offsets may not move a value by more than this in log-ten. */
export const OFFSET_CAP = 0.5;
/** Forward TVL: the 7-day change, clamped to this band either way. */
export const FORWARD_CAP = 0.2;
/** Fixed seed for the bootstrap refits (determinism). */
export const BOOTSTRAP_SEED = 20261119;
export const BOOTSTRAP_DRAWS = 200;
/** The shrinkage grid every tuning pass searches. */
export const SHRINK_GRID: Array<{ k: number; minN: number }> = [
  { k: 3, minN: 2 },
  { k: 3, minN: 3 },
  { k: 5, minN: 2 },
  { k: 5, minN: 3 },
  { k: 10, minN: 2 },
  { k: 10, minN: 3 },
  { k: 20, minN: 2 },
  { k: 20, minN: 3 },
  { k: 40, minN: 2 },
  { k: 40, minN: 3 },
];

/** Least squares on log10(cap) vs log10(TVL). */
export function fitCurve(list: Comparable[]): CurveFit {
  const n = list.length;
  const pts = list.map((c) => [Math.log10(c.tvl), Math.log10(c.mcap)]);
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  const meanX = sx / n;
  const meanY = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - meanX) * (x - meanX);
    sxy += (x - meanX) * (y - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let squared = 0;
  for (const [x, y] of pts) {
    squared += (y - (intercept + slope * x)) ** 2;
  }
  return { intercept, slope, rmse: Math.sqrt(squared / n), n };
}

/**
 * Median residual per category, shrunk by n / (n + k) and capped at
 * ±OFFSET_CAP. Categories with fewer than minN comps get no offset.
 */
export function categoryOffsets(
  list: Comparable[],
  curve: CurveFit,
  k: number,
  minN: number,
): Map<string, { shift: number; n: number }> {
  const byCat = new Map<string, number[]>();
  for (const c of list) {
    const resid =
      Math.log10(c.mcap) -
      (curve.intercept + curve.slope * Math.log10(c.tvl));
    const arr = byCat.get(c.category) ?? [];
    arr.push(resid);
    byCat.set(c.category, arr);
  }
  const out = new Map<string, { shift: number; n: number }>();
  for (const [cat, resids] of byCat) {
    const n = resids.length;
    if (n < minN) {
      out.set(cat, { shift: 0, n });
      continue;
    }
    const shrunk = medianOf(resids) * (n / (n + k));
    out.set(cat, {
      shift: Math.max(-OFFSET_CAP, Math.min(OFFSET_CAP, shrunk)),
      n,
    });
  }
  return out;
}

/** One fitted model: a curve plus its category offsets. */
export interface FittedModel {
  curve: CurveFit;
  offsets: Map<string, { shift: number; n: number }>;
}

/** Fit a curve and its offsets at one shrinkage setting. */
export function fitModel(
  list: Comparable[],
  k: number,
  minN: number,
): FittedModel {
  const curve = fitCurve(list);
  return { curve, offsets: categoryOffsets(list, curve, k, minN) };
}

/** Predict a comparable's cap from a fitted model. */
export function predictValue(model: FittedModel, c: Comparable): number {
  const shift = model.offsets.get(c.category)?.shift ?? 0;
  return Math.pow(
    10,
    model.curve.intercept + model.curve.slope * Math.log10(c.tvl) + shift,
  );
}

/** Median absolute log-ten error, as a multiple (×1 is exact). */
export function missAsMultiple(pairs: Array<[number, number]>): number {
  const mults = pairs.map(([actual, pred]) =>
    Math.pow(10, Math.abs(Math.log10(pred / actual))),
  );
  return medianOf(mults);
}

/** Leave-one-out median miss for one shrinkage setting. */
export function looWithSettings(
  list: Comparable[],
  k: number,
  minN: number,
): number {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < list.length; i++) {
    const train = [...list.slice(0, i), ...list.slice(i + 1)];
    pairs.push([list[i].mcap, predictValue(fitModel(train, k, minN), list[i])]);
  }
  return missAsMultiple(pairs);
}

/**
 * Tune the shrinkage by leave-one-out over SHRINK_GRID. The winner is
 * the smallest LOO; among settings within 1% of it, the most-shrunk
 * (largest k) wins, because heavier shrinkage holds up better on the
 * time-based checks. The full grid is returned for the board, so the
 * choice is auditable rather than asserted.
 *
 * Call this on the training set of the check that uses the result — for
 * the final fit, the full dated set; inside a validation check, that
 * check's training set only (nested tuning, no lookahead).
 */
export function tuneSettings(list: Comparable[]): {
  k: number;
  minN: number;
  grid: Array<{ k: number; minN: number; loo: number }>;
  curveOnlyLoo: number;
} {
  const grid = SHRINK_GRID.map(({ k, minN }) => ({
    k,
    minN,
    loo: looWithSettings(list, k, minN),
  }));
  // Curve-only: minN above any category size, so every offset is zero.
  const curveOnlyLoo = looWithSettings(list, 0, 1_000_000);
  let best = Infinity;
  for (const g of grid) best = Math.min(best, g.loo);
  const near = grid.filter((g) => g.loo <= best * 1.01);
  near.sort((a, b) => b.k - a.k || a.minN - b.minN);
  return { k: near[0].k, minN: near[0].minN, grid, curveOnlyLoo };
}

/** TVL carried forward by the 7-day change, clamped to ±20%. */
export function carryForwardTvl(tvl: number, change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return tvl;
  const frac = Math.max(
    -FORWARD_CAP,
    Math.min(FORWARD_CAP, change7d / 100),
  );
  return tvl * (1 + frac);
}

/* ---- Price the board ---- */

/**
 * True when a traded protocol's name is this name (or its prefix followed
 * by a space): a flag for the detail view, never a multiplier.
 */
export function sharesNameWithTraded(
  name: string,
  tradedNames: string[],
): boolean {
  const lower = name.toLowerCase();
  for (const t of tradedNames) {
    if (lower === t || lower.startsWith(`${t} `)) return true;
  }
  return false;
}

/** Sort by implied value, ties by TVL then slug (deterministic). */
export function sortByValue(rows: ValuedRow[]): void {
  rows.sort((a, b) => {
    if (a.implied !== b.implied) return b.implied - a.implied;
    if (a.tvl !== b.tvl) return b.tvl - a.tvl;
    return a.slug.localeCompare(b.slug);
  });
}

export function valueBoard(
  snap: Snapshot,
  board: Protocol[],
  model: FittedModel,
  oddsFor: (p: Protocol) => OddsParts,
): ValuedRow[] {
  const watch = new Set(snap.watchlist);
  const tradedNames = snap.protocols
    .filter(hasTokenRecord)
    .map((p) => p.name.toLowerCase());
  const rows: ValuedRow[] = board.map((p) => {
    const cat = categoryOf(p);
    const fwd = carryForwardTvl(p.tvl_usd, p.change_7d);
    const curveValue = Math.pow(
      10,
      model.curve.intercept + model.curve.slope * Math.log10(fwd),
    );
    const fam = model.offsets.get(cat) ?? { shift: 0, n: 0 };
    const valueIfLaunches = curveValue * Math.pow(10, fam.shift);
    const o = oddsFor(p);
    return {
      slug: p.slug,
      name: p.name,
      category: cat,
      chains: p.chains,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: protocolAge(p, snap.as_of),
      watchlist: watch.has(p.slug),
      forwardTvl: fwd,
      curveValue,
      familyOffset: fam.shift,
      familyN: fam.n,
      valueIfLaunches,
      odds: o.odds,
      catEffect: o.catEffect,
      ageEffect: o.ageEffect,
      ageBucket: o.ageBucket,
      implied: valueIfLaunches * o.odds,
      sameNameTrades: sharesNameWithTraded(p.name, tradedNames),
      rankLo: 0,
      rankHi: 0,
    };
  });
  sortByValue(rows);
  return rows;
}

/** Fixed-seed generator (mulberry32): the bootstrap never touches Math.random. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rank ranges from bootstrap refits: resample the comp set, refit the
 * curve and offsets at the final shrinkage, reprice and rerank the whole
 * board, and record each row's P10–P90 rank across draws. The odds model
 * is NOT refit per draw (it is fitted once on all 758 protocols) — the
 * refits measure the pricing curve's stability, not the odds'. Also
 * returns the slope distribution for the stability panel.
 */
export function bootstrapRankBands(
  snap: Snapshot,
  board: Protocol[],
  comps: Comparable[],
  k: number,
  minN: number,
  oddsFor: (p: Protocol) => OddsParts,
  rows: ValuedRow[],
): {
  slopeMean: number;
  slopeSd: number;
  slopeP5: number;
  slopeP95: number;
  draws: number;
} {
  const rand = mulberry32(BOOTSTRAP_SEED);
  const ranks = new Map<string, number[]>();
  for (const r of rows) ranks.set(r.slug, []);
  const slopes: number[] = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const sample: Comparable[] = [];
    for (let i = 0; i < comps.length; i++) {
      sample.push(comps[Math.floor(rand() * comps.length)]);
    }
    const model = fitModel(sample, k, minN);
    slopes.push(model.curve.slope);
    const repriced = valueBoard(snap, board, model, oddsFor);
    repriced.forEach((r, i) => ranks.get(r.slug)!.push(i + 1));
  }
  for (const r of rows) {
    const arr = [...(ranks.get(r.slug) ?? [])].sort((a, b) => a - b);
    r.rankLo = arr[Math.floor(0.1 * arr.length)] ?? 0;
    r.rankHi = arr[Math.floor(0.9 * arr.length)] ?? 0;
  }
  const mean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const sd = Math.sqrt(
    slopes.reduce((a, b) => a + (b - mean) * (b - mean), 0) / slopes.length,
  );
  const sorted = [...slopes].sort((a, b) => a - b);
  return {
    slopeMean: mean,
    slopeSd: sd,
    slopeP5: sorted[Math.floor(0.05 * sorted.length)],
    slopeP95: sorted[Math.floor(0.95 * sorted.length)],
    draws: BOOTSTRAP_DRAWS,
  };
}

/** Nearest traded comparables: close in TVL, same category preferred. */
export function closestComparables(
  row: ValuedRow,
  comps: Comparable[],
  n: number,
): Comparable[] {
  return [...comps]
    .map((c) => ({
      c,
      d:
        Math.abs(Math.log10(c.tvl / row.tvl)) +
        (c.category === row.category ? 0 : 1),
    }))
    .sort((a, b) => a.d - b.d || a.c.slug.localeCompare(b.c.slug))
    .slice(0, n)
    .map((x) => x.c);
}
