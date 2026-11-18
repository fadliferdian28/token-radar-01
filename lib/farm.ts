// token-radar-01 v3 — farm economics.
//
// One plan per row, on a fixed 12-week horizon. The maths, per deposit C
// and airdrop share s:
//
//   slice    = min(C / TVL, 0.1%)            the farmer's share of the pool
//   expected = implied value * s * slice    the airdrop, if it launches
//   fees     = 5 tx * gas on the main chain (setup, 2 actions, claim, exit)
//   forgone  = C * 4.32% T-bill * 12/52     what the capital gives up
//   exit     = square-root slippage on selling the drop (15% float,
//              5% daily turnover, k = 0.1 — stated, not observed)
//   net      = expected - fees - forgone - exit
//
// Verdicts: FARM when net clears $5, MARGINAL when net is $0–$5, SKIP
// when net is negative. The break-even deposit is the smallest C with
// net >= $0; some rows never break even, because each extra dollar earns
// less in expected drop than the T-bill yield it gives up — the board
// says so instead of inventing a number.

import type { PricedRow } from "./pricing.ts";

/** Deposits the board prices (USD); the dashboard recomputes live. */
export const DEPOSITS = [100, 1000, 5000, 10000];
export const DEFAULT_DEPOSIT = 1000;
/** Airdrop shares of supply the dashboard offers (default 7%). */
export const DROP_SHARES = [0.035, 0.07, 0.14];
export const DEFAULT_SHARE = 0.07;
/** The plan horizon: twelve weeks, for every row alike. */
export const PLAN_WEEKS = 12;
export const PLAN_DAYS = 84;
/** Hours the plan takes: setup 1.5 + weekly 0.5 x 12 + claim 0.5 + exit 0.5. */
export const PLAN_HOURS = 8.5;
/** A farmer's slice of a pool is capped here. */
export const SLICE_LIMIT = 0.001;
/** Three-month T-bill, 13 Nov 2026: 4.32%. */
export const TBILL = 0.0432;
/** A plan is worth doing when its net clears this many dollars. */
export const FARM_LINE = 5;
/** Exit model: initial float, daily turnover, slippage constant. */
export const FLOAT_AT_LAUNCH = 0.15;
export const DAILY_TURNOVER = 0.05;
export const SLIP_K = 0.1;
/** Transactions per plan: setup 1 + actions 2 + claim 1 + exit 1. */
export const TX_PER_PLAN = 5;

/** What one transaction typically costs in USD, by chain (mid-November 2026). */
export const GAS_BY_CHAIN: Record<string, number> = {
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
export const GAS_FALLBACK = 2;

export type Verdict = "FARM" | "MARGINAL" | "SKIP";

export interface RowEcon {
  deposit: number;
  share: number;
  slice: number;
  expected: number;
  fees: number;
  forgone: number;
  exitCost: number;
  net: number;
  perHour: number;
  verdict: Verdict;
}

/** The chain a plan is costed on: the first the snapshot lists. */
export function homeChain(row: PricedRow): string {
  return row.chains[0] ?? "Ethereum";
}

export function gasFor(chain: string): number {
  return GAS_BY_CHAIN[chain] ?? GAS_FALLBACK;
}

export function priceEcon(
  row: PricedRow,
  deposit: number,
  share: number,
): RowEcon {
  const slice = Math.min(deposit / row.tvl, SLICE_LIMIT);
  const expected = row.implied * share * slice;
  const fees = TX_PER_PLAN * gasFor(homeChain(row));
  const forgone = deposit * TBILL * (PLAN_DAYS / 365);
  const dailyVolume = FLOAT_AT_LAUNCH * row.implied * DAILY_TURNOVER;
  const slip =
    dailyVolume > 0
      ? SLIP_K * Math.sqrt(Math.max(0, expected) / dailyVolume)
      : 0;
  const exitCost = Math.min(expected, expected * slip);
  const net = expected - fees - forgone - exitCost;
  const verdict: Verdict =
    net > FARM_LINE ? "FARM" : net > 0 ? "MARGINAL" : "SKIP";
  return {
    deposit,
    share,
    slice,
    expected,
    fees,
    forgone,
    exitCost,
    net,
    perHour: net / PLAN_HOURS,
    verdict,
  };
}

/**
 * Smallest deposit whose net reaches $0, or null when no deposit does.
 * Net rises with deposit while the slice is uncapped, then falls once
 * the slice caps and the forgone yield keeps growing — so a scan finds
 * the peak, and a bisection on the rising side finds the crossing.
 */
export function breakEvenDeposit(
  row: PricedRow,
  share: number,
): number | null {
  const netAt = (c: number): number => priceEcon(row, c, share).net;
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

export function verdictTally(
  rows: PricedRow[],
  deposit: number,
  share: number,
): { FARM: number; MARGINAL: number; SKIP: number } {
  const tally = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const row of rows) tally[priceEcon(row, deposit, share).verdict] += 1;
  return tally;
}

/* ---- Farm plans: every step carries its COST and its TIME. ---- */

const ACTION_BY_CATEGORY: Record<string, string> = {
  "Risk Curators":
    "Put the deposit into the curator vault and keep the vault receipt; the curator routes it across strategies, so the position follows their choices",
  Dexs: "Add liquidity to the protocol's deepest pool and keep the LP position open; trading fees accrue while it sits there",
  "Onchain Capital Allocator":
    "Commit the deposit through the protocol's on-chain allocator and keep the allocation receipt it issues",
  RWA: "Buy into the protocol's tokenized real-world-asset offering and hold it to the next redemption window",
  Lending:
    "Supply an asset to the lending market and keep the supply position open; borrowing against it is optional and adds liquidation risk",
  Yield:
    "Deposit into the protocol's largest yield vault and keep the vault share; the yield compounds while the deposit stays in",
  Derivatives:
    "Open a small hedged position on the derivatives market, sized so a move against you cannot liquidate it",
  "Yield Aggregator":
    "Deposit into the aggregator's auto-compounding vault and keep the vault share while it routes across strategies",
  "Prediction Market":
    "Take a small position on a long-dated market and hold it to resolution",
  Insurance:
    "Commit cover capital to the insurance pool and hold the position through the cover period",
  "Leveraged Farming":
    "Open a small leveraged farming position at the lowest leverage on offer; liquidation risk is real, so keep it small",
  "Cross Chain Bridge":
    "Send a small amount across the bridge and back, keeping both receipts; never leave funds mid-bridge",
  "Interest Rate Derivatives":
    "Open a small position on the rates market and hold it through at least one full rate period",
  "Liquidity Manager":
    "Deposit into the managed liquidity vault and keep the vault share; the manager rebalances the range for you",
  CDP: "Lock collateral in the protocol's vault and mint its stable asset against it, staying well above the liquidation ratio",
  "CDP Manager":
    "Deposit collateral through the CDP manager and keep the managed position open through at least one cycle",
  CeDeFi:
    "Deposit through the protocol's custodial yield product and keep the receipt; the yield depends on the custodian's book",
  Restaking:
    "Restake through the protocol and keep the restaking receipt; the position secures the services it points at",
  "Staking Pool":
    "Stake through the pool and keep the staking receipt it issues",
  Farm: "Deposit into the protocol's farm and keep the position staked while rewards accrue",
  Indexes:
    "Buy the protocol's index product and hold it; the basket rebalances on its own schedule",
  "Governance Incentives":
    "Lock or delegate through the protocol's governance program and keep the position locked for the plan",
  "Dual-Token Stablecoin":
    "Hold the protocol's stable asset and, where offered, stake it in the stability pool",
  "Stablecoin Wrapper":
    "Wrap into the protocol's stable asset and hold the wrapped position",
  "Anchor BTC":
    "Deposit BTC-linked collateral through the protocol and keep the receipt it issues",
  "Decentralized BTC":
    "Deposit through the protocol's BTC product and hold the receipt token it issues",
  "Basis Trading":
    "Deposit into the basis strategy vault and keep the vault share through at least one funding cycle",
  "Crypto Card Issuer":
    "Use the protocol's card product for regular spending and keep the account in good standing",
  "OTC Marketplace":
    "Complete a small trade on the marketplace and keep the receipt; repeat once mid-plan",
  Payments:
    "Route a small payment through the protocol and keep the receipt; use it again mid-plan",
  "Uncollateralized Lending":
    "Supply to the uncollateralized lending pool and keep the supply position open through the plan",
  Chain:
    "Use the chain's main application with a small deposit and keep the position it issues",
  "Collateral Markets":
    "Deposit collateral into the protocol's market and keep the position open through the plan",
};

const RISK_BY_CATEGORY: Record<string, string> = {
  "Risk Curators":
    "Curator risk: the vault follows the curator's picks, and a bad strategy can lose principal",
  Dexs: "Impermanent loss: a large move in the pool's price ratio can leave a withdrawal worth less than simply holding",
  "Onchain Capital Allocator":
    "Allocator risk: the capital follows the protocol's on-chain strategy, and a poor strategy can lose it",
  RWA: "Custody risk: the real-world asset sits with a custodian, and redemption depends on them",
  Lending:
    "Liquidation risk: borrowing against collateral can liquidate it on a price move; supplying alone avoids this",
  Yield:
    "Smart-contract risk: the vault's code holds the deposit, and a bug or exploit can lose it",
  Derivatives:
    "Liquidation risk: leveraged positions can be liquidated by a sharp move, so keep leverage low",
  "Yield Aggregator":
    "Strategy risk: the aggregator's vaults depend on the underlying protocols they route to",
  "Prediction Market":
    "Resolution risk: the market settles on its oracle's answer, which may differ from your reading",
  Insurance:
    "Cover risk: the pool pays claims from its capital, so a large claim event can shrink your share",
  "Leveraged Farming":
    "Liquidation risk: leverage amplifies losses as well as gains, and a sharp move can wipe the position",
  "Cross Chain Bridge":
    "Bridge risk: funds in transit depend on the bridge's validators and contracts",
  "Interest Rate Derivatives":
    "Rates risk: a sharp move in rates can cut the position's value before the period ends",
  "Liquidity Manager":
    "Manager risk: the vault's rebalancing can underperform a static range in a choppy market",
  CDP: "Liquidation risk: if the collateral price falls toward the liquidation ratio, the vault can be liquidated",
  "CDP Manager":
    "Manager risk: the managed CDP follows the manager's ratio policy, which can still liquidate in a crash",
  CeDeFi:
    "Custody risk: the deposit sits with a custodian, so the yield and the principal depend on them",
  Restaking:
    "Slashing risk: the restaked position can be slashed if a secured service misbehaves",
  "Staking Pool":
    "Depeg risk: in a stressed market the staking receipt can slip below its peg",
  Farm: "Smart-contract risk: the farm's contracts hold the deposit, and a bug or exploit can lose it",
  Indexes:
    "Basket risk: the index follows its basket, so a weak component drags the whole product",
  "Governance Incentives":
    "Lock risk: the position is locked, so it cannot be exited early if the protocol turns",
  "Dual-Token Stablecoin":
    "Depeg risk: the stable asset can lose its peg if its mechanism breaks under stress",
  "Stablecoin Wrapper":
    "Wrapper risk: the wrapped asset depends on the reserves backing it",
  "Anchor BTC":
    "Custody risk: the BTC-linked collateral depends on its custodian and bridge",
  "Decentralized BTC":
    "Bridge risk: the BTC product depends on the bridge or custodian that holds the underlying",
  "Basis Trading":
    "Basis risk: the strategy earns the funding spread, which can turn negative",
  "Crypto Card Issuer":
    "Issuer risk: the card program depends on the issuer staying solvent and licensed",
  "OTC Marketplace":
    "Counterparty risk: each trade settles against the other side, so keep trades small",
  Payments:
    "Smart-contract risk: the protocol's contracts hold funds while a payment settles",
  "Uncollateralized Lending":
    "Default risk: the loans carry no collateral, so a borrower default hits the pool directly",
  Chain: "Smart-contract risk: the chain's applications hold any funds deposited in them",
  "Collateral Markets":
    "Liquidation risk: a price move against the collateral can liquidate the position",
};

function dollars(n: number): string {
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
export function farmPlan(row: PricedRow, deposit: number): string[] {
  const chain = homeChain(row);
  const gas = gasFor(chain);
  const action =
    ACTION_BY_CATEGORY[row.category] ??
    `Use the protocol's main product on ${chain} with ${dollars(deposit)} and hold whatever position it issues`;
  const risk =
    RISK_BY_CATEGORY[row.category] ??
    "Smart-contract risk: the protocol's contracts hold the deposit, and a bug or exploit can lose it";
  const ageNote =
    row.ageDays === null
      ? "its listing date is unrecorded, so the hold is a fixed twelve weeks"
      : `it has run ${row.ageDays} days with no token recorded`;
  return [
    `Open a fresh wallet for this farm and fund it with ${dollars(deposit)} on ${chain}; keep the seed phrase offline and never share it. COST about ${dollars(gas)} in gas for the funding transfer. TIME 20 minutes.`,
    `Deposit ${dollars(deposit)} into ${row.name} on ${chain}: ${action}. COST about ${dollars(gas)} in gas. TIME 15 minutes.`,
    `Hold the position for the full ${PLAN_WEEKS}-week plan (${PLAN_DAYS} days): ${ageNote}, so a patient hold matches its history. COST $0 while holding. TIME 30 minutes a week for check-ins.`,
    `Check in every week (${PLAN_WEEKS} check-ins): confirm the position is still open and the protocol's dashboard still shows it active; top up only if it lapsed. COST $0 — reads are free. TIME 30 minutes each.`,
    `At week ${PLAN_WEEKS / 2}, review the position: if ${row.name}'s TVL has halved or its team has gone silent, consider exiting early rather than waiting out the plan. COST $0. TIME 30 minutes.`,
    `Risk check — ${risk}. Never deposit more than you can afford to lose, and never borrow to farm. COST $0. TIME 10 minutes to read the protocol's own docs.`,
    `If ${row.name} issues a token, claim only through the protocol's own published page; never pay to claim, and never trust a link from a message or a search ad. COST about ${dollars(gas)} in gas. TIME 20 minutes.`,
    `After claiming, exit in two stages: unwind half the position, wait a day, then unwind the rest, so a thin launch market does not move against you. COST about ${dollars(gas * 2)} in gas. TIME 30 minutes.`,
  ];
}
