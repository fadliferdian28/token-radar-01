// token-radar-01 v3 — snapshot layer.
//
// Reads the sealed snapshot, classifies every protocol, and builds the
// comparable set the size curve is fitted on. Nothing here knows any
// protocol by name: every split follows from the snapshot's own fields.

export interface Proto {
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

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** A traded token the curve can learn from: a real cap on a real TVL. */
export interface Comp {
  slug: string;
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  listedAt: string | null;
  change7d: number | null;
}

/** Whole days between two UTC dates (YYYY-MM-DD). Never negative. */
export function daySpan(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/** Age in days at the snapshot date, or null when unlisted. */
export function ageOf(p: Proto, asOf: string): number | null {
  return p.listed_at === null ? null : daySpan(p.listed_at, asOf);
}

/** Median of a non-empty list (0 for an empty one). */
export function middle(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  const half = Math.floor(n / 2);
  return n % 2 === 1 ? ordered[half] : (ordered[half - 1] + ordered[half]) / 2;
}

/** Records a token when any of the three token fields is set. */
export function recordsToken(p: Proto): boolean {
  const cap = p.mcap_usd !== null;
  const gecko = p.gecko_id !== null;
  const sym = p.symbol !== null;
  return cap || gecko || sym;
}

// The house rule's exclusion lists (snapshot README, reproduced exactly).
const BARRED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
  "Centralized Exchange",
]);

const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

/** A version suffix: a space, then V3, v2, 2.0, and the like. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;

/**
 * Rankable: records no token and is not an excluded product. This is the
 * board's universe; the watchlist is a subset of it, never the whole of it.
 */
export function rankable(p: Proto): boolean {
  if (recordsToken(p)) return false;
  if (p.category !== null && BARRED_CATEGORIES.has(p.category)) return false;
  const name = p.name || "";
  if (VERSION_SUFFIX.test(name)) return false;
  if (WRAPPED_TERM.test(name)) return false;
  for (const ex of EXCHANGE_PREFIXES) {
    if (name.startsWith(ex)) return false;
  }
  return true;
}

/** Why a tokenless protocol is set aside (for the coverage table). */
export function setAsideWhy(p: Proto): string {
  if (p.category !== null && BARRED_CATEGORIES.has(p.category)) {
    return "Excluded category: " + p.category;
  }
  const name = p.name || "";
  if (VERSION_SUFFIX.test(name)) return "Versioned name (a later version)";
  if (WRAPPED_TERM.test(name)) return "Wrapped or staked product";
  for (const ex of EXCHANGE_PREFIXES) {
    if (name.startsWith(ex)) return `Exchange product (${ex})`;
  }
  return "Set aside by the house rule";
}

/** Cap-to-TVL ratios above this are winsorized (one comp on this snapshot). */
export const RATIO_LIMIT = 100;

/**
 * Comparables: traded protocols with a positive cap and positive TVL.
 * Zero or negative caps are data errors and are dropped (counted, and the
 * count is shown on the board); ratios above RATIO_LIMIT are capped.
 */
export function buildComps(
  protocols: Proto[],
): { list: Comp[]; droppedZeroCap: number; winsorized: number } {
  const list: Comp[] = [];
  let droppedZeroCap = 0;
  let winsorized = 0;
  for (const p of protocols) {
    if (p.mcap_usd === null) continue;
    if (p.tvl_usd <= 0) continue;
    if (p.mcap_usd <= 0) {
      droppedZeroCap += 1;
      continue;
    }
    let cap = p.mcap_usd;
    if (cap / p.tvl_usd > RATIO_LIMIT) {
      cap = RATIO_LIMIT * p.tvl_usd;
      winsorized += 1;
    }
    list.push({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Uncategorized",
      tvl: p.tvl_usd,
      mcap: cap,
      listedAt: p.listed_at,
      change7d: p.change_7d,
    });
  }
  return { list, droppedZeroCap, winsorized };
}
