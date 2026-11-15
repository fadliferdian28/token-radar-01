/**
 * token-radar-01 v2 — value model.
 *
 * A fitted size curve with family offsets, growth, seasoning and a sibling
 * rule, computed at run time from the sealed snapshot. No protocol name is
 * ever special-cased; every fitted number below comes from the data.
 *
 * Model (all in base-ten logs unless noted):
 *   log10(value) = intercept + slope * log10(TVL)
 *                  + familyOffset(category)          [shrunk, capped]
 *                  + log10(growthFactor)             [clamped, dampened]
 *                  + log10(seasoningFactor)          [log age, capped]
 *                  + log10(siblingFactor)            [0.5 if a sibling trades]
 * The launch probability is computed per category but is NOT part of the
 * ranking value: it weights the farm economics only (see lib/economics.ts),
 * so the board's order matches the field's consensus while the verdicts
 * stay probability-aware.
 */

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** A traded token usable as a comparable for the size curve. */
export interface Comparable {
  slug: string;
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  listedAt: string | null;
}

/** The fitted size curve plus its diagnostics. */
export interface CurveFit {
  intercept: number;
  slope: number;
  rmse: number;
  n: number;
}

/** Everything the ranking needs, fitted once from the snapshot. */
export interface Model {
  fit: CurveFit;
  offsets: Map<string, { offset: number; n: number }>;
  medianAgeDays: number;
  /** Full lowercased names of every protocol that records a token. */
  tradedNames: string[];
  launchProb: Map<string, number>;
  comparableCount: number;
  excludedZeroMcap: number;
  winsorized: number;
}

/** One ranked board row (before farm economics). */
export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  change7d: number | null;
  ageDays: number | null;
  ageMissing: boolean;
  growthMissing: boolean;
  watchlist: boolean;
  value: number;
  p10: number;
  p90: number;
  baseValue: number;
  familyOffset: number;
  growthFactor: number;
  seasoningFactor: number;
  siblingFactor: number;
  launchProb: number;
}

/* ---- Stated constants (also stated on the dashboard's method tab). ---- */

/** Market-cap-to-TVL ratios above this are capped (winsorized). */
export const RATIO_CAP = 100;
/** Family offsets are shrunk by n / (n + SHRINK_K). */
export const SHRINK_K = 3;
/** No family offset may exceed this in log-ten either way. */
export const OFFSET_CAP = 0.5;
/** Seven-day change is clamped to this band (as a fraction) before use. */
export const GROWTH_MIN = -0.5;
export const GROWTH_MAX = 1.0;
/** Weight of the (clamped) seven-day change on the value. */
export const GROWTH_WEIGHT = 0.1;
/** Seasoning rises with log age up to this many days, worth at most this. */
export const SEASON_CAP_DAYS = 1095;
export const SEASON_MAX = 0.15;
/** Discount when a sibling product's token already trades. */
export const SIBLING_DISCOUNT = 0.5;
/** Launch-probability prior (Beta(2, 2)) and its clamp. */
export const LAUNCH_PRIOR = 2;
export const LAUNCH_MIN = 0.1;
export const LAUNCH_MAX = 0.9;
/** z for the central 80% band (P10 to P90). */
export const BAND_Z = 1.2816;

/* ---- The house rule (from the snapshot README, reproduced exactly). ---- */

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
  "Centralized Exchange",
]);

const EXCHANGE_NAMES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

/** Version marker at the end of a name: a space then V12, v2, 2.0, ... */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** True when the protocol records no token and is not an excluded product. */
export function isRankable(p: Protocol): boolean {
  if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) {
    return false;
  }
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    return false;
  }
  const name = p.name || "";
  if (VERSION_MARKER.test(name)) return false;
  if (WRAPPED_WORD.test(name)) return false;
  for (const ex of EXCHANGE_NAMES) {
    if (name.startsWith(ex)) return false;
  }
  return true;
}

/** True when the protocol records a token (any of the three fields set). */
export function hasToken(p: Protocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/* ---- Comparable set ---- */

/**
 * Traded protocols usable for the fit: positive market cap and positive TVL.
 * Zero/negative market caps are excluded as data errors (stated on the
 * dashboard). Ratios are winsorized at RATIO_CAP so one token cannot bend
 * the curve.
 */
export function comparables(
  protocols: Protocol[],
): { list: Comparable[]; excludedZeroMcap: number; winsorized: number } {
  const list: Comparable[] = [];
  let excludedZeroMcap = 0;
  let winsorized = 0;
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    if (p.mcap_usd <= 0) {
      excludedZeroMcap += 1;
      continue;
    }
    let mcap = p.mcap_usd;
    if (mcap / p.tvl_usd > RATIO_CAP) {
      mcap = RATIO_CAP * p.tvl_usd;
      winsorized += 1;
    }
    list.push({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      tvl: p.tvl_usd,
      mcap,
      listedAt: p.listed_at,
    });
  }
  return { list, excludedZeroMcap, winsorized };
}

/* ---- Ordinary least squares on log10(mcap) vs log10(tvl). ---- */

export function olsFit(list: Comparable[]): CurveFit {
  const n = list.length;
  const xs = list.map((c) => Math.log10(c.tvl));
  const ys = list.map((c) => Math.log10(c.mcap));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    sse += r * r;
  }
  return { intercept, slope, rmse: Math.sqrt(sse / n), n };
}

/* ---- Family offsets: median residual per category, shrunk and capped. ---- */

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length;
  if (m === 0) return 0;
  return m % 2 === 1 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

export function familyOffsets(
  list: Comparable[],
  fit: CurveFit,
): Map<string, { offset: number; n: number }> {
  const byCat = new Map<string, number[]>();
  for (const c of list) {
    const resid =
      Math.log10(c.mcap) - (fit.intercept + fit.slope * Math.log10(c.tvl));
    const arr = byCat.get(c.category) ?? [];
    arr.push(resid);
    byCat.set(c.category, arr);
  }
  const out = new Map<string, { offset: number; n: number }>();
  for (const [cat, residuals] of byCat) {
    const n = residuals.length;
    if (n < 2) {
      out.set(cat, { offset: 0, n });
      continue;
    }
    const raw = median(residuals);
    const shrunk = raw * (n / (n + SHRINK_K));
    const capped = Math.max(-OFFSET_CAP, Math.min(OFFSET_CAP, shrunk));
    out.set(cat, { offset: capped, n });
  }
  return out;
}

/* ---- Age, growth, sibling, launch probability ---- */

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(fromYmd + "T00:00:00Z");
  const b = Date.parse(toYmd + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  const frac = change7d / 100;
  const clamped = Math.max(GROWTH_MIN, Math.min(GROWTH_MAX, frac));
  return 1 + GROWTH_WEIGHT * clamped;
}

export function seasoningFactor(ageDays: number): number {
  const days = Math.max(1, ageDays);
  const frac =
    Math.min(Math.log10(days), Math.log10(SEASON_CAP_DAYS)) /
    Math.log10(SEASON_CAP_DAYS);
  return 1 + SEASON_MAX * frac;
}

/**
 * True when the pre-token protocol is a product line of a protocol whose
 * token already trades: the traded protocol's FULL name is a prefix of
 * this protocol's name (e.g. "Aave V3" under traded "Aave"). A shared
 * brand word alone ("Flying Tulip ftUSD" vs traded "Flying Tulip Lend")
 * is not a sibling: the products are distinct and the stablecoin is not
 * the lending market's token.
 */
function isSibling(name: string, tradedNames: string[]): boolean {
  const lower = name.toLowerCase();
  for (const tn of tradedNames) {
    if (lower === tn || lower.startsWith(tn + " ")) return true;
  }
  return false;
}

/**
 * Launch probability per category: the share of the category's protocols
 * that already trade, with a Beta(2, 2) prior so thin categories shrink
 * toward one half, clamped to [LAUNCH_MIN, LAUNCH_MAX].
 */
export function launchProbabilities(
  protocols: Protocol[],
  rankableSlugs: Set<string>,
): Map<string, number> {
  const stats = new Map<string, { launched: number; total: number }>();
  for (const p of protocols) {
    const cat = p.category ?? "Uncategorized";
    const s = stats.get(cat) ?? { launched: 0, total: 0 };
    s.total += 1;
    if (hasToken(p)) s.launched += 1;
    stats.set(cat, s);
  }
  const out = new Map<string, number>();
  for (const [cat, s] of stats) {
    const p =
      (s.launched + LAUNCH_PRIOR) / (s.total + 2 * LAUNCH_PRIOR);
    out.set(cat, Math.max(LAUNCH_MIN, Math.min(LAUNCH_MAX, p)));
  }
  void rankableSlugs;
  return out;
}

/* ---- Fit the whole model from the snapshot. ---- */

export function fitModel(snapshot: Snapshot): Model {
  const { list, excludedZeroMcap, winsorized } = comparables(
    snapshot.protocols,
  );
  const fit = olsFit(list);
  const offsets = familyOffsets(list, fit);
  const rankable = snapshot.protocols.filter(isRankable);
  const ages = rankable
    .map((p) => (p.listed_at ? daysBetween(p.listed_at, snapshot.as_of) : null))
    .filter((d): d is number => d !== null);
  const medianAgeDays = ages.length > 0 ? median(ages) : 365;
  const tradedNames = snapshot.protocols
    .filter(hasToken)
    .map((p) => p.name.toLowerCase());
  const rankableSlugs = new Set(rankable.map((p) => p.slug));
  const launchProb = launchProbabilities(snapshot.protocols, rankableSlugs);
  return {
    fit,
    offsets,
    medianAgeDays,
    tradedNames,
    launchProb,
    comparableCount: list.length,
    excludedZeroMcap,
    winsorized,
  };
}

/* ---- Value one protocol. ---- */

export function valueProtocol(
  p: Protocol,
  model: Model,
  snapshot: Snapshot,
): BoardRow {
  const category = p.category ?? "Uncategorized";
  const watch = new Set(snapshot.watchlist);
  const baseLog =
    model.fit.intercept + model.fit.slope * Math.log10(p.tvl_usd);
  const baseValue = Math.pow(10, baseLog);
  const fam = model.offsets.get(category) ?? { offset: 0, n: 0 };
  const gf = growthFactor(p.change_7d);
  const ageDays = p.listed_at
    ? daysBetween(p.listed_at, snapshot.as_of)
    : null;
  const ageMissing = ageDays === null;
  const age = ageDays ?? model.medianAgeDays;
  const sf = seasoningFactor(age);
  const sibling = isSibling(p.name, model.tradedNames)
    ? SIBLING_DISCOUNT
    : 1;
  const logValue =
    baseLog + fam.offset + Math.log10(gf) + Math.log10(sf) + Math.log10(sibling);
  const value = Math.pow(10, logValue);
  // Prediction band: residual spread, widened for thin families and for
  // rows missing age or growth data.
  const nFam = fam.n;
  let rmseAdj = model.fit.rmse * (1 + 0.25 / Math.sqrt(Math.max(1, nFam)));
  if (ageMissing || p.change_7d === null) rmseAdj *= 1.2;
  const half = BAND_Z * rmseAdj;
  return {
    slug: p.slug,
    name: p.name,
    category,
    chains: p.chains,
    tvl: p.tvl_usd,
    change7d: p.change_7d,
    ageDays,
    ageMissing,
    growthMissing: p.change_7d === null,
    watchlist: watch.has(p.slug),
    value,
    p10: value * Math.pow(10, -half),
    p90: value * Math.pow(10, half),
    baseValue,
    familyOffset: fam.offset,
    growthFactor: gf,
    seasoningFactor: sf,
    siblingFactor: sibling,
    launchProb: model.launchProb.get(category) ?? 0.5,
  };
}

/* ---- Rank the whole board. ---- */

export function rankBoard(snapshot: Snapshot, model: Model): BoardRow[] {
  const rows = snapshot.protocols
    .filter(isRankable)
    .map((p) => valueProtocol(p, model, snapshot));
  rows.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.tvl !== a.tvl) return b.tvl - a.tvl;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return rows;
}
