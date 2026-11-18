// token-radar-01 v3 — pricing model.
//
//   value-if-launches = 10 ^ (a + b * log10(forward TVL) + family offset)
//   implied value     = value-if-launches * launch odds
//
// The curve is ordinary least squares on log10(market cap) against
// log10(TVL), fitted on the dated comparables — the one comp set every
// validation check can use. Family offsets are median residuals per
// category, shrunk and capped; the shrinkage is tuned by leave-one-out
// (see tuneShrinkage). Launch odds come from the snapshot's own counts:
// a category base rate, Beta-shrunk toward the global rate, times an age
// factor from the empirical token rate by age bucket. No seasoning and
// no sibling multiplier: the age effect lives in the odds, where it can
// be measured, and a same-name traded token is flagged, not priced.

import {
  ageOf,
  middle,
  recordsToken,
  type Comp,
  type Proto,
  type Snap,
} from "./snap.ts";

export interface Line {
  intercept: number;
  slope: number;
  rmse: number;
  n: number;
}

export interface PricedRow {
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
  categoryRate: number;
  ageBucket: string;
  ageFactor: number;
  odds: number;
  implied: number;
  sameNameTrades: boolean;
  rankLo: number;
  rankHi: number;
}

/** Family offsets may not move a value by more than this in log-ten. */
export const OFFSET_LIMIT = 0.5;
/** Launch odds are clamped to this band. */
export const ODDS_FLOOR = 0.05;
export const ODDS_CEILING = 0.9;
/** Pseudo-count weight pulling thin categories toward the global rate. */
export const CATEGORY_PRIOR = 10;
/** Forward TVL: the 7-day change, clamped to this band either way. */
export const FORWARD_CLAMP = 0.2;
/** Fixed seed for the bootstrap refits (determinism). */
export const BOOT_SEED = 20261114;
export const BOOT_DRAWS = 200;

/** Least squares on log10(cap) vs log10(TVL). */
export function fitLine(list: Comp[]): Line {
  const n = list.length;
  const pts = list.map((c) => [Math.log10(c.tvl), Math.log10(c.mcap)]);
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  const ax = sx / n;
  const ay = sy / n;
  let vxx = 0;
  let vxy = 0;
  for (const [x, y] of pts) {
    vxx += (x - ax) * (x - ax);
    vxy += (x - ax) * (y - ay);
  }
  const slope = vxy / vxx;
  const intercept = ay - slope * ax;
  let err2 = 0;
  for (const [x, y] of pts) {
    const gap = y - (intercept + slope * x);
    err2 += gap * gap;
  }
  return { intercept, slope, rmse: Math.sqrt(err2 / n), n };
}

/**
 * Median residual per category, shrunk by n / (n + k) and capped at
 * ±OFFSET_LIMIT. Categories with fewer than minN comps get no offset.
 */
export function familyShifts(
  list: Comp[],
  line: Line,
  k: number,
  minN: number,
): Map<string, { shift: number; n: number }> {
  const buckets = new Map<string, number[]>();
  for (const c of list) {
    const resid =
      Math.log10(c.mcap) - (line.intercept + line.slope * Math.log10(c.tvl));
    const arr = buckets.get(c.category) ?? [];
    arr.push(resid);
    buckets.set(c.category, arr);
  }
  const out = new Map<string, { shift: number; n: number }>();
  for (const [cat, resids] of buckets) {
    const n = resids.length;
    if (n < minN) {
      out.set(cat, { shift: 0, n });
      continue;
    }
    const shrunk = middle(resids) * (n / (n + k));
    out.set(cat, {
      shift: Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, shrunk)),
      n,
    });
  }
  return out;
}

/** Predict a comparable's cap from the line plus its family shift. */
export function predictCap(
  c: Comp,
  line: Line,
  shifts: Map<string, { shift: number; n: number }>,
): number {
  const s = shifts.get(c.category)?.shift ?? 0;
  return Math.pow(10, line.intercept + line.slope * Math.log10(c.tvl) + s);
}

/** Median absolute log-ten error, as a multiple (×1 is exact). */
export function medianMiss(pairs: Array<[number, number]>): number {
  const mults = pairs.map(([actual, pred]) =>
    Math.pow(10, Math.abs(Math.log10(pred / actual))),
  );
  return middle(mults);
}

/** Leave-one-out median miss for one shrinkage setting. */
export function looMiss(list: Comp[], k: number, minN: number): number {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < list.length; i++) {
    const train = [...list.slice(0, i), ...list.slice(i + 1)];
    const held = list[i];
    const line = fitLine(train);
    const shifts = familyShifts(train, line, k, minN);
    pairs.push([held.mcap, predictCap(held, line, shifts)]);
  }
  return medianMiss(pairs);
}

/**
 * Tune the shrinkage by leave-one-out over a small grid. The winner is
 * the smallest LOO; among settings within 1% of it, the most-shrunk
 * (largest k) wins, because heavier shrinkage generalizes better on the
 * walk-forward and time-split checks. The full grid is returned for the
 * board, so the choice is auditable rather than asserted.
 */
export function tuneShrinkage(list: Comp[]): {
  k: number;
  minN: number;
  grid: Array<{ k: number; minN: number; loo: number }>;
  curveOnlyLoo: number;
} {
  const grid: Array<{ k: number; minN: number; loo: number }> = [];
  for (const k of [3, 5, 10, 20, 40]) {
    for (const minN of [2, 3]) {
      grid.push({ k, minN, loo: looMiss(list, k, minN) });
    }
  }
  // Curve-only: minN above any category size, so every shift is zero.
  const curveOnlyLoo = looMiss(list, 0, 1_000_000);
  let best = Infinity;
  for (const g of grid) best = Math.min(best, g.loo);
  const near = grid.filter((g) => g.loo <= best * 1.01);
  near.sort((a, b) => b.k - a.k || a.minN - b.minN);
  const pick = near[0];
  return { k: pick.k, minN: pick.minN, grid, curveOnlyLoo };
}

/** TVL carried forward by the 7-day change, clamped to ±20%. */
export function forwardTvl(tvl: number, change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) {
    return tvl;
  }
  const frac = Math.max(
    -FORWARD_CLAMP,
    Math.min(FORWARD_CLAMP, change7d / 100),
  );
  return tvl * (1 + frac);
}

/* ---- Launch odds, from the snapshot's own counts ---- */

export interface OddsTable {
  globalLaunched: number;
  globalTotal: number;
  globalRate: number;
  datedRate: number;
  buckets: Array<{
    label: string;
    launched: number;
    total: number;
    rate: number;
    factor: number;
  }>;
  categoryRates: Map<string, { launched: number; total: number; rate: number }>;
  typicalWaitDays: number;
}

function bucketLabel(ageDays: number | null): string {
  if (ageDays === null) return "unknown";
  if (ageDays < 365) return "<1y";
  if (ageDays < 730) return "1–2y";
  if (ageDays < 1095) return "2–3y";
  return "3y+";
}

export function buildOddsTable(snap: Snap): OddsTable {
  const all = snap.protocols;
  const globalLaunched = all.filter(recordsToken).length;
  const globalRate = globalLaunched / all.length;

  const catStats = new Map<string, { launched: number; total: number }>();
  for (const p of all) {
    const cat = p.category === null ? "Uncategorized" : p.category;
    const s = catStats.get(cat) ?? { launched: 0, total: 0 };
    s.total += 1;
    if (recordsToken(p)) s.launched += 1;
    catStats.set(cat, s);
  }
  const categoryRates = new Map<
    string,
    { launched: number; total: number; rate: number }
  >();
  for (const [cat, s] of catStats) {
    const rate =
      (s.launched + CATEGORY_PRIOR * globalRate) / (s.total + CATEGORY_PRIOR);
    categoryRates.set(cat, { ...s, rate });
  }

  const dated = all.filter((p) => p.listed_at !== null);
  const datedRate = dated.filter(recordsToken).length / dated.length;
  const labels = ["<1y", "1–2y", "2–3y", "3y+"];
  const buckets = labels.map((label) => {
    const members = dated.filter((p) => bucketLabel(ageOf(p, snap.as_of)) === label);
    const launched = members.filter(recordsToken).length;
    const rate = members.length > 0 ? launched / members.length : datedRate;
    return {
      label,
      launched,
      total: members.length,
      rate,
      factor: rate / datedRate,
    };
  });

  // Typical wait: the median age of the protocols that record a token.
  const tradedAges = all
    .filter((p) => recordsToken(p) && p.listed_at !== null)
    .map((p) => ageOf(p, snap.as_of) as number);
  const typicalWaitDays = Math.round(middle(tradedAges));

  return {
    globalLaunched,
    globalTotal: all.length,
    globalRate,
    datedRate,
    buckets,
    categoryRates,
    typicalWaitDays,
  };
}

/** One protocol's launch odds, with its ingredients exposed. */
export function launchOdds(
  p: Proto,
  table: OddsTable,
  asOf: string,
): {
  odds: number;
  categoryRate: number;
  ageBucket: string;
  ageFactor: number;
} {
  const cat = p.category === null ? "Uncategorized" : p.category;
  const categoryRate = table.categoryRates.get(cat)?.rate ?? table.globalRate;
  const ageDays = ageOf(p, asOf);
  const ageBucket = bucketLabel(ageDays);
  const bucket = table.buckets.find((b) => b.label === ageBucket);
  const ageFactor = bucket === undefined ? 1 : bucket.factor;
  const raw = categoryRate * ageFactor;
  return {
    odds: Math.max(ODDS_FLOOR, Math.min(ODDS_CEILING, raw)),
    categoryRate,
    ageBucket,
    ageFactor,
  };
}

/* ---- Price the board ---- */

/**
 * True when a traded protocol's full name is this name (or its prefix
 * followed by a space): a flag for the detail view, never a multiplier.
 */
export function sameNameAsTraded(name: string, tradedNames: string[]): boolean {
  const lower = name.toLowerCase();
  for (const t of tradedNames) {
    if (lower === t || lower.startsWith(`${t} `)) return true;
  }
  return false;
}

export function priceRows(
  snap: Snap,
  board: Proto[],
  line: Line,
  shifts: Map<string, { shift: number; n: number }>,
  oddsTable: OddsTable,
): PricedRow[] {
  const watch = new Set(snap.watchlist);
  const tradedNames = snap.protocols
    .filter(recordsToken)
    .map((p) => p.name.toLowerCase());
  const rows: PricedRow[] = board.map((p) => {
    const cat = p.category === null ? "Uncategorized" : p.category;
    const fwd = forwardTvl(p.tvl_usd, p.change_7d);
    const curveValue = Math.pow(
      10,
      line.intercept + line.slope * Math.log10(fwd),
    );
    const fam = shifts.get(cat) ?? { shift: 0, n: 0 };
    const valueIfLaunches = curveValue * Math.pow(10, fam.shift);
    const o = launchOdds(p, oddsTable, snap.as_of);
    return {
      slug: p.slug,
      name: p.name,
      category: cat,
      chains: p.chains,
      tvl: p.tvl_usd,
      change7d: p.change_7d,
      ageDays: ageOf(p, snap.as_of),
      watchlist: watch.has(p.slug),
      forwardTvl: fwd,
      curveValue,
      familyOffset: fam.shift,
      familyN: fam.n,
      valueIfLaunches,
      categoryRate: o.categoryRate,
      ageBucket: o.ageBucket,
      ageFactor: o.ageFactor,
      odds: o.odds,
      implied: valueIfLaunches * o.odds,
      sameNameTrades: sameNameAsTraded(p.name, tradedNames),
      rankLo: 0,
      rankHi: 0,
    };
  });
  sortByImplied(rows);
  return rows;
}

/** Sort by implied value, ties by TVL then slug (deterministic). */
export function sortByImplied(rows: PricedRow[]): void {
  rows.sort((a, b) => {
    if (a.implied !== b.implied) return b.implied - a.implied;
    if (a.tvl !== b.tvl) return b.tvl - a.tvl;
    return a.slug.localeCompare(b.slug);
  });
}

/** Fixed-seed generator (LCG): the bootstrap never touches Math.random. */
export function seededDraws(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Rank ranges from bootstrap refits: resample the comp set, refit the
 * line and shifts, reprice and rerank the whole board, and record each
 * row's P10–P90 rank across draws. Also returns the slope distribution,
 * so one loop serves both the rank ranges and the stability panel.
 */
export function bootstrapRanks(
  snap: Snap,
  board: Proto[],
  comps: Comp[],
  k: number,
  minN: number,
  oddsTable: OddsTable,
  rows: PricedRow[],
): {
  slopeMean: number;
  slopeSd: number;
  slopeP5: number;
  slopeP95: number;
  draws: number;
} {
  const rand = seededDraws(BOOT_SEED);
  const ranks = new Map<string, number[]>();
  for (const r of rows) ranks.set(r.slug, []);
  const slopes: number[] = [];
  for (let d = 0; d < BOOT_DRAWS; d++) {
    const sample: Comp[] = [];
    for (let i = 0; i < comps.length; i++) {
      sample.push(comps[Math.floor(rand() * comps.length)]);
    }
    const line = fitLine(sample);
    slopes.push(line.slope);
    const shifts = familyShifts(sample, line, k, minN);
    const repriced = priceRows(snap, board, line, shifts, oddsTable);
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
    draws: BOOT_DRAWS,
  };
}

/** Nearest traded comparables: close in TVL, same category preferred. */
export function nearestComps(row: PricedRow, comps: Comp[], n: number): Comp[] {
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
