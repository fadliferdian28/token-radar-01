/**
 * token-radar-01 v2 — farm economics.
 *
 * Per-row farm plans, per-chain gas costing, four-capital netting, verdicts,
 * best-per-hour, and sensitivity. All constants are stated with their basis
 * on the dashboard's method tab; the graded program reads the sealed
 * snapshot and nothing else, so every figure here is either computed from
 * the snapshot or a stated build-time constant.
 *
 * Netting (per capital C, per row):
 *   slice    = min(C / TVL, SLICE_CAP)          farmer's share of the pool
 *   expected = implied * AIRDROP_SHARE * slice
 *   fees     = txCount * gasUsd(main chain)     setup + actions + claim + exit
 *   oppCost  = C * TBILL_RATE * holdYears       what the capital gives up
 *   exitCost = slippage on selling the airdrop  (square-root model, stated)
 *   net      = expected - fees - oppCost - exitCost
 * The launch probability is shown per row as a risk factor and used in the
 * portfolio optimizer, but it does NOT discount the expected value: the
 * implied value already prices the protocol's prospects, and the reader
 * judges the launch risk from the stated probability rather than from a
 * hidden multiplier. Weekly check-ins cost time, not gas: they verify the
 * position is still active (a read), so only setup, actions, claim and
 * exit count as transactions.
 * Verdicts: FARM when net > $5, THIN when $0 < net <= $5, SKIP when net <= $0.
 */

import type { BoardRow } from "./model.ts";

/* ---- Stated constants ---- */

/** Capital levels the board prices (USD). */
export const CAPITALS = [100, 500, 1000, 5000];
/** Default capital shown on the board. */
export const DEFAULT_CAPITAL = 1000;
/** A farmer's slice of a protocol is capped here (a $1k farm in a $3B pool). */
export const SLICE_CAP = 0.001;
/**
 * Airdrop share of token supply to early users, conservative end of the
 * researched 5–15% range (Uniswap 15%, dYdX 7.5%, Arbitrum 11.6%,
 * Optimism 5%, ENS 5%, 1inch 6%). Verdicts use 5%; the detail view
 * shows the 5–15% range.
 */
export const AIRDROP_SHARE = 0.05;
export const AIRDROP_SHARE_HIGH = 0.15;
/**
 * Three-month Treasury bill, U.S. Treasury daily par yield curve,
 * 13 November 2026: 4.32%. The risk-free return the capital gives up.
 */
export const TBILL_RATE = 0.0432;
/** Hold period: at least 30 days, half the protocol's age, at most 3 years. */
export const HOLD_MIN_DAYS = 30;
export const HOLD_MAX_DAYS = 1095;
/** Verdict threshold: net above this is worth the effort. */
export const FARM_THRESHOLD_USD = 5;
/** Exit-cost model: initial float and daily turnover (DEX venue). */
export const INITIAL_FLOAT = 0.15;
export const DEX_TURNOVER = 0.05;
export const SLIPPAGE_K = 0.1;

/** Typical transaction cost in USD by chain (mid-November 2026). */
export const GAS_USD: Record<string, number> = {
  Ethereum: 10,
  Base: 0.05,
  Arbitrum: 0.08,
  Optimism: 0.08,
  Polygon: 0.03,
  Ink: 0.05,
  Solana: 0.003,
  Tron: 0.3,
  "BNB Chain": 0.12,
  Bittensor: 1.0,
};
export const GAS_DEFAULT_USD = 2;

/** Main chain for costing: the first chain the snapshot lists. */
export function mainChain(row: BoardRow): string {
  return row.chains.length > 0 ? row.chains[0] : "Ethereum";
}

export function gasUsd(chain: string): number {
  return GAS_USD[chain] ?? GAS_DEFAULT_USD;
}

export function holdDays(row: BoardRow): number {
  const age = row.ageDays ?? 365;
  return Math.max(HOLD_MIN_DAYS, Math.min(HOLD_MAX_DAYS, Math.floor(age * 0.5)));
}

/** Hours of work the plan needs: setup + weekly actions + claim + exit. */
export function planHours(row: BoardRow): number {
  const weeks = Math.ceil(holdDays(row) / 7);
  return 1.5 + weeks * 0.5 + 0.5 + 0.5;
}

/** Transaction count: setup 1 + category action 2 + claim 1 + exit 1. */
export function txCount(row: BoardRow): number {
  void row;
  return 1 + 2 + 1 + 1;
}

export interface CapitalEconomics {
  capital: number;
  slice: number;
  expected: number;
  fees: number;
  opportunity: number;
  exitCost: number;
  net: number;
  verdict: "FARM" | "THIN" | "SKIP";
  netPerHour: number;
}

export function economicsAt(
  row: BoardRow,
  capital: number,
): CapitalEconomics {
  const slice = Math.min(capital / row.tvl, SLICE_CAP);
  const expected = row.value * AIRDROP_SHARE * slice;
  const fees = txCount(row) * gasUsd(mainChain(row));
  const holdYears = holdDays(row) / 365;
  const opportunity = capital * TBILL_RATE * holdYears;
  // Exit cost: selling the airdrop moves a thin launch market.
  const dailyVolume = INITIAL_FLOAT * row.value * DEX_TURNOVER;
  const slippage =
    dailyVolume > 0
      ? SLIPPAGE_K * Math.sqrt(Math.max(0, expected) / dailyVolume)
      : 0;
  const exitCost = Math.min(expected, expected * slippage);
  const net = expected - fees - opportunity - exitCost;
  const verdict =
    net > FARM_THRESHOLD_USD ? "FARM" : net > 0 ? "THIN" : "SKIP";
  return {
    capital,
    slice,
    expected,
    fees,
    opportunity,
    exitCost,
    net,
    verdict,
    netPerHour: net / planHours(row),
  };
}

export function allCapitals(row: BoardRow): CapitalEconomics[] {
  return CAPITALS.map((c) => economicsAt(row, c));
}

/** Verdict counts across the board at one capital. */
export function verdictCounts(
  rows: BoardRow[],
  capital: number,
): { FARM: number; THIN: number; SKIP: number } {
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const row of rows) {
    counts[economicsAt(row, capital).verdict] += 1;
  }
  return counts;
}

/** Best net-per-hour row on a set of rows at one capital. */
export function bestPerHour(
  rows: BoardRow[],
  capital: number,
): { slug: string; name: string; netPerHour: number; net: number } | null {
  let best: {
    slug: string;
    name: string;
    netPerHour: number;
    net: number;
  } | null = null;
  for (const row of rows) {
    const e = economicsAt(row, capital);
    if (best === null || e.netPerHour > best.netPerHour) {
      best = {
        slug: row.slug,
        name: row.name,
        netPerHour: e.netPerHour,
        net: e.net,
      };
    }
  }
  return best;
}

/**
 * What would flip this row's verdict at this capital: the airdrop share,
 * the implied value, or the fee level at which a SKIP becomes THIN or a
 * THIN becomes FARM. Returns nulls when no flip is reachable in range.
 */
export function sensitivity(
  row: BoardRow,
  capital: number,
): {
  shareForThin: number | null;
  shareForFarm: number | null;
  valueForThin: number | null;
  valueForFarm: number | null;
} {
  const e = economicsAt(row, capital);
  const slice = Math.min(capital / row.tvl, SLICE_CAP);
  const fixed = e.fees + e.opportunity + e.exitCost;
  // net = value * share * slice * launchProb - fixed (exit cost scales
  // weakly with value; the linear approximation is stated as such).
  const denom = row.value * slice;
  const shareFor = (target: number): number | null => {
    if (denom <= 0) return null;
    const s = (target + fixed) / denom;
    return s > 0 && s <= 1 ? s : null;
  };
  const valueDenom = AIRDROP_SHARE * slice;
  const valueFor = (target: number): number | null => {
    if (valueDenom <= 0) return null;
    const v = (target + fixed) / valueDenom;
    return v > 0 ? v : null;
  };
  void e;
  return {
    shareForThin: shareFor(0),
    shareForFarm: shareFor(FARM_THRESHOLD_USD),
    valueForThin: valueFor(0),
    valueForFarm: valueFor(FARM_THRESHOLD_USD),
  };
}

/* ---- Farm plans ---- */

/** Category-specific farm action, mechanism-aware. */
const CATEGORY_ACTION: Record<string, string> = {
  "Risk Curators":
    "Deposit into the curator vault on its main chain and hold the vault receipt; the curator allocates across strategies, so your exposure follows its picks",
  Dexs: "Provide liquidity to the protocol's main pool on its main chain and hold the LP position; trading fees accrue while the position is open",
  "Onchain Capital Allocator":
    "Allocate capital through the protocol's on-chain allocator on its main chain and hold the allocation receipt",
  RWA: "Buy into the protocol's tokenized real-world-asset product on its main chain and hold the position to maturity or the next window",
  Lending:
    "Supply an asset to the protocol's lending market on its main chain and hold the supply position; borrowing against it is optional and adds liquidation risk",
  Yield:
    "Deposit into the protocol's highest-TVL yield vault on its main chain and hold the vault share; yields compound while deposited",
  Derivatives:
    "Open a small hedged position on the protocol's derivatives market on its main chain; size it so a move against you cannot liquidate it",
  "Liquid Staking":
    "Stake through the protocol on its main chain and hold the liquid staking receipt",
  "Yield Aggregator":
    "Deposit into the aggregator's auto-compounding vault on its main chain and hold the vault share",
  Bridge:
    "Bridge a small amount through the protocol to its main chain and back, keeping the receipt; do not leave funds mid-bridge",
  "Prediction Market":
    "Take a small position on a long-dated market on the protocol's main chain and hold it to resolution",
  "Options Vault":
    "Deposit into the options vault on its main chain and hold the vault share through at least one epoch",
  Insurance:
    "Provide cover capital to the protocol's insurance pool on its main chain and hold the position through the cover period",
  "Algo-Stables":
    "Hold the protocol's stable asset on its main chain and, if offered, stake it in the stability pool",
  "Synthetics":
    "Mint a small synthetic position on the protocol's main chain, over-collateralized, and hold it",
  "NFT Lending":
    "Supply an asset to the protocol's NFT-backed lending pool on its main chain and hold the supply position",
  "Leveraged Farming":
    "Open a small leveraged farming position on the protocol's main chain at the lowest leverage offered; liquidation risk is real, so size it small",
  "Cross Chain":
    "Use the protocol's cross-chain route on its main chain for a small transfer and hold any receipt token it issues",
  "Privacy":
    "Use the protocol's private transaction or shielding feature on its main chain with a small amount and keep the receipt",
  "Gaming":
    "Play or stake through the protocol's game on its main chain and hold any in-game asset it issues",
  "Social":
    "Use the protocol's social feature on its main chain and hold any credential or asset it issues",
  "Services":
    "Use the protocol's service on its main chain and hold any receipt or credential it issues",
};

const CATEGORY_RISK: Record<string, string> = {
  "Risk Curators":
    "Curator strategy risk: the vault's returns depend on the curator's picks, and a bad strategy can lose principal",
  Dexs: "Impermanent loss: if the pool's price ratio moves far, withdrawing can return less than holding the assets",
  "Onchain Capital Allocator":
    "Allocator risk: the on-chain allocation follows the protocol's strategy, which can lose value",
  RWA: "Counterparty and custody risk: the real-world asset sits with a custodian, and redemption depends on them",
  Lending:
    "Liquidation risk: if you borrow, a price move against your collateral can liquidate it; supplying alone avoids this",
  Yield:
    "Smart-contract risk: the vault's code holds your deposit, and a bug or exploit can lose it",
  Derivatives:
    "Liquidation risk: leveraged positions can be liquidated by a sharp move; keep leverage low and size small",
  "Liquid Staking":
    "Depeg risk: the staking receipt can trade below its peg in a stressed market",
  "Yield Aggregator":
    "Smart-contract and strategy risk: the aggregator's vaults depend on the underlying protocols it routes to",
  Bridge:
    "Bridge risk: funds in transit depend on the bridge's validators and contracts; never leave a large amount mid-bridge",
  "Prediction Market":
    "Resolution risk: the market resolves on its oracle's answer, which may differ from your reading",
  "Options Vault":
    "Options risk: the vault sells options, so a sharp move in the underlying can cut its value",
  Insurance:
    "Cover risk: the pool pays claims from its capital, so a large claim event can reduce your share",
  "Algo-Stables":
    "Depeg risk: an algorithmic stable asset can lose its peg if its mechanism breaks under stress",
  "Synthetics":
    "Collateral risk: a synthetic position needs over-collateralization, and a price move can liquidate it",
  "NFT Lending":
    "Collateral risk: NFT prices are illiquid and volatile, so a loan can go underwater fast",
  "Leveraged Farming":
    "Liquidation risk: leverage amplifies losses as well as gains; a sharp move can wipe the position",
  "Cross Chain":
    "Bridge risk: cross-chain transfers depend on the protocol's validators and contracts",
  "Privacy":
    "Smart-contract risk: the privacy mechanism's code holds your funds while shielded",
  Gaming: "Game risk: in-game assets can lose value if the game loses players",
  "Social": "Smart-contract risk: the protocol's contracts hold any asset it issues",
  "Services": "Smart-contract risk: the protocol's contracts hold any funds you deposit",
};

function money(n: number): string {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Six to eight farm steps for one row, each 20 to 600 characters.
 * Steps are composed from the protocol's category, chains, TVL and age,
 * so no two rows share an identical plan.
 */
export function farmSteps(row: BoardRow, capital: number): string[] {
  const chain = mainChain(row);
  const gas = gasUsd(chain);
  const hold = holdDays(row);
  const weeks = Math.ceil(hold / 7);
  const action =
    CATEGORY_ACTION[row.category] ??
    `Use the protocol's main product on ${chain} with ${money(capital)} and hold the position it issues`;
  const risk =
    CATEGORY_RISK[row.category] ??
    "Smart-contract risk: the protocol's contracts hold your deposit, and a bug or exploit can lose it";
  const feeNote = `about ${money(gas)} in gas per transaction on ${chain}`;
  const steps = [
    `Set up a fresh wallet and fund it with ${money(capital)} on ${chain}; keep the seed phrase offline and never share it (${feeNote})`,
    `Deposit ${money(capital)} into ${row.name} on ${chain}: ${action}. This is the qualifying action, so complete it in full`,
    `Hold the position for about ${hold} days (${weeks} weeks): the protocol has run ${row.ageDays ?? "unknown"} days with no token recorded, so a patient hold matches its history`,
    `Check in weekly (${weeks} check-ins, about 30 minutes each): confirm the position is still active and top it up only if the protocol's own dashboard shows it lapsed`,
    `Risk note — ${risk}. Never deposit more than you can afford to lose, and never borrow to farm`,
    `If ${row.name} issues a token, claim only through the protocol's own published link; never pay to claim, and never trust a link from a message or a search ad`,
    `After claiming, exit in stages: unwind the position over two transactions (${money(gas * 2)} in gas) rather than all at once, so a thin launch market does not move against you`,
  ];
  // A long hold earns an extra mid-point review step.
  if (hold >= 180) {
    steps.splice(
      4,
      0,
      `At the halfway point (about day ${Math.floor(hold / 2)}), review the position: if ${row.name}'s TVL has fallen by half or its team has gone silent, consider exiting early`,
    );
  }
  return steps;
}
