// The token radar's model, version radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// What radar-2 changes against the starter's radar-1, and why:
//
//   1. The multiple is calibrated, not flat. radar-1 valued every protocol at 0.25x its TVL. This
//      snapshot's own live-token protocols show that multiple varies 18x by category (median mcap/TVL
//      0.041 for Liquid Staking, 0.746 for Canonical Bridge, 0.214 overall). radar-2 derives a
//      per-category multiple from those live comparables at run time: the median mcap/TVL of the
//      category's live-token protocols, shrunk toward the global median for thin categories, with the
//      global median where a category has no live comparables at all. Two guards keep the
//      calibration honest: a category needs at least two live comparables to earn its own multiple
//      (a single comparable is one protocol's ratio, not a median — and this snapshot's singletons
//      include a 400x outlier), and no multiple exceeds 1.0x TVL (a launch is not valued above the
//      value the protocol already holds). No protocol name is ever special-cased; the multiple is a
//      function of the snapshot's figures alone.
//   2. Growth is dampened. A 7-day change is a noisy number: one protocol sits at +4,448.5%. radar-1
//      let it move a row 2.3x. radar-2 clamps it to [-90, +400] and takes the square root, so the
//      growth factor spans 0.76x..1.50x and the median protocol (about -7%) moves only ~6%.
//   3. Chain breadth counts, a little. A protocol live on many chains has more durable distribution
//      than a single-chain one. A capped log factor adds at most 15% and nothing for a single chain.
//   4. The board carries every rankable pre-token protocol below the watchlist floor (226 rows), not
//      the starter's capped 200. The 63 above-floor protocols the watchlist deliberately leaves out
//      (bridges, liquid staking, wrapped products whose token already trades via a parent) are still
//      not ranked as launches.
//   5. Farm plans are differentiated by category, chain and TVL: seven steps with a category action,
//      chain-specific gas, a weekly qualifying action, an age-based hold, a category risk note, a
//      points-claim check and a log-and-exit step.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds the
// pre-token protocols below it. A protocol is pre-token when its index entry records no token (no
// market cap, no CoinGecko id, no symbol); live-token protocols are kept apart and shown as the
// market's own values, never mixed into the ranked board.
//
//   multiple     = shrunk per-category median mcap/TVL (global median where the category has too few)
//   growthMult   = 1 + 0.25 x sign(g) x sqrt(|g| / 100),  g = clamp(change_7d, -90, 400)
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   breadthMult  = min(1.15, 1 + 0.05 x ln(chain count))
//   implied      = max(1, round(tvl_usd x multiple x growthMult x maturityMult x breadthMult))

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  shrinkage_prior: number;
  min_comparables: number;
  multiple_cap: number;
  breadth_weight: number;
  breadth_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.25,
  growth_floor: -90,
  growth_cap: 400,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  shrinkage_prior: 4,
  min_comparables: 2,
  multiple_cap: 1.0,
  breadth_weight: 0.05,
  breadth_cap: 1.15,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** The early radar's safety cap on pre-token protocols below the watchlist floor, by TVL. Set far
 *  above the 186 such protocols this snapshot holds, so the board carries all of them. */
export const EARLY_ROWS = 1000;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's calibration: how many live comparables it has, their median multiple, and the
 *  shrunk multiple the model applies to the category. */
export interface CategoryCalibration {
  comparables: number;
  median_multiple: number;
  multiple: number;
}

/** The calibration the model derives from the snapshot's live-token protocols: the global median
 *  multiple plus one entry per category that has live comparables. A category absent from
 *  by_category has no live comparables and is valued at the global median. */
export interface Calibration {
  global_median: number;
  global_n: number;
  by_category: Record<string, CategoryCalibration>;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Four-decimal rounding, so a multiple is one stable number in the board, the data and the page. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a list of numbers: the middle value, or the mean of the two middle values for an
 *  even count. Medians, never means: a few protocols with market caps far above their TVL drag the
 *  mean to 5.0 while the median sits at 0.205. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The calibration, derived from the snapshot's own live-token protocols. Every protocol with a
 * market cap and a positive TVL contributes its mcap/TVL ratio: once to the global pool, once to its
 * category's pool. Each category's multiple is its median shrunk toward the global median with a
 * prior of `shrinkage_prior` pseudo-observations, so a category with few comparables leans on the
 * global figure and a well-covered category stands on its own. Two guards apply: a category with
 * fewer than `min_comparables` live comparables gets no entry here (one comparable is a single
 * protocol's ratio, not a median, and is valued at the global median by `multipleFor`), and no
 * multiple exceeds `multiple_cap`. Categories with no live comparables at all are likewise valued
 * at the global median. Protocols with a zero or negative market cap are not comparables: a $0
 * market cap is a dead or missing token, not a price.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const ratios = live.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const globalMedian = ratios.length > 0 ? round4(median(ratios)) : 0.205;
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const pool = byCategory.get(key);
    if (pool === undefined) byCategory.set(key, [(p.mcap_usd as number) / p.tvl_usd]);
    else pool.push((p.mcap_usd as number) / p.tvl_usd);
  }
  const by_category: Record<string, CategoryCalibration> = {};
  for (const [category, pool] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = pool.length;
    if (n < model.min_comparables) continue;
    const catMedian = round4(median(pool));
    const k = model.shrinkage_prior;
    const multiple = Math.min(model.multiple_cap, round4((n * catMedian + k * globalMedian) / (n + k)));
    by_category[category] = { comparables: n, median_multiple: catMedian, multiple };
  }
  return { global_median: globalMedian, global_n: ratios.length, by_category };
}

/** The multiple one category is valued at: its shrunk calibration, or the global median when the
 *  category has no live comparables in this snapshot. */
export function multipleFor(category: string | null, calibration: Calibration): number {
  if (category === null) return calibration.global_median;
  const entry = calibration.by_category[category];
  return entry === undefined ? calibration.global_median : entry.multiple;
}

/** The four multipliers and the implied value one protocol gets under `model` and `calibration`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  calibration: Calibration,
): {
  implied: number;
  multiple: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const multiple = multipleFor(protocol.category, calibration);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  // Square-root dampening: a 7-day move of +400% lifts the value by 50%, -90% cuts it by 24%.
  const growthMult =
    1 + model.growth_weight * Math.sign(growthPct) * Math.sqrt(Math.abs(growthPct) / 100);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) *
      model.maturity_range;
  const chainCount = Math.max(1, protocol.chains.length);
  const breadthMult = Math.min(
    model.breadth_cap,
    1 + model.breadth_weight * Math.log(chainCount),
  );
  const implied = Math.max(
    1,
    Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult * breadthMult),
  );
  return { implied, multiple, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
  calibration: Calibration = calibrate(snapshot, model),
): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is on the board.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor, by TVL. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen. The 63 rankable protocols above
  // the floor that the watchlist leaves out (bridges, liquid staking, wrapped products) are not
  // ranked as launches: their token already trades through a parent.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, calibration);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? (p.chains[0] as string) : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Whether the chain is one where a transaction costs well under a dollar. */
const CHEAP_CHAINS = new Set([
  'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche', 'solana', 'tron',
  'zksync', 'starknet', 'linea', 'scroll', 'mantle', 'blast', 'mode', 'fraxtal',
  'gnosis', 'celo', 'fantom', 'moonbeam', 'aurora', 'kava', 'cronos', 'opbnb',
]);

/** The gas line for a step on this chain: Ethereum mainnet costs real money, cheap chains cost cents. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $5 to $15 of gas per transaction';
  if (CHEAP_CHAINS.has(c)) return 'under $1 of gas per transaction';
  return 'a few dollars of gas per transaction';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('payment')) return `Hold $${capital} in ${name} on ${chain} and make one payment through it.`;
  if (c.includes('governance')) return `Deposit $${capital} into ${name} on ${chain} and vote once on a live proposal.`;
  if (c.includes('cedefi')) return `Deposit $${capital} of USDC into ${name}'s vault on ${chain} and keep the shares.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${name}'s chain and use one of its apps.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, in the category's own terms. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Make one borrow, repay or top-up each week and keep the collateral ratio well above the liquidation line.';
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Add or remove a little liquidity each week, or claim and re-deposit the rewards the pool pays.';
  if (c.includes('bridge')) return 'Bridge one small amount each week so the activity shows as a repeat user, not a one-off.';
  if (c.includes('staking') || c.includes('restak')) return 'Check the staking rewards each week and restake what accrues.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return 'Place one small trade each week and keep the position sized so a bad week cannot liquidate it.';
  if (c.includes('prediction')) return 'Place one market position each week and close it before the market resolves.';
  if (c.includes('curator') || c.includes('allocator')) return 'Check the vault allocation each week and rebalance only if the strategy note changes.';
  if (c.includes('stable')) return 'Mint or redeem a small amount each week so the position stays active.';
  if (c.includes('rwa')) return 'Check the yield accrual each week and record the balance in the farm log.';
  if (c.includes('insurance')) return 'Check the policy each week and renew it before it lapses.';
  if (c.includes('payment')) return 'Make one payment each week through the protocol.';
  if (c.includes('governance')) return 'Vote once a week on any live proposal, or delegate while none is open.';
  return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/** The risk note, in the category's own terms: what can actually go wrong with this position. */
function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'The main risk is liquidation: if the collateral price falls, the position can be closed at a loss. Keep the ratio high and never borrow against the full deposit.';
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'The main risk is impermanent loss: if the pool ratio moves against you, withdrawing returns less than holding. A leveraged farm can lose more than the deposit.';
  if (c.includes('bridge')) return 'The main risk is the bridge contract itself: a bug or an exploit can strand bridged funds. Never bridge more than you can afford to lose.';
  if (c.includes('staking') || c.includes('restak')) return 'The main risk is the unstaking delay and, on restaking, slashing: the funds are locked for the unbonding period and a validator fault can cut them.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return 'The main risk is liquidation on leverage: a fast move against the position closes it. Keep leverage low and the margin well above the minimum.';
  if (c.includes('prediction')) return 'The main risk is the market itself: a position on the wrong side loses its stake. Size each position so one loss is a small cost.';
  if (c.includes('curator') || c.includes('allocator')) return 'The main risk is the vault strategy: the curator can move funds into a pool that underperforms or is exploited. Read the strategy note before depositing.';
  if (c.includes('stable')) return 'The main risk is a depeg: if the stable asset loses its peg, the position loses value. Check the backing and the redemption route before minting.';
  if (c.includes('rwa')) return 'The main risk is the issuer and custodian: the yield asset is only as sound as the real-world backing behind it. Read the issuer disclosure first.';
  if (c.includes('insurance')) return 'The main risk is the claim conditions: cover pays only for the events the policy names. Read what is excluded before buying.';
  return 'The main risk is the smart contract itself: a bug can lose the deposit. Never farm with money you cannot afford to lose, and keep the position to one protocol at a time.';
}

/** The points-claim check, in the category's own terms. */
function claimFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Before you withdraw, open the protocol\'s own points or rewards page and check the lending points balance.';
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Before you withdraw, open the protocol\'s own points or rewards page and check the liquidity points balance.';
  if (c.includes('staking') || c.includes('restak')) return 'Before you unstake, open the protocol\'s own points or rewards page and check the staking points balance.';
  return 'Before you withdraw, open the protocol\'s own points or rewards page and check the balance.';
}

/** The exit: how to unwind this position when the farm is done. */
function exitFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'To exit, repay any borrow first, then withdraw the supply; the collateral returns only after the debt is cleared.';
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'To exit, remove the liquidity in one transaction and claim any unclaimed rewards before the pool changes.';
  if (c.includes('staking') || c.includes('restak')) return 'To exit, start the unstaking transaction and wait out the unbonding period; the funds arrive only after it ends.';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return 'To exit, close the open position first, then withdraw the margin; never withdraw margin while a position is open.';
  if (c.includes('curator') || c.includes('allocator') || c.includes('cedefi')) return 'To exit, redeem the vault shares; the redemption settles at the next vault price, not the instant price.';
  if (c.includes('stable')) return 'To exit, redeem the stable asset through the protocol\'s own route and check the redemption rate before confirming.';
  return 'To exit, withdraw the position through the protocol\'s own app and confirm the funds arrive in the farm wallet.';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: gas,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p),
      cost: gas,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: riskFor(p),
      cost: 'nothing to read, and it can save the position',
      time: '10 minutes',
    },
    {
      text: `${claimFor(p)} Claim only from the link the protocol itself publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log. ${exitFor(p)}`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot, model);
  const board = buildBoard(snapshot, model, calibration);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    const prev = board[i - 1] as BoardRow;
    const cur = board[i] as BoardRow;
    if (cur.implied_value_usd > prev.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2) {
    const first = board[0] as BoardRow;
    const last = board[board.length - 1] as BoardRow;
    if (first.implied_value_usd === last.implied_value_usd) {
      return `all ${board.length} rows share the same implied value $${first.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
    }
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
