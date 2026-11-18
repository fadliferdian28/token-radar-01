// token-radar-01 v4 — farm economics.
//
// One plan per row, on a fixed 12-week horizon. The maths, per deposit C
// and airdrop share s:
//
//   slice    = min(C / TVL, 0.1%)            the farmer's share of the pool
//   expected = implied value * s * slice    the airdrop, if it launches
//   fees     = 5 tx * gas on the home chain (setup, 2 actions, claim, exit)
//   forgone  = C * 4.32% T-bill * 12/52     what the capital gives up
//   exit     = square-root slippage on selling the drop (15% float,
//              5% daily turnover, k = 0.1 — stated, not observed)
//   net      = expected - fees - forgone - exit
//
// Outcomes: FARM when net clears $5, MARGINAL when net is $0–$5, SKIP
// when net is negative. The break-even deposit is the smallest C with
// net >= $0; some rows never break even, because each extra dollar earns
// less in expected drop than the T-bill yield it gives up — the board
// says so instead of inventing a number.
//
// Gas fix (v4): the snapshot names BSC "Binance", and v3's table keyed
// it "BNB Chain" — so eleven BSC rows were costed at the $2 fallback
// instead of $0.12. The table now uses the snapshot's own chain names,
// and the frequent cheap chains get their own entries.

import type { ValuedRow } from "./curve.ts";

/** Deposits the board prices (USD); the dashboard recomputes live. */
export const DEPOSIT_CHOICES = [100, 1000, 5000, 10000];
export const STANDARD_DEPOSIT = 1000;
/** Airdrop shares of supply the dashboard offers (default 7%). */
export const SHARE_CHOICES = [0.035, 0.07, 0.14];
export const STANDARD_SHARE = 0.07;
/** The plan horizon: twelve weeks, for every row alike. */
export const HORIZON_WEEKS = 12;
export const HORIZON_DAYS = 84;
/** Hours the plan takes: setup 1.5 + weekly 0.5 x 12 + claim 0.5 + exit 0.5. */
export const HOURS_PER_PLAN = 8.5;
/** A farmer's slice of a pool is capped here. */
export const SLICE_MAX = 0.001;
/** Three-month T-bill, 13 Nov 2026: 4.32%. */
export const TBILL_YIELD = 0.0432;
/** A plan is worth doing when its net clears this many dollars. */
export const FARM_THRESHOLD = 5;
/** Exit model: initial float, daily turnover, slippage constant. */
export const LAUNCH_FLOAT = 0.15;
export const TURNOVER_DAILY = 0.05;
export const SLIPPAGE_K = 0.1;
/** Transactions per plan: setup 1 + actions 2 + claim 1 + exit 1. */
export const TX_COUNT = 5;

/** What one transaction typically costs in USD, by chain (mid-November 2026). */
export const TX_COST_USD: Record<string, number> = {
  Ethereum: 10,
  Binance: 0.12,
  "BNB Chain": 0.12,
  Base: 0.05,
  Arbitrum: 0.08,
  Optimism: 0.08,
  Polygon: 0.03,
  Ink: 0.05,
  Solana: 0.003,
  Tron: 0.3,
  Bittensor: 1.0,
  Sui: 0.01,
  "Hyperliquid L1": 0.01,
  Monad: 0.01,
  Stellar: 0.001,
  Flare: 0.02,
  Arc: 0.05,
  Provenance: 0.01,
};
export const TX_COST_DEFAULT = 2;

export type Outcome = "FARM" | "MARGINAL" | "SKIP";

export interface PlanEconomics {
  deposit: number;
  share: number;
  slice: number;
  expected: number;
  fees: number;
  forgone: number;
  exitCost: number;
  net: number;
  perHour: number;
  verdict: Outcome;
}

/** The chain a plan is costed on: the first the snapshot lists. */
export function primaryChain(row: ValuedRow): string {
  return row.chains[0] ?? "Ethereum";
}

export function txCost(chain: string): number {
  return TX_COST_USD[chain] ?? TX_COST_DEFAULT;
}

export function evaluatePlan(
  row: ValuedRow,
  deposit: number,
  share: number,
): PlanEconomics {
  const slice = Math.min(deposit / row.tvl, SLICE_MAX);
  const expected = row.implied * share * slice;
  const fees = TX_COUNT * txCost(primaryChain(row));
  const forgone = deposit * TBILL_YIELD * (HORIZON_DAYS / 365);
  const dailyVolume = LAUNCH_FLOAT * row.implied * TURNOVER_DAILY;
  const slip =
    dailyVolume > 0
      ? SLIPPAGE_K * Math.sqrt(Math.max(0, expected) / dailyVolume)
      : 0;
  const exitCost = Math.min(expected, expected * slip);
  const net = expected - fees - forgone - exitCost;
  const verdict: Outcome =
    net > FARM_THRESHOLD ? "FARM" : net > 0 ? "MARGINAL" : "SKIP";
  return {
    deposit,
    share,
    slice,
    expected,
    fees,
    forgone,
    exitCost,
    net,
    perHour: net / HOURS_PER_PLAN,
    verdict,
  };
}

/**
 * Smallest deposit whose net reaches $0, or null when no deposit does.
 * Net rises with deposit while the slice is uncapped, then falls once
 * the slice caps and the forgone yield keeps growing — so a scan finds
 * the peak, and a bisection on the rising side finds the crossing.
 */
export function findBreakEven(
  row: ValuedRow,
  share: number,
): number | null {
  const netAt = (c: number): number => evaluatePlan(row, c, share).net;
  let peakNet = -Infinity;
  let peakAt = 1;
  for (let c = 1; c <= 1e8; c *= 1.5) {
    const v = netAt(c);
    if (v > peakNet) {
      peakNet = v;
      peakAt = c;
    }
  }
  if (peakNet <= 0) return null;
  let lo = 1;
  let hi = peakAt;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (netAt(mid) < 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function countOutcomes(
  rows: ValuedRow[],
  deposit: number,
  share: number,
): { FARM: number; MARGINAL: number; SKIP: number } {
  const tally = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const row of rows) {
    tally[evaluatePlan(row, deposit, share).verdict] += 1;
  }
  return tally;
}

/* ---- Farm plans: every step carries its COST and its TIME. ---- */

const STEP_ACTIONS: Record<string, string> = {
  "Risk Curators":
    "place the deposit in the curator's vault and hold the vault receipt; the curator allocates it across strategies, so the position follows their decisions",
  Dexs: "supply liquidity to the protocol's deepest pool and leave the LP position open; trading fees build up while it sits there",
  "Onchain Capital Allocator":
    "allocate the deposit through the protocol's on-chain allocator and hold the allocation receipt it returns",
  RWA: "enter the protocol's tokenized real-world-asset offer and hold it until the next redemption window opens",
  Lending:
    "lend an asset into the money market and leave the supply position open; borrowing against it is optional and brings liquidation risk",
  Yield:
    "enter the protocol's largest yield vault and hold the vault share; the yield compounds while the deposit remains",
  Derivatives:
    "take a small hedged position on the derivatives venue, sized so an adverse move cannot liquidate it",
  "Yield Aggregator":
    "enter the aggregator's auto-compounding vault and hold the share while it rotates across strategies",
  "Basis Trading":
    "enter the basis-strategy vault and hold the share through at least one full funding cycle",
  Chain: "use the chain's flagship application with a small deposit and hold whatever position it creates",
  "Staking Pool": "stake through the pool and hold the staking receipt it returns",
  "Liquidity Manager":
    "enter the managed-liquidity vault and hold the share; the manager rebalances the range for you",
  "Leveraged Farming":
    "open a small leveraged farming position at the lowest leverage available; liquidation is a real danger, so keep it small",
  Restaking:
    "restake through the protocol and hold the restaking receipt; the stake secures the services it points to",
  "Anchor BTC":
    "deposit BTC-linked collateral through the protocol and hold the receipt it returns",
  "Decentralized BTC":
    "deposit through the protocol's BTC product and hold the receipt token it issues",
  CeDeFi:
    "deposit through the protocol's custodial yield product and hold the receipt; the yield rests on the custodian's book",
  "Dual-Token Stablecoin":
    "hold the protocol's stable asset and, where offered, stake it in the stability pool",
  Farm: "deposit into the protocol's farm and keep the position staked while rewards accrue",
  "Prediction Market":
    "take a small position on a long-dated market and hold it until it resolves",
  "Stablecoin Wrapper":
    "wrap into the protocol's stable asset and hold the wrapped position",
  "Uncollateralized Lending":
    "supply to the uncollateralized lending pool and keep the supply open for the whole plan",
  "Interest Rate Derivatives":
    "take a small position on the rates market and hold it through at least one full rate period",
  "Cross Chain Bridge":
    "bridge a small amount across and back, keeping both receipts; never leave funds sitting mid-bridge",
  "CDP Manager":
    "deposit collateral through the CDP manager and keep the managed position open through at least one cycle",
  CDP: "lock collateral in the protocol's vault and mint its stable asset against it, staying well clear of the liquidation ratio",
  "OTC Marketplace":
    "complete a small trade on the marketplace and keep the receipt; do one more halfway through the plan",
  Insurance:
    "commit cover capital to the insurance pool and hold the position through the cover period",
  Payments:
    "send a small payment through the protocol and keep the receipt; use it once more mid-plan",
  "Governance Incentives":
    "lock or delegate through the protocol's governance program and keep the position locked for the plan",
  "Crypto Card Issuer":
    "use the protocol's card for ordinary spending and keep the account in good standing",
  Indexes:
    "buy the protocol's index product and hold it; the basket rebalances on its own schedule",
  "Collateral Markets":
    "deposit collateral into the protocol's market and keep the position open for the plan",
};

const STEP_RISKS: Record<string, string> = {
  "Risk Curators":
    "Curator risk: the vault follows the curator's choices, and a bad strategy can lose principal",
  Dexs: "Impermanent loss: a big move in the pool's price ratio can leave a withdrawal worth less than holding the assets",
  "Onchain Capital Allocator":
    "Allocator risk: the capital follows the protocol's on-chain strategy, and a poor strategy can lose it",
  RWA: "Custody risk: the real-world asset sits with a custodian, and redemption depends on them",
  Lending:
    "Liquidation risk: borrowing against collateral can liquidate it on a price move; supplying alone avoids that",
  Yield:
    "Contract risk: the vault's code holds the deposit, and a bug or exploit can lose it",
  Derivatives:
    "Liquidation risk: leveraged positions can be liquidated by a sharp move, so keep leverage low",
  "Yield Aggregator":
    "Strategy risk: the aggregator's vaults depend on the protocols they route into",
  "Basis Trading":
    "Basis risk: the strategy earns the funding spread, which can turn negative",
  Chain: "Contract risk: the chain's applications hold whatever funds are deposited in them",
  "Staking Pool":
    "Depeg risk: in a stressed market the staking receipt can slip below its peg",
  "Liquidity Manager":
    "Manager risk: the vault's rebalancing can trail a static range in a choppy market",
  "Leveraged Farming":
    "Liquidation risk: leverage magnifies losses as well as gains, and a sharp move can wipe the position",
  Restaking:
    "Slashing risk: the restaked position can be slashed if a secured service misbehaves",
  "Anchor BTC":
    "Custody risk: the BTC-linked collateral depends on its custodian and bridge",
  "Decentralized BTC":
    "Bridge risk: the BTC product depends on the bridge or custodian holding the underlying",
  CeDeFi:
    "Custody risk: the deposit sits with a custodian, so both yield and principal depend on them",
  "Dual-Token Stablecoin":
    "Depeg risk: the stable asset can lose its peg if its mechanism breaks under stress",
  Farm: "Contract risk: the farm's contracts hold the deposit, and a bug or exploit can lose it",
  "Prediction Market":
    "Resolution risk: the market settles on its oracle's answer, which may differ from your reading",
  "Stablecoin Wrapper":
    "Wrapper risk: the wrapped asset depends on the reserves backing it",
  "Uncollateralized Lending":
    "Default risk: the loans carry no collateral, so a borrower default hits the pool directly",
  "Interest Rate Derivatives":
    "Rates risk: a sharp move in rates can cut the position's value before the period ends",
  "Cross Chain Bridge":
    "Bridge risk: while funds are in transit they depend on the bridge's validators and contracts",
  "CDP Manager":
    "Manager risk: the managed CDP follows the manager's ratio policy, which can still liquidate in a crash",
  CDP: "Liquidation risk: if the collateral price falls toward the liquidation ratio, the vault can be liquidated",
  "OTC Marketplace":
    "Counterparty risk: each trade settles against the other side, so keep trades small",
  Insurance:
    "Cover risk: the pool pays claims from its capital, so a large claim event can shrink your share",
  Payments:
    "Contract risk: the protocol's contracts hold funds while a payment settles",
  "Governance Incentives":
    "Lock risk: the position is locked, so it cannot be exited early if the protocol turns",
  "Crypto Card Issuer":
    "Issuer risk: the card program depends on the issuer staying solvent and licensed",
  Indexes:
    "Basket risk: the index follows its basket, so a weak component drags the whole product",
  "Collateral Markets":
    "Liquidation risk: a price move against the collateral can liquidate the position",
};

function fmtDollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1e3).toFixed(1)}k`;
  if (n >= 1) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Eight farm steps for one row, each 20–600 characters, each carrying
 * its COST and its TIME. The steps are composed from the row's own
 * category, chain, TVL and age, so no two rows share an identical plan.
 */
export function buildFarmPlan(row: ValuedRow, deposit: number): string[] {
  const chain = primaryChain(row);
  const gas = txCost(chain);
  const action =
    STEP_ACTIONS[row.category] ??
    `put ${fmtDollars(deposit)} to work in the protocol's main product on ${chain} and hold the position it issues`;
  const risk =
    STEP_RISKS[row.category] ??
    "Contract risk: the protocol's contracts hold the deposit, and a bug or exploit can lose it";
  const ageNote =
    row.ageDays === null
      ? "no listing date is recorded for it, so the plan uses the fixed twelve-week hold"
      : `it has operated ${row.ageDays} days without a recorded token`;
  return [
    `Set up a dedicated wallet for this farm and load it with ${fmtDollars(deposit)} on ${chain}; write the recovery phrase on paper and store it away from the computer. COST roughly ${fmtDollars(gas)} to fund it. TIME 20 minutes.`,
    `Put ${fmtDollars(deposit)} into ${row.name} on ${chain}: ${action}. COST roughly ${fmtDollars(gas)} in network fees. TIME 15 minutes.`,
    `Leave the position untouched for the whole ${HORIZON_WEEKS}-week plan (${HORIZON_DAYS} days): ${ageNote}. COST $0 while it sits. TIME 30 minutes a week to check on it.`,
    `Look in once a week (${HORIZON_WEEKS} check-ins): make sure the position is still open and the protocol still lists it as active; re-enter only if it lapsed. COST $0 — checking costs nothing. TIME 30 minutes each.`,
    `At week ${HORIZON_WEEKS / 2}, take stock: if ${row.name}'s TVL has dropped by half or its team has stopped posting, leave early instead of riding out the plan. COST $0. TIME 30 minutes.`,
    `Know the risk — ${risk}. Only farm with money you can afford to lose outright, and never borrow to do it. COST $0. TIME 10 minutes reading the protocol's own documentation.`,
    `If ${row.name} launches a token, claim it only from the protocol's own announced page; never pay a fee to claim, and never follow a link from a direct message or an advertisement. COST roughly ${fmtDollars(gas)} in network fees. TIME 20 minutes.`,
    `When you leave, unwind in two halves: exit half the position, wait a day, then exit the rest, so a thin new market does not move against the sale. COST roughly ${fmtDollars(gas * 2)} in network fees. TIME 30 minutes.`,
  ];
}
