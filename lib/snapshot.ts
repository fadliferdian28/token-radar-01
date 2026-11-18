// token-radar-01 v4 — snapshot layer.
//
// Everything the entry knows about a protocol comes from the sealed
// snapshot's ten fields. This module classifies protocols (token recorded
// or not, board-eligible or set aside, comparable or not) without naming
// any protocol: every split is a rule over the snapshot's own fields.

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

/** A traded token the size curve can learn from. */
export interface Comparable {
  slug: string;
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  listedAt: string | null;
  change7d: number | null;
}

const DAY_MS = 86_400_000;

/** Whole days from one UTC date (YYYY-MM-DD) to another, never negative. */
export function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/** A protocol's age in days at the snapshot date, null when unlisted. */
export function protocolAge(p: Protocol, asOf: string): number | null {
  return p.listed_at === null ? null : daysBetween(p.listed_at, asOf);
}

/** Median of a list (0 when empty). */
export function medianOf(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  const half = Math.floor(n / 2);
  return n % 2 === 1 ? ordered[half] : (ordered[half - 1] + ordered[half]) / 2;
}

/** A protocol records a token when any of its three token fields is set. */
export function hasTokenRecord(p: Protocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** Category label used everywhere (null becomes "Uncategorized"). */
export function categoryOf(p: Protocol): string {
  return p.category === null ? "Uncategorized" : p.category;
}

/* ---- The house rule, from the snapshot's README ----
 * These are the snapshot author's own exclusions for what counts as a
 * distinct pre-token protocol (bridges, liquid staking, CEX products,
 * versioned and wrapped names). The rule is applied exactly as written
 * here and nowhere else, so the coverage table can never disagree with
 * the board. */

const HOUSE_RULE = {
  barredCategories: new Set([
    "Bridge",
    "Canonical Bridge",
    "Liquid Staking",
    "Liquid Restaking",
    "Restaked BTC",
    "CEX",
    "Centralized Exchange",
  ]),
  exchangePrefixes: [
    "Binance",
    "Coinbase",
    "Bybit",
    "Kraken",
    "Bitget",
    "OKX",
    "Bitfinex",
    "Gemini",
  ],
  // A trailing version marker: a space, then V3, v2, 2.0, and the like.
  versionSuffix: /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/,
  wrappedWord: /\b(wrapped|staked|staking)\b/i,
};

/**
 * Why a tokenless protocol is NOT board-eligible, or null when it is.
 * One function serves both the eligibility test and the coverage table,
 * so the two can never disagree.
 */
export function exclusionReason(p: Protocol): string | null {
  if (hasTokenRecord(p)) return null; // traded protocols are not "set aside"
  if (p.category !== null && HOUSE_RULE.barredCategories.has(p.category)) {
    return "Excluded category: " + p.category;
  }
  const name = p.name || "";
  if (HOUSE_RULE.versionSuffix.test(name)) {
    return "Versioned name (a later version)";
  }
  if (HOUSE_RULE.wrappedWord.test(name)) {
    return "Wrapped or staked product";
  }
  for (const ex of HOUSE_RULE.exchangePrefixes) {
    if (name.startsWith(ex)) return `Exchange product (${ex})`;
  }
  return null;
}

/** Board-eligible: records no token and the house rule keeps it. */
export function isBoardEligible(p: Protocol): boolean {
  return !hasTokenRecord(p) && exclusionReason(p) === null;
}

/** Cap-to-TVL ratios above this are winsorized (one comp on this snapshot). */
export const RATIO_CAP = 100;

/**
 * Comparables: traded protocols with a positive cap on a positive TVL.
 * Zero or negative caps are data errors — dropped and counted, never
 * silently kept. Ratios above RATIO_CAP are capped at it, and counted.
 */
export function collectComparables(protocols: Protocol[]): {
  list: Comparable[];
  droppedZeroCap: number;
  winsorized: number;
} {
  const list: Comparable[] = [];
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
    if (cap / p.tvl_usd > RATIO_CAP) {
      cap = RATIO_CAP * p.tvl_usd;
      winsorized += 1;
    }
    list.push({
      slug: p.slug,
      name: p.name,
      category: categoryOf(p),
      tvl: p.tvl_usd,
      mcap: cap,
      listedAt: p.listed_at,
      change7d: p.change_7d,
    });
  }
  return { list, droppedZeroCap, winsorized };
}
