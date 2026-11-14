// Token Radar's page: the whole radar, recomputed in the browser from the snapshot's figures.
//
// The dataset ships beside this page as data.js (window.RADAR): the ranked board, the live-token
// set, the calibration and the model constants. Nothing here is trusted on sight: this script
// recomputes every row's implied value from the raw figures with the same formula the program used,
// checks it against the board's value, and shows the result. It also regenerates every farm plan
// from the row's own category, chain, TVL and age, and verifies each category's calibrated multiple
// against the shrinkage formula. A row or a multiple that does not recompute is shown as failing,
// never hidden.
//
// The model, in one place (mirrors lib/model.ts exactly, so the page and the program agree):
//
//   multiple     = shrunk per-category median mcap/TVL (global median where the category has too few)
//   growthMult   = 1 + 0.25 x sign(g) x sqrt(|g| / 100),  g = clamp(change_7d, -90, 400)
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   breadthMult  = min(1.15, 1 + 0.05 x ln(chain count))
//   implied      = max(1, round(tvl_usd x multiple x growthMult x maturityMult x breadthMult))
//
// Copy rule, kept throughout: a protocol "records no token" in the snapshot. That is what the
// record says; it is not proof that no token exists.

(function () {
  'use strict';

  const R = window.RADAR;
  const M = R.model;
  const CAL = R.calibration;
  const DAY_MS = 86400000;

  /** Escape text for HTML: protocol names come from the snapshot, not from us. */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Four-decimal rounding, matching the program's. */
  function round4(n) {
    return Math.round(n * 1e4) / 1e4;
  }

  /** A finite number, else `fallback`. */
  function finite(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /** Whole days from `listedAt` to the snapshot date; null when either date is absent or bad. */
  function ageDays(listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    const a = Date.parse(R.as_of + 'T00:00:00Z');
    const b = Date.parse(listedAt + 'T00:00:00Z');
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / DAY_MS));
  }

  /** The multiple one category is valued at: its shrunk calibration, or the global median when the
   *  category has no live comparables in this snapshot. */
  function multipleFor(category) {
    if (category === null || category === undefined) return CAL.global_median;
    const entry = CAL.by_category[category];
    return entry === undefined ? CAL.global_median : entry.multiple;
  }

  /** The four multipliers and the implied value one row gets, recomputed from its raw figures. */
  function impliedOf(row) {
    const age = ageDays(row.listed_at);
    const multiple = multipleFor(row.category);
    const rawGrowth = finite(row.change_7d, 0);
    const growthPct = Math.min(M.growth_cap, Math.max(M.growth_floor, rawGrowth));
    const growthMult = 1 + M.growth_weight * Math.sign(growthPct) * Math.sqrt(Math.abs(growthPct) / 100);
    const ageForModel = age === null ? M.unknown_age_days : age;
    const maturityMult =
      M.maturity_floor +
      (Math.min(Math.max(ageForModel, 0), M.maturity_days) / M.maturity_days) * M.maturity_range;
    const chainCount = Math.max(1, (row.chains || []).length);
    const breadthMult = Math.min(M.breadth_cap, 1 + M.breadth_weight * Math.log(chainCount));
    const implied = Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturityMult * breadthMult));
    return { implied, multiple, growthPct, growthMult, maturityMult, breadthMult, age };
  }

  /** Verify the calibration: each category's multiple must recompute from its median, its count and
   *  the global median through the shrinkage formula. Returns {checked, matched}. */
  function verifyCalibration() {
    let checked = 0;
    let matched = 0;
    const cats = Object.keys(CAL.by_category).sort();
    for (const cat of cats) {
      const e = CAL.by_category[cat];
      const k = M.shrinkage_prior;
      const recomputed = Math.min(M.multiple_cap, round4((e.comparables * e.median_multiple + k * CAL.global_median) / (e.comparables + k)));
      checked += 1;
      if (recomputed === e.multiple) matched += 1;
    }
    return { checked, matched };
  }

  /** Verify the board: every row's implied value must recompute exactly. Returns {checked, matched}. */
  function verifyBoard() {
    let matched = 0;
    for (const row of R.rows) {
      if (impliedOf(row).implied === row.implied_value_usd) matched += 1;
    }
    return { checked: R.rows.length, matched };
  }

  /** Compact money: $2.75B, $506.9M, $45.8M, $12.4K. */
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }

  /** Full money with commas, for the detail view. */
  function moneyFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  /** Age in days as "1.2y", "45d", or "—" when unknown. */
  function ageText(age) {
    if (age === null || age === undefined) return '—';
    if (age >= 365) return (age / 365).toFixed(1) + 'y';
    return age + 'd';
  }

  /** A 7-day change as "+12.3%" / "-6.8%" / "—", with its direction class. */
  function changeHtml(v) {
    if (v === null || v === undefined) return '<span>—</span>';
    const cls = v >= 0 ? 'up' : 'down';
    const sign = v >= 0 ? '+' : '';
    return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
  }

  // ---------------------------------------------------------------- farm plans
  // The plan is derived from the row's own record (category, chains, TVL, age), never from a
  // hand-written list of names. The same seven steps the program wrote into board.json, regenerated
  // here so the page and the board agree.

  /** The first chain a protocol names, or a neutral phrase. */
  function chainOf(row) {
    return row.chains && row.chains.length > 0 ? row.chains[0] : 'its main chain';
  }

  /** How much capital one farm position needs, from the protocol's own TVL. */
  function capitalFor(row) {
    if (row.tvl_usd >= 5000000000) return 250;
    if (row.tvl_usd >= 1000000000) return 150;
    if (row.tvl_usd >= 100000000) return 100;
    return 50;
  }

  /** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  /** Chains where a transaction costs well under a dollar. */
  var CHEAP_CHAINS = {
    arbitrum: 1, optimism: 1, base: 1, polygon: 1, bsc: 1, avalanche: 1, solana: 1, tron: 1,
    zksync: 1, starknet: 1, linea: 1, scroll: 1, mantle: 1, blast: 1, mode: 1, fraxtal: 1,
    gnosis: 1, celo: 1, fantom: 1, moonbeam: 1, aurora: 1, kava: 1, cronos: 1, opbnb: 1,
  };

  /** The gas line for a step on this chain: Ethereum mainnet costs real money, cheap chains cost cents. */
  function gasFor(chain) {
    const c = chain.toLowerCase();
    if (c === 'ethereum') return 'about $5 to $15 of gas per transaction';
    if (CHEAP_CHAINS[c] === 1) return 'under $1 of gas per transaction';
    return 'a few dollars of gas per transaction';
  }

  /** The category's one action, in the words a farmer can follow. */
  function actionFor(row, capital, chain) {
    const c = (row.category || '').toLowerCase();
    const name = row.name;
    if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('collateral') !== -1) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') !== -1 || c.indexOf('yield') !== -1 || c.indexOf('leveraged farm') !== -1) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') !== -1) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') !== -1 || c.indexOf('restak') !== -1) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') !== -1 || c.indexOf('derivative') !== -1 || c.indexOf('basis') !== -1) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') !== -1) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') !== -1 || c.indexOf('allocator') !== -1) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') !== -1) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') !== -1) return 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') !== -1) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('payment') !== -1) return 'Hold $' + capital + ' in ' + name + ' on ' + chain + ' and make one payment through it.';
    if (c.indexOf('governance') !== -1) return 'Deposit $' + capital + ' into ' + name + ' on ' + chain + ' and vote once on a live proposal.';
    if (c.indexOf('cedefi') !== -1) return 'Deposit $' + capital + ' of USDC into ' + name + "'s vault on " + chain + ' and keep the shares.';
    if (c.indexOf('chain') !== -1) return 'Bridge $' + capital + " to " + name + "'s chain and use one of its apps.";
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }

  /** The weekly qualifying action, in the category's own terms. */
  function weeklyFor(row) {
    const c = (row.category || '').toLowerCase();
    if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('collateral') !== -1) return 'Make one borrow, repay or top-up each week and keep the collateral ratio well above the liquidation line.';
    if (c.indexOf('dex') !== -1 || c.indexOf('yield') !== -1 || c.indexOf('leveraged farm') !== -1) return 'Add or remove a little liquidity each week, or claim and re-deposit the rewards the pool pays.';
    if (c.indexOf('bridge') !== -1) return 'Bridge one small amount each week so the activity shows as a repeat user, not a one-off.';
    if (c.indexOf('staking') !== -1 || c.indexOf('restak') !== -1) return 'Check the staking rewards each week and restake what accrues.';
    if (c.indexOf('perpetual') !== -1 || c.indexOf('derivative') !== -1 || c.indexOf('basis') !== -1) return 'Place one small trade each week and keep the position sized so a bad week cannot liquidate it.';
    if (c.indexOf('prediction') !== -1) return 'Place one market position each week and close it before the market resolves.';
    if (c.indexOf('curator') !== -1 || c.indexOf('allocator') !== -1) return 'Check the vault allocation each week and rebalance only if the strategy note changes.';
    if (c.indexOf('stable') !== -1) return 'Mint or redeem a small amount each week so the position stays active.';
    if (c.indexOf('rwa') !== -1) return 'Check the yield accrual each week and record the balance in the farm log.';
    if (c.indexOf('insurance') !== -1) return 'Check the policy each week and renew it before it lapses.';
    if (c.indexOf('payment') !== -1) return 'Make one payment each week through the protocol.';
    if (c.indexOf('governance') !== -1) return 'Vote once a week on any live proposal, or delegate while none is open.';
    return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
  }

  /** The risk note, in the category's own terms: what can actually go wrong with this position. */
  function riskFor(row) {
    const c = (row.category || '').toLowerCase();
    if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('collateral') !== -1) return 'The main risk is liquidation: if the collateral price falls, the position can be closed at a loss. Keep the ratio high and never borrow against the full deposit.';
    if (c.indexOf('dex') !== -1 || c.indexOf('yield') !== -1 || c.indexOf('leveraged farm') !== -1) return 'The main risk is impermanent loss: if the pool ratio moves against you, withdrawing returns less than holding. A leveraged farm can lose more than the deposit.';
    if (c.indexOf('bridge') !== -1) return 'The main risk is the bridge contract itself: a bug or an exploit can strand bridged funds. Never bridge more than you can afford to lose.';
    if (c.indexOf('staking') !== -1 || c.indexOf('restak') !== -1) return 'The main risk is the unstaking delay and, on restaking, slashing: the funds are locked for the unbonding period and a validator fault can cut them.';
    if (c.indexOf('perpetual') !== -1 || c.indexOf('derivative') !== -1 || c.indexOf('basis') !== -1) return 'The main risk is liquidation on leverage: a fast move against the position closes it. Keep leverage low and the margin well above the minimum.';
    if (c.indexOf('prediction') !== -1) return 'The main risk is the market itself: a position on the wrong side loses its stake. Size each position so one loss is a small cost.';
    if (c.indexOf('curator') !== -1 || c.indexOf('allocator') !== -1) return 'The main risk is the vault strategy: the curator can move funds into a pool that underperforms or is exploited. Read the strategy note before depositing.';
    if (c.indexOf('stable') !== -1) return 'The main risk is a depeg: if the stable asset loses its peg, the position loses value. Check the backing and the redemption route before minting.';
    if (c.indexOf('rwa') !== -1) return 'The main risk is the issuer and custodian: the yield asset is only as sound as the real-world backing behind it. Read the issuer disclosure first.';
    if (c.indexOf('insurance') !== -1) return 'The main risk is the claim conditions: cover pays only for the events the policy names. Read what is excluded before buying.';
    return 'The main risk is the smart contract itself: a bug can lose the deposit. Never farm with money you cannot afford to lose, and keep the position to one protocol at a time.';
  }

  /** The points-claim check, in the category's own terms. */
  function claimFor(row) {
    const c = (row.category || '').toLowerCase();
    if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('collateral') !== -1) return "Before you withdraw, open the protocol's own points or rewards page and check the lending points balance.";
    if (c.indexOf('dex') !== -1 || c.indexOf('yield') !== -1 || c.indexOf('leveraged farm') !== -1) return "Before you withdraw, open the protocol's own points or rewards page and check the liquidity points balance.";
    if (c.indexOf('staking') !== -1 || c.indexOf('restak') !== -1) return "Before you unstake, open the protocol's own points or rewards page and check the staking points balance.";
    return "Before you withdraw, open the protocol's own points or rewards page and check the balance.";
  }

  /** The exit: how to unwind this position when the farm is done. */
  function exitFor(row) {
    const c = (row.category || '').toLowerCase();
    if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('collateral') !== -1) return 'To exit, repay any borrow first, then withdraw the supply; the collateral returns only after the debt is cleared.';
    if (c.indexOf('dex') !== -1 || c.indexOf('yield') !== -1 || c.indexOf('leveraged farm') !== -1) return 'To exit, remove the liquidity in one transaction and claim any unclaimed rewards before the pool changes.';
    if (c.indexOf('staking') !== -1 || c.indexOf('restak') !== -1) return 'To exit, start the unstaking transaction and wait out the unbonding period; the funds arrive only after it ends.';
    if (c.indexOf('perpetual') !== -1 || c.indexOf('derivative') !== -1 || c.indexOf('basis') !== -1) return 'To exit, close the open position first, then withdraw the margin; never withdraw margin while a position is open.';
    if (c.indexOf('curator') !== -1 || c.indexOf('allocator') !== -1 || c.indexOf('cedefi') !== -1) return 'To exit, redeem the vault shares; the redemption settles at the next vault price, not the instant price.';
    if (c.indexOf('stable') !== -1) return 'To exit, redeem the stable asset through the protocol\'s own route and check the redemption rate before confirming.';
    return 'To exit, withdraw the position through the protocol\'s own app and confirm the funds arrive in the farm wallet.';
  }

  /** A protocol's farm plan: seven steps, each an action with a cost and a time. */
  function farmSteps(row) {
    const chain = chainOf(row);
    const capital = capitalFor(row);
    const hold = holdDaysFor(row.age_days);
    const gas = gasFor(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: gas, time: '5 minutes' },
      { text: actionFor(row, capital, chain), cost: '$' + capital + ' of capital and ' + gas, time: '15 minutes to set up' },
      { text: weeklyFor(row), cost: gas, time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: riskFor(row), cost: 'nothing to read, and it can save the position', time: '10 minutes' },
      { text: claimFor(row) + ' Claim only from the link the protocol itself publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log. ' + exitFor(row), cost: 'nothing but the log', time: '5 minutes' },
    ];
  }

  /** A step as one string: its action, then its cost and time. */
  function stepText(step) {
    let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
    return s;
  }

  // ---------------------------------------------------------------- rendering

  const $ = (id) => document.getElementById(id);
  const boardTable = $('board-table');
  const liveTable = $('live-table');
  const dialog = $('detail');

  let sortKey = 'rank';
  let sortDir = 1;
  let liveSortKey = 'mcap_usd';
  let liveSortDir = -1;
  let activeTab = 'pre';

  /** The board rows after the current filters, in the current sort order. */
  function filteredRows() {
    const q = $('q').value.trim().toLowerCase();
    const cat = $('f-cat').value;
    const chain = $('f-chain').value;
    const minTvl = Number($('f-tvl').value || 0);
    const growth = $('f-growth').value;
    const rows = R.rows.filter((row) => {
      if (q && row.name.toLowerCase().indexOf(q) === -1 && row.slug.toLowerCase().indexOf(q) === -1) return false;
      if (cat && row.category !== cat) return false;
      if (chain && (row.chains || []).indexOf(chain) === -1) return false;
      if (row.tvl_usd < minTvl) return false;
      if (growth === 'up' && !(row.change_7d !== null && row.change_7d > 0)) return false;
      if (growth === 'down' && !(row.change_7d !== null && row.change_7d < 0)) return false;
      return true;
    });
    rows.sort((a, b) => {
      const av = sortVal(a, sortKey);
      const bv = sortVal(b, sortKey);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return a.slug < b.slug ? -1 : 1;
    });
    return rows;
  }

  /** The value one row sorts by under a key. Nulls sort last in either direction. */
  function sortVal(row, key) {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'chains') return (row.chains || []).length;
    const v = row[key];
    if (v === null || v === undefined) return sortDir === 1 ? Infinity : -Infinity;
    return v;
  }

  /** One board row's HTML. The check column shows whether the page's recompute matches the board. */
  function boardRowHtml(row, maxImplied) {
    const v = impliedOf(row);
    const ok = v.implied === row.implied_value_usd;
    const barPct = Math.max(2, Math.round((row.implied_value_usd / maxImplied) * 100));
    const chains = (row.chains || []).slice(0, 2).join(', ') + ((row.chains || []).length > 2 ? ' +' + ((row.chains || []).length - 2) : '');
    return (
      '<tr data-slug="' + esc(row.slug) + '">' +
      '<td class="num">' + row.rank + '</td>' +
      '<td><span class="proto-name">' + esc(row.name) + '</span><span class="proto-sub">' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') + '</span></td>' +
      '<td class="num">' + money(row.tvl_usd) + '</td>' +
      '<td class="num">' + changeHtml(row.change_7d) + '</td>' +
      '<td class="num">' + ageText(row.age_days) + '</td>' +
      '<td class="chains">' + esc(chains || '—') + '</td>' +
      '<td class="num"><span class="bar" style="width:' + barPct + 'px"></span>' + money(row.implied_value_usd) + '</td>' +
      '<td class="num">' + v.multiple.toFixed(4) + '×</td>' +
      '<td>' + (ok ? '<span class="ok">✓ recomputed</span>' : '<span class="bad">✗ differs</span>') + '</td>' +
      '</tr>'
    );
  }

  function renderBoard() {
    const rows = filteredRows();
    const maxImplied = R.rows.length > 0 ? R.rows[0].implied_value_usd : 1;
    const body = boardTable.querySelector('tbody');
    body.innerHTML = rows.map((row) => boardRowHtml(row, maxImplied)).join('');
    $('count').textContent = rows.length + ' of ' + R.rows.length + ' rows shown';
    markSortHeaders(boardTable, sortKey, sortDir);
  }

  function renderLive() {
    const rows = R.live.slice().sort((a, b) => {
      const av = liveVal(a, liveSortKey);
      const bv = liveVal(b, liveSortKey);
      if (av < bv) return -1 * liveSortDir;
      if (av > bv) return 1 * liveSortDir;
      return a.slug < b.slug ? -1 : 1;
    });
    const body = liveTable.querySelector('tbody');
    body.innerHTML = rows.map((row) => {
      const ratio = row.mcap_usd !== null && row.tvl_usd > 0 ? row.mcap_usd / row.tvl_usd : null;
      return (
        '<tr><td><span class="proto-name">' + esc(row.name) + '</span><span class="proto-sub">' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') + '</span></td>' +
        '<td class="num">' + money(row.tvl_usd) + '</td>' +
        '<td class="num">' + (row.mcap_usd === null ? '—' : money(row.mcap_usd)) + '</td>' +
        '<td class="num">' + (ratio === null ? '—' : ratio.toFixed(3) + '×') + '</td>' +
        '<td class="num">' + changeHtml(row.change_7d) + '</td></tr>'
      );
    }).join('');
    markSortHeaders(liveTable, liveSortKey, liveSortDir);
  }

  function liveVal(row, key) {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'ratio') {
      if (row.mcap_usd === null || row.tvl_usd <= 0) return liveSortDir === 1 ? Infinity : -Infinity;
      return row.mcap_usd / row.tvl_usd;
    }
    const v = row[key];
    if (v === null || v === undefined) return liveSortDir === 1 ? Infinity : -Infinity;
    return v;
  }

  function markSortHeaders(table, key, dir) {
    const heads = table.querySelectorAll('th[data-sort]');
    heads.forEach((th) => {
      th.classList.remove('asc', 'desc');
      if (th.getAttribute('data-sort') === key) th.classList.add(dir === 1 ? 'asc' : 'desc');
    });
  }

  /** The calibration table: one row per category on the board, with its comparables and multiple. */
  function renderCalibration() {
    const cats = {};
    for (const row of R.rows) {
      const c = row.category || 'Uncategorised';
      if (!cats[c]) cats[c] = true;
    }
    const names = Object.keys(cats).sort();
    const body = $('cal-table').querySelector('tbody');
    const rows = names.map((name) => {
      const e = CAL.by_category[name];
      if (e === undefined) {
        return '<tr><td>' + esc(name) + '</td><td class="num">0–1</td><td class="num">—</td><td class="num">' + CAL.global_median.toFixed(4) + '× (global median)</td></tr>';
      }
      return '<tr><td>' + esc(name) + '</td><td class="num">' + e.comparables + '</td><td class="num">' + e.median_multiple.toFixed(4) + '×</td><td class="num">' + e.multiple.toFixed(4) + '×</td></tr>';
    });
    rows.push('<tr><td><strong>Global (all live-token protocols)</strong></td><td class="num">' + CAL.global_n + '</td><td class="num">' + CAL.global_median.toFixed(4) + '×</td><td class="num">' + CAL.global_median.toFixed(4) + '×</td></tr>');
    body.innerHTML = rows.join('');
  }

  /** The detail view: the row's figures, its implied-value equation, and its farm plan. */
  function openDetail(slug) {
    const row = R.rows.find((r) => r.slug === slug);
    if (!row) return;
    const v = impliedOf(row);
    const ok = v.implied === row.implied_value_usd;
    $('detail-title').textContent = row.name;
    const steps = farmSteps(row);
    const stepsHtml = steps.map((s) => '<li>' + esc(s.text) + '<span class="meta">Cost: ' + esc(s.cost) + '. Time: ' + esc(s.time) + '.</span></li>').join('');
    $('detail-body').innerHTML =
      '<dl>' +
      '<div><dt>Category</dt><dd>' + esc(row.category || 'Uncategorised') + '</dd></div>' +
      '<div><dt>Rank</dt><dd>#' + row.rank + ' of ' + R.rows.length + '</dd></div>' +
      '<div><dt>TVL</dt><dd>' + moneyFull(row.tvl_usd) + '</dd></div>' +
      '<div><dt>7-day change</dt><dd>' + (row.change_7d === null ? '—' : (row.change_7d >= 0 ? '+' : '') + row.change_7d.toFixed(1) + '%') + '</dd></div>' +
      '<div><dt>Age</dt><dd>' + ageText(row.age_days) + (row.listed_at ? ' (listed ' + esc(row.listed_at) + ')' : ' (listing date not recorded)') + '</dd></div>' +
      '<div><dt>Chains</dt><dd>' + esc((row.chains || []).join(', ') || '—') + '</dd></div>' +
      '<div><dt>Token status</dt><dd>records no token</dd></div>' +
      '<div><dt>Implied value</dt><dd>' + moneyFull(row.implied_value_usd) + '</dd></div>' +
      '</dl>' +
      '<h3>How the value is worked out</h3>' +
      '<p class="equation">' + moneyFull(row.tvl_usd) + ' &times; ' + v.multiple.toFixed(4) + ' &times; ' + v.growthMult.toFixed(4) + ' &times; ' + v.maturityMult.toFixed(4) + ' &times; ' + v.breadthMult.toFixed(4) + ' = ' + moneyFull(v.implied) + '</p>' +
      '<p>' + (ok ? '<span class="ok">✓ This page recomputed the value from the snapshot figures and it matches the board exactly.</span>' : '<span class="bad">✗ This page recomputed the value and it differs from the board: recomputed ' + moneyFull(v.implied) + ', board ' + moneyFull(row.implied_value_usd) + '.</span>') + '</p>' +
      '<p>Multiple ' + v.multiple.toFixed(4) + '×: ' + multipleNote(row.category) + '</p>' +
      '<h3>Farm plan</h3>' +
      '<ol class="steps">' + stepsHtml + '</ol>';
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    try {
      history.replaceState(null, '', '#detail/' + row.slug);
    } catch (e) { /* history is unavailable in some embeds; the dialog still works */ }
  }

  /** One line saying where a row's multiple came from. */
  function multipleNote(category) {
    const e = category === null ? undefined : CAL.by_category[category];
    if (e === undefined) return 'the category has fewer than two live comparables, so the global median (' + CAL.global_median.toFixed(4) + '×, from ' + CAL.global_n + ' live-token protocols) applies.';
    return 'the median mcap/TVL of ' + e.comparables + ' live comparables (' + e.median_multiple.toFixed(4) + '×), shrunk toward the global median (' + CAL.global_median.toFixed(4) + '×).';
  }

  function closeDetail() {
    if (dialog.open) dialog.close();
    try {
      history.replaceState(null, '', '#');
    } catch (e) { /* ignore */ }
  }

  function setTab(tab) {
    activeTab = tab;
    $('tab-pre').setAttribute('aria-selected', tab === 'pre' ? 'true' : 'false');
    $('tab-live').setAttribute('aria-selected', tab === 'live' ? 'true' : 'false');
    $('live-wrap').hidden = tab !== 'live';
    boardTable.closest('.table-wrap').hidden = tab !== 'pre';
    $('controls').style.display = tab === 'pre' ? '' : 'none';
    if (tab === 'live') renderLive();
  }

  function fillFilters() {
    const cats = {};
    const chains = {};
    for (const row of R.rows) {
      if (row.category) cats[row.category] = true;
      for (const ch of row.chains || []) chains[ch] = true;
    }
    const catSel = $('f-cat');
    Object.keys(cats).sort().forEach((c) => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      catSel.appendChild(o);
    });
    const chainSel = $('f-chain');
    Object.keys(chains).sort().forEach((c) => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      chainSel.appendChild(o);
    });
  }

  function init() {
    if (!R || !R.rows) {
      document.body.innerHTML = '<p style="padding:24px">This page needs its dataset (data.js), which did not load.</p>';
      return;
    }
    const stats = $('stats');
    const stat = (label, value) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>';
    stats.innerHTML =
      stat('Rows ranked', R.board_size) +
      stat('Watchlist', R.watchlist_size) +
      stat('Early rows', R.early_size) +
      stat('Live tokens', R.live_size) +
      stat('Global median', CAL.global_median.toFixed(4) + '×');
    $('asof').textContent = 'Snapshot: ' + R.source + ', frozen ' + R.as_of + '. Watchlist floor: ' + moneyFull(R.floor_usd) + '. Model ' + R.model_version + '.';

    const calV = verifyCalibration();
    const calEl = $('cal-check');
    calEl.textContent = 'Calibration check: ' + calV.matched + ' of ' + calV.checked + ' category multiples recompute exactly from their medians and counts.';
    if (calV.matched !== calV.checked) calEl.classList.add('bad');

    const boardV = verifyBoard();
    const recEl = $('recompute-check');
    recEl.textContent = 'Board check: ' + boardV.matched + ' of ' + boardV.checked + ' rows recompute to exactly the board\'s implied value.';
    if (boardV.matched !== boardV.checked) recEl.classList.add('bad');

    renderCalibration();
    fillFilters();
    renderBoard();

    $('q').addEventListener('input', renderBoard);
    $('f-cat').addEventListener('change', renderBoard);
    $('f-chain').addEventListener('change', renderBoard);
    $('f-tvl').addEventListener('change', renderBoard);
    $('f-growth').addEventListener('change', renderBoard);
    $('tab-pre').addEventListener('click', () => setTab('pre'));
    $('tab-live').addEventListener('click', () => setTab('live'));

    boardTable.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
        renderBoard();
      });
    });
    liveTable.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort');
        if (liveSortKey === key) liveSortDir = -liveSortDir;
        else { liveSortKey = key; liveSortDir = key === 'name' ? 1 : -1; }
        renderLive();
      });
    });
    boardTable.querySelector('tbody').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-slug]');
      if (tr) openDetail(tr.getAttribute('data-slug'));
    });
    dialog.addEventListener('close', () => {
      try { history.replaceState(null, '', '#'); } catch (e) { /* ignore */ }
    });
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) closeDetail();
    });

    // Deep link: #detail/<slug> opens that protocol's detail view (used for the screenshots).
    const hash = window.location.hash || '';
    const m = hash.match(/^#detail\/(.+)$/);
    if (m) openDetail(decodeURIComponent(m[1]));
    const cm = hash.match(/^#category\/(.+)$/);
    if (cm) {
      $('f-cat').value = decodeURIComponent(cm[1]);
      renderBoard();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
