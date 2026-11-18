/* Token Launch Radar v3 — the board, recomputed live in the page.
 * The program's numbers arrive in window.RADAR_DATA; this page re-derives
 * the curve from the comparables and re-prices every row's farm economics
 * for the deposit and drop share the reader picks, so the verdicts move
 * as the reader moves the selectors. Nothing here calls the network. */
(function () {
"use strict";
const D = window.RADAR_DATA;
const P = D.econParams;
const qs = (s, el) => (el || document).querySelector(s);
const qsa = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "$0.00";
  const sign = n < 0 ? "-" : "", mag = Math.abs(n);
  if (mag >= 1e9) return sign + "$" + (mag / 1e9).toFixed(2) + "B";
  if (mag >= 1e6) return sign + "$" + (mag / 1e6).toFixed(1) + "M";
  if (mag >= 1e3) return sign + "$" + (mag / 1e3).toFixed(1) + "k";
  if (mag >= 1) return sign + "$" + Math.round(mag);
  return sign + "$" + mag.toFixed(2);
};
const pct = (n, d) => (n == null ? "—" : (n * 100).toFixed(d == null ? 0 : d) + "%");
const cost = (n) => (n < 0.005 ? "$0.00" : "−" + money(n)); // a cost that rounds to zero shows no minus sign
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/* ---- Farm economics, re-derived here so the selectors move the verdicts ---- */
const gasOf = (row) => P.gas[row.chains[0]] !== undefined ? P.gas[row.chains[0]] : P.gasFallback;
function econ(row, deposit, share) {
  const slice = Math.min(deposit / row.tvl_usd, P.sliceCap);
  const expected = row.implied_value_usd * share * slice;
  const fees = P.txPerPlan * gasOf(row);
  const forgone = deposit * P.tbill * (P.planDays / 365);
  const dailyVol = P.floatAtLaunch * row.implied_value_usd * P.dailyTurnover;
  const slip = dailyVol > 0 ? P.slipK * Math.sqrt(Math.max(0, expected) / dailyVol) : 0;
  const exit = Math.min(expected, expected * slip);
  const net = expected - fees - forgone - exit;
  return { slice, expected, fees, forgone, exit, net,
    perHour: net / P.planHours, verdict: net > P.farmLine ? "FARM" : net > 0 ? "MARGINAL" : "SKIP" };
}
function breakEven(row, share) {
  const netAt = (c) => econ(row, c, share).net;
  let peak = -Infinity, at = 1;
  for (let c = 1; c <= 1e8; c *= 1.5) { const v = netAt(c); if (v > peak) { peak = v; at = c; } }
  if (peak <= 0) return null;
  let lo = 1, hi = at;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (netAt(m) < 0) lo = m; else hi = m; }
  return hi;
}

/* ---- Recompute the curve in-page and check it against the program ---- */
function ols(list) {
  const pts = list.map((c) => [Math.log10(c.tvl), Math.log10(c.mcap)]);
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  const ax = sx / n, ay = sy / n;
  let vxx = 0, vxy = 0;
  for (const [x, y] of pts) { vxx += (x - ax) * (x - ax); vxy += (x - ax) * (y - ay); }
  const slope = vxy / vxx, intercept = ay - slope * ax;
  let err2 = 0;
  for (const [x, y] of pts) err2 += (y - (intercept + slope * x)) ** 2;
  return { intercept, slope, rmse: Math.sqrt(err2 / n), n };
}
const dated = D.comparables.filter((c) => c.dated);
const fitHere = ols(dated);
const fitOk = Math.abs(fitHere.slope - D.fit.slope) < 1e-9 && Math.abs(fitHere.intercept - D.fit.intercept) < 1e-9;
let valuesOk = 0;
for (const r of D.rows) {
  const v = r.value_if_launches_usd * r.launch_odds;
  if (Math.abs(v - r.implied_value_usd) / r.implied_value_usd < 0.002) valuesOk++;
}
const econOk = D.rows.every((r) => Math.abs(econ(r, P.defaultDeposit, P.defaultShare).net - r.econ_default.net_usd) < 0.02);

/* ---- State ---- */
let deposit = P.defaultDeposit, share = P.defaultShare;
let verdictTab = "ALL", sortKey = "rank", openSlug = null;

/* ---- Header + KPIs ---- */
qs("#snap-line").textContent = "Snapshot " + D.asOf + " · " + D.source + " · watchlist floor " + money(D.floorUsd) + " · " + D.counts.total + " protocols";
function tally() {
  const t = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of D.rows) t[econ(r, deposit, share).verdict]++;
  return t;
}
function bestPerHour() {
  let best = null;
  for (const r of D.rows) { const e = econ(r, deposit, share); if (!best || e.perHour > best.e.perHour) best = { r, e }; }
  return best;
}
function renderKpis() {
  const t = tally(), b = bestPerHour(), v = D.validation;
  const aside = D.asideBreakdown.map((x) => x.reason.replace(/^Excluded category: /, "") + " " + x.n).join(" · ");
  qs("#kpis").innerHTML = [
    [String(D.counts.total), "protocols accounted for: " + D.counts.ranked + " ranked + " + D.counts.trading + " trading + " + D.counts.setAside + " set aside"],
    [D.counts.watchCovered + " / " + D.counts.watchlist, "watchlist covered — every one of the " + D.counts.watchlist + " is on the board"],
    ["×" + v.loo.model.median.toFixed(2), "leave-one-out median miss (" + v.loo.model.n + " dated comps); walk-forward ×" + v.walkForward.pooled.median.toFixed(2)],
    [t.FARM + " / " + t.MARGINAL + " / " + t.SKIP, "FARM / MARGINAL / SKIP at " + money(deposit) + " and a " + pct(share, 1) + " drop"],
    [money(b.e.perHour) + "/h", "best net per hour: " + b.r.name + " (net " + money(b.e.net) + ")"],
    [P.planWeeks + " weeks", "plan horizon for every row · typical wait to launch ≈ " + Math.round(D.odds.typicalWaitDays / 30) + " months"],
  ].map(([n, l]) => `<div class="kpi"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("");
  qs("#kpis").insertAdjacentHTML("beforeend", `<div class="kpi" style="grid-column:1/-1"><span>Set aside, ${D.counts.setAside}: ${esc(aside)}. A wrapped, staked or bridged product of a token that already trades is not a token that does not exist yet.</span></div>`);
}

/* ---- Verdict tabs ---- */
function renderTabs() {
  const t = tally(), wl = D.rows.filter((r) => r.watchlist).length;
  const tabs = [["ALL", "All " + D.rows.length], ["WATCH", "Watchlist " + wl],
    ["FARM", "Farm " + t.FARM], ["MARGINAL", "Marginal " + t.MARGINAL], ["SKIP", "Skip " + t.SKIP]];
  qs("#verdict-tabs").innerHTML = tabs.map(([k, l]) =>
    `<button class="vtab${verdictTab === k ? " on" : ""}" data-v="${k}" type="button">${esc(l)}</button>`).join("");
  qsa("#verdict-tabs .vtab").forEach((b) => b.addEventListener("click", () => { verdictTab = b.dataset.v; renderTabs(); renderBoard(); }));
}

/* ---- Board table ---- */
function visibleRows() {
  const q = (qs("#q").value || "").toLowerCase();
  const cat = qs("#cat").value, ch = qs("#chain").value;
  let rows = D.rows.filter((r) => {
    if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
    if (cat && r.category !== cat) return false;
    if (ch && r.chains.indexOf(ch) < 0) return false;
    if (verdictTab === "WATCH" && !r.watchlist) return false;
    if ((verdictTab === "FARM" || verdictTab === "MARGINAL" || verdictTab === "SKIP") && econ(r, deposit, share).verdict !== verdictTab) return false;
    return true;
  });
  const key = (r) => sortKey === "net" ? econ(r, deposit, share).net
    : sortKey === "perhour" ? econ(r, deposit, share).perHour : r[sortKey];
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (sortKey === "rank" ? 1 : -1));
  return rows;
}
function renderBoard() {
  const rows = visibleRows();
  qs("#row-count").textContent = rows.length + " of " + D.rows.length + " rows";
  qs("#board tbody").innerHTML = rows.map((r) => {
    const e = econ(r, deposit, share);
    const chains = r.chains.slice(0, 3).join(", ") + (r.chains.length > 3 ? " +" + (r.chains.length - 3) : "");
    return `<tr data-slug="${r.slug}" class="${r.slug === openSlug ? "sel" : ""}">
      <td class="num">${r.rank}<br><span class="range">#${r.rank_lo}–${r.rank_hi}</span></td>
      <td><b>${esc(r.name)}</b> <span class="badge ${r.watchlist ? "watch" : "early"}">${r.watchlist ? "WATCH" : "EARLY"}</span><br><span class="dim">${esc(r.category)} · ${esc(chains)}</span></td>
      <td class="num">${money(r.tvl_usd)}<br><span class="dim">fwd ${money(r.forward_tvl_usd)}</span></td>
      <td class="num">${money(r.value_if_launches_usd)}</td>
      <td class="num">${pct(r.launch_odds)}<br><span class="dim">${esc(r.age_bucket)}</span></td>
      <td class="num"><b>${money(r.implied_value_usd)}</b></td>
      <td class="num ${e.net >= 0 ? "pos" : "neg"}">${money(e.net)}</td>
      <td class="num ${e.perHour >= 0 ? "pos" : "neg"}">${money(e.perHour)}</td>
      <td><span class="v ${e.verdict}">${e.verdict}</span></td></tr>`;
  }).join("");
}
qs("#board tbody").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-slug]");
  if (tr) openDetail(tr.dataset.slug);
});
qs("#q").addEventListener("input", renderBoard);
qs("#cat").addEventListener("change", renderBoard);
qs("#chain").addEventListener("change", renderBoard);
qs("#sort").addEventListener("change", (e) => { sortKey = e.target.value; renderBoard(); });
qs("#deposit").addEventListener("change", (e) => { deposit = parseInt(e.target.value, 10); renderKpis(); renderTabs(); renderBoard(); if (openSlug) openDetail(openSlug); });
qs("#share").addEventListener("change", (e) => { share = parseFloat(e.target.value); renderKpis(); renderTabs(); renderBoard(); if (openSlug) openDetail(openSlug); });
qs("#reset").addEventListener("click", () => {
  qs("#q").value = ""; qs("#cat").value = ""; qs("#chain").value = ""; qs("#sort").value = "rank";
  sortKey = "rank"; verdictTab = "ALL"; renderTabs(); renderBoard();
});
{
  const cats = [...new Set(D.rows.map((r) => r.category))].sort();
  qs("#cat").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option>${esc(c)}</option>`).join("");
  const chains = Array.from(new Set(D.rows.flatMap((r) => r.chains))).sort();
  qs("#chain").innerHTML = `<option value="">All chains</option>` + chains.map((c) => `<option>${esc(c)}</option>`).join("");
}

/* ---- Detail panel ---- */
function nearest(r, n) {
  return [...D.comparables]
    .map((c) => ({ c, d: Math.abs(Math.log10(c.tvl) - Math.log10(r.tvl_usd)) + (c.category === r.category ? 0 : 1) }))
    .sort((a, b) => a.d - b.d || a.c.slug.localeCompare(b.c.slug)).slice(0, n).map((x) => x.c);
}
function openDetail(slug) {
  const r = D.rows.filter((x) => x.slug === slug)[0];
  if (!r) return;
  openSlug = slug;
  const e = econ(r, deposit, share);
  const be = breakEven(r, share);
  const near = nearest(r, 4);
  const deps = [...new Set([deposit, 1000, 10000])];
  qs("#detail-title").textContent = r.name + "  #" + r.rank + (r.watchlist ? " · watchlist" : "");
  qs("#detail-body").innerHTML =
    `<p class="dim">${esc(r.category)} · ${esc(r.chains.join(", "))} · TVL ${money(r.tvl_usd)}` +
    ` · ${r.age_days == null ? "listing date unrecorded" : r.age_days + " days with no token recorded"}` +
    ` · rank range #${r.rank_lo}–${r.rank_hi} over ${D.slopeStats.draws} bootstrap refits</p>` +
    (r.same_name_trades ? `<p class="neg">A traded token shares this name — check it is not the same project. No discount is applied for it.</p>` : "") +
    `<h3>Pricing decomposition — how the implied value is built</h3><table>` +
    `<tr><td>Forward TVL (snapshot TVL carried by the 7d change, clamped ±20%)</td><td class="num">${money(r.forward_tvl_usd)}</td></tr>` +
    `<tr><td>Size curve — 10^${D.fit.intercept.toFixed(2)} × TVL^${D.fit.slope.toFixed(2)}, fitted on ${D.fit.n} dated comps</td><td class="num">${money(r.curve_value_usd)}</td></tr>` +
    `<tr><td>Category premium — ${esc(r.category)} offset ${r.family_offset >= 0 ? "+" : ""}${r.family_offset.toFixed(3)} in log-ten (${r.family_n} comp${r.family_n === 1 ? "" : "s"})</td><td class="num">×${Math.pow(10, r.family_offset).toFixed(2)}</td></tr>` +
    `<tr><td><b>Value if it launches</b></td><td class="num"><b>${money(r.value_if_launches_usd)}</b></td></tr>` +
    `<tr><td>Launch odds — category rate ${pct(r.category_rate)} × age factor ${r.age_factor.toFixed(2)} (${esc(r.age_bucket)} bucket), clamped 5–90%</td><td class="num">${pct(r.launch_odds)}</td></tr>` +
    `<tr><td><b>Implied value = value if launches × odds</b></td><td class="num"><b>${money(r.implied_value_usd)}</b></td></tr></table>` +
    `<h3>Nearest traded comparables</h3><table><tr><th>Token</th><th>TVL</th><th>Market cap</th><th class="num">MCap / TVL</th></tr>` +
    near.map((c) => `<tr><td>${esc(c.name)}</td><td>${money(c.tvl)}</td><td>${money(c.mcap)}</td><td class="num">${(c.mcap / c.tvl).toFixed(2)}×</td></tr>`).join("") + `</table>` +
    `<h3>Farm economics at ${money(deposit)} and a ${pct(share, 1)} drop</h3><table>` +
    `<tr><td>Your slice of the pool (capped at ${pct(P.sliceCap, 1)})</td><td class="num">${(e.slice * 100).toFixed(4)}%</td></tr>` +
    `<tr><td>Expected airdrop</td><td class="num">${money(e.expected)}</td></tr>` +
    `<tr><td>Fees (${P.txPerPlan} tx on ${esc(r.chains[0] || "Ethereum")})</td><td class="num">${cost(e.fees)}</td></tr>` +
    `<tr><td>T-bill yield forgone (${(P.tbill * 100).toFixed(2)}% × ${P.planWeeks} weeks)</td><td class="num">${cost(e.forgone)}</td></tr>` +
    `<tr><td>Exit slippage</td><td class="num">${cost(e.exit)}</td></tr>` +
    `<tr><td><b>Net over ${P.planHours} hours</b></td><td class="num ${e.net >= 0 ? "pos" : "neg"}"><b>${money(e.net)}</b> (${money(e.perHour)}/h) <span class="v ${e.verdict}">${e.verdict}</span></td></tr>` +
    `<tr><td>Break-even deposit at a ${pct(share, 1)} drop</td><td class="num">${be === null ? "Never — each extra dollar earns less in expected drop than the T-bill yield it gives up" : money(be)}</td></tr></table>` +
    `<h3>Sensitivity — verdict and net by drop share × deposit</h3><table><tr><th>Drop \\ deposit</th>${deps.map((d) => `<th class="num">${money(d)}</th>`).join("")}</tr>` +
    P.shares.map((s) => `<tr><td>${pct(s, 1)}</td>${deps.map((d) => { const x = econ(r, d, s); return `<td class="num ${x.net >= 0 ? "pos" : "neg"}">${money(x.net)}<br><span class="v ${x.verdict}">${x.verdict}</span></td>`; }).join("")}</tr>`).join("") + `</table>` +
    `<p class="dim">Typical wait to launch across traded protocols: about ${Math.round(D.odds.typicalWaitDays / 30)} months (median age of protocols that record a token). The plan itself runs ${P.planWeeks} weeks; review at week ${P.planWeeks / 2} and exit early if TVL halves or the team goes silent.</p>` +
    `<h3>Farm plan — ${P.planWeeks} weeks, every step costed</h3><ol>` +
    r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("") + `</ol>`;
  qs("#detail-panel").hidden = false;
  renderBoard();
}
qs("#detail-close").addEventListener("click", () => { openSlug = null; qs("#detail-panel").hidden = true; renderBoard(); });

/* ---- Out-of-sample panel ---- */
(function renderOos() {
  const v = D.validation, f = D.fit;
  qs("#oos-intro").textContent = "Fitted on " + f.n + " dated comparables (of " + f.allComps + " traded tokens with a positive cap; " +
    f.droppedZeroCap + " zero/negative caps excluded as data errors, " + f.winsorized + " ratio winsorized at 100×). " +
    "The " + f.undatedComps + " undated traded tokens still anchor the nearest-comparable lists. Median miss ×1 would be exact; a flat multiple is shown beside every check.";
  const x = (n) => "×" + n.toFixed(2);
  qs("#oos-head").innerHTML = `<table><tr><th>Check</th><th class="num">Model</th><th class="num">Flat median</th><th class="num">Flat 0.25×</th></tr>` +
    `<tr><td>Leave-one-out (median miss, n=${v.loo.model.n})</td><td class="num"><b>${x(v.loo.model.median)}</b></td><td class="num">${x(v.loo.flatMedian.median)}</td><td class="num">${x(v.loo.flat025.median)}</td></tr>` +
    `<tr><td>Fair: dated fit scored on all ${v.looFair.n} comps</td><td class="num"><b>${x(v.looFair.median)}</b></td><td class="num" colspan="2">—</td></tr>` +
    `<tr><td>Walk-forward pooled (n=${v.walkForward.pooled.n})</td><td class="num"><b>${x(v.walkForward.pooled.median)}</b></td><td class="num">${x(v.walkForward.pooledFlat.median)}</td><td class="num">curve-only ${x(v.walkForward.pooledCurveOnly.median)}</td></tr>` +
    `<tr><td>Time split (${v.timeSplit.trainN} pre-2024 → ${v.timeSplit.testN} newer)</td><td class="num"><b>${x(v.timeSplit.model.median)}</b></td><td class="num">${x(v.timeSplit.flatMedian.median)}</td><td class="num">${x(v.timeSplit.flat025.median)}</td></tr>` +
    `<tr><td>Within 3× of the real cap (LOO)</td><td class="num">${pct(v.loo.model.within3x)}</td><td class="num">${pct(v.loo.flatMedian.within3x)}</td><td class="num">${pct(v.loo.flat025.within3x)}</td></tr>` +
    `<tr><td>Band coverage P50 / P80 (nominal 50% / 80%)</td><td class="num">${pct(v.bands.p50)} / ${pct(v.bands.p80)}</td><td class="num" colspan="2">n=${v.bands.n}</td></tr>` +
    `<tr><td>Median bias (log-ten; 0 = unbiased)</td><td class="num" colspan="3">${v.bias.toFixed(3)}</td></tr>` +
    `<tr><td>Bootstrap slope (${D.slopeStats.draws} refits)</td><td class="num" colspan="3">${D.slopeStats.slopeMean.toFixed(2)} ± ${D.slopeStats.slopeSd.toFixed(2)} (P5 ${D.slopeStats.slopeP5.toFixed(2)}, P95 ${D.slopeStats.slopeP95.toFixed(2)})</td></tr></table>`;
  const tested = v.walkForward.origins.filter((o) => o.median !== null);
  const smallest = tested.reduce((a, b) => (a.trainN <= b.trainN ? a : b));
  qs("#oos-wf").innerHTML = `<table><tr><th>Origin</th><th class="num">Train</th><th class="num">Test</th><th class="num">Median miss</th></tr>` +
    v.walkForward.origins.map((o) => `<tr><td>1 Jan ${o.year}</td><td class="num">${o.trainN}</td><td class="num">${o.testN}</td><td class="num">${o.median === null ? "— no comps listed before this origin" : x(o.median)}</td></tr>`).join("") + `</table>` +
    `<p class="dim">Each origin fits on comps listed before it and tests on comps listed in the 12 months after. The ${smallest.year} origin fits on only ${smallest.trainN} comps, so its miss is wide — it is shown, not hidden. ` +
    `One tension, stated plainly: the bare curve wins this check (${x(v.walkForward.pooledCurveOnly.median)} pooled against ${x(v.walkForward.pooled.median)} for the offsets). The offsets stay because leave-one-out prefers them clearly (${x(v.loo.model.median)} against ${x(f.curveOnlyLoo)}) and the time split cannot tell them apart (${x(v.timeSplit.model.median)} against ${x(v.timeSplit.curveOnly.median)}); the tuning rule picks by leave-one-out.</p>`;
  qs("#oos-abl").innerHTML = `<table><tr><th>Step</th><th class="num">LOO</th><th>Note</th></tr>` +
    v.ablation.map((a) => `<tr><td>${esc(a.step)}</td><td class="num">${a.loo === null ? "—" : x(a.loo)}</td><td>${esc(a.note)}</td></tr>`).join("") + `</table>` +
    `<p class="dim">Multiplying in the odds reorders the board: Spearman ${v.oddsRanking.spearman.toFixed(2)} against the value-if-launches order, ${v.oddsRanking.top10Overlap}/10 of the top 10 stay in the top 10. ` +
    `Forward TVL costs a little leave-one-out accuracy (${x(v.ablation[1].loo)} → ${x(v.ablation[2].loo)}) and stays in the model anyway: the bounty asks the value to follow the seven-day growth, and a protocol growing fast is worth more than its TVL today.</p>`;
  qs("#oos-tune").innerHTML = `<table><tr><th>k</th><th class="num">min n = 2</th><th class="num">min n = 3</th></tr>` +
    [3, 5, 10, 20, 40].map((k) => {
      const g = (m) => f.tuningGrid.find((t) => t.k === k && t.minN === m);
      const mark = (t) => (t.k === f.k && t.minN === f.minN ? " ★ chosen" : "");
      return `<tr><td>${k}</td><td class="num">${x(g(2).loo)}${mark(g(2))}</td><td class="num">${x(g(3).loo)}${mark(g(3))}</td></tr>`;
    }).join("") + `</table>` +
    `<p class="dim">Curve-only LOO ${x(f.curveOnlyLoo)}. Rule: the smallest LOO wins; among settings within 1% of it, the most-shrunk (largest k) wins — heavier shrinkage holds up better walk-forward. Chosen: k=${f.k}, min n=${f.minN}.</p>`;
  // Scatter: log TVL vs log cap, fitted line, board implied values.
  const SCATTER_TOP = 60;
  const W = 640, H = 260, Pd = 34;
  const xs = D.comparables.map((c) => Math.log10(c.tvl)), ys = D.comparables.map((c) => Math.log10(c.mcap));
  const x0 = Math.min(...xs) - 0.2;
  const x1 = Math.max(...xs) + 0.2;
  const y0 = Math.min(...ys) - 0.3, y1 = Math.max(...ys) + 0.3;
  const X = (v2) => Pd + ((v2 - x0) / (x1 - x0)) * (W - 2 * Pd);
  const Y = (v2) => H - Pd - ((v2 - y0) / (y1 - y0)) * (H - 2 * Pd);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Log TVL against log market cap with the fitted line">`;
  s += `<line x1="${X(x0)}" y1="${Y(f.intercept + f.slope * x0)}" x2="${X(x1)}" y2="${Y(f.intercept + f.slope * x1)}" stroke="#f0b23e" stroke-width="2"/>`;
  for (const c of D.comparables) s += `<circle cx="${X(Math.log10(c.tvl)).toFixed(1)}" cy="${Y(Math.log10(c.mcap)).toFixed(1)}" r="2.4" fill="#3ecf8e" opacity="0.7"/>`;
  for (const r of D.rows.slice(0, SCATTER_TOP)) s += `<circle cx="${X(Math.log10(r.tvl_usd)).toFixed(1)}" cy="${Y(Math.log10(r.implied_value_usd)).toFixed(1)}" r="2.4" fill="#38b6c9" opacity="0.85"/>`;
  s += `<text x="${Pd}" y="${H - 8}" fill="#93a3bd" font-size="10">log TVL →</text><text x="6" y="${Pd}" fill="#93a3bd" font-size="10">log value</text></svg>`;
  s += `<p class="dim">Mint: ${f.allComps} traded tokens. Teal: the board's top ${SCATTER_TOP} implied values. Amber: the fitted curve (slope ${f.slope.toFixed(2)}).</p>`;
  qs("#scatter").innerHTML = s;
})();

/* ---- Method note ---- */
(function renderMethod() {
  const f = D.fit, o = D.odds;
  const gasTxt = Object.entries(P.gas)
    .map(([c, g]) => c + " $" + (g >= 1 ? g : g.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")))
    .join(", ") + ", other chains $" + P.gasFallback;
  qs("#method-body").innerHTML =
    `<p><b>The model.</b> log market cap = ${f.intercept.toFixed(2)} + ${f.slope.toFixed(2)} × log TVL, fitted by least squares on the ${f.n} traded tokens with a listing date (residual RMSE ${f.rmse.toFixed(2)} in log-ten). Value grows with roughly the square root of size. Family offsets are the median residual per category, shrunk by n / (n + ${f.k}) and capped at ±0.5 log units; categories with fewer than ${f.minN} comps get no offset. Forward TVL carries the snapshot TVL by the 7-day change, clamped to ±20%. The ${f.undatedComps} traded tokens without a listing date are not fitted on, but they anchor the nearest-comparable lists.</p>` +
    `<p><b>Launch odds.</b> Implied value = value if it launches × launch odds. Odds = a category base rate × an age factor, clamped to 5–90%. The base rate is the share of the category's protocols that record a token (market cap, CoinGecko id or symbol set), Beta-shrunk toward the global rate (${o.globalLaunched}/${o.globalTotal} = ${pct(o.globalRate)}) with 10 pseudo-counts. The age factor is the token rate of the protocol's age bucket divided by the token rate of all dated protocols (${pct(o.datedRate)}): ` +
    o.buckets.map((b) => `${b.label} ${b.launched}/${b.total} (${pct(b.rate)}, ×${b.factor.toFixed(2)})`).join(", ") +
    `. Protocols with no listing date take a factor of 1. The odds are a base rate from the snapshot's own counts, not a prediction about any one protocol.</p>` +
    `<p><b>What was dropped, and why.</b> No seasoning multiplier and no sibling discount: both were untestable knobs, and the age effect now lives in the odds, where the snapshot can measure it. A same-name traded token is flagged in the detail view instead of priced.</p>` +
    `<p><b>Farm economics.</b> Gas per transaction (mid-November 2026): ${gasTxt}. ${P.txPerPlan} transactions per plan; weekly check-ins cost time, not gas. The farmer's slice is deposit / TVL, capped at ${pct(P.sliceCap, 1)}. The expected airdrop is implied value × drop share × slice (default ${pct(P.defaultShare)}; the researched range for DeFi airdrops is 5–15% of supply). Forgone yield is deposit × ${(P.tbill * 100).toFixed(2)}% (three-month T-bill, 13 November 2026) × ${P.planWeeks} weeks. Exit cost is square-root slippage on a ${pct(P.floatAtLaunch)} initial float at ${pct(P.dailyTurnover)} daily turnover. Verdicts: FARM when net clears $${P.farmLine}, MARGINAL when net is $0–$${P.farmLine}, SKIP when net is negative. The plan takes ${P.planHours} hours over ${P.planWeeks} weeks.</p>` +
    `<p><b>Coverage.</b> ${D.counts.ranked} protocols ranked (all ${D.counts.watchlist} watchlist protocols, plus ${D.counts.ranked - D.counts.watchlist} below the floor or off the watchlist), ${D.counts.trading} kept apart as trading, ${D.counts.setAside} set aside with reasons, summing to ${D.counts.total}. Rankable means: no token recorded (market cap, CoinGecko id and symbol all null), not in an excluded category, no version marker at the end of the name, no whole word wrapped, staked or staking, and not beginning with an exchange's name.</p>` +
    `<p><b>Limits.</b> An implied value is this entry's own claim, never a price. A protocol "records no token" in this snapshot; it may still have a token its DeFiLlama record does not carry. The curve's residual spread is wide (RMSE ${f.rmse.toFixed(2)} in log-ten), so the rank ranges are wide too — that is the honest width. The walk-forward and time-split checks sort comps by listing date but price them at today's TVL and cap, because the snapshot is one cross-section. Nothing here is financial advice.</p>` +
    `<p><b>Determinism.</b> The program is run twice and both runs write identical bytes: fixed seeds everywhere, no clocks, no randomness. The curve above is recomputed in this page from the comparables and checked against the program's fit.</p>`;
})();

/* ---- Traded + set-aside tables ---- */
qs("#traded-sum").textContent = D.counts.trading + " protocols already record a token — the comparables, kept apart from the board";
qs("#traded tbody").innerHTML = D.traded.map((t) => `<tr><td><b>${esc(t.name)}</b><br><span class="dim">${esc(t.slug)}</span></td><td>${esc(t.category)}</td><td class="num">${money(t.tvl)}</td><td class="num">${t.mcap == null ? "—" : money(t.mcap)}</td><td class="num">${t.mcap == null ? "—" : (t.mcap / t.tvl).toFixed(2) + "×"}</td></tr>`).join("");
qs("#aside-sum").textContent = D.counts.setAside + " tokenless protocols set aside by the house rule, each with its reason";
qs("#aside tbody").innerHTML = D.setAside.map((t) => `<tr><td><b>${esc(t.name)}</b><br><span class="dim">${esc(t.slug)}</span></td><td>${esc(t.category)}</td><td class="num">${money(t.tvl)}</td><td>${esc(t.reason)}</td></tr>`).join("");

/* ---- Recompute check + first render ---- */
qs("#recompute").textContent = (fitOk && valuesOk === D.rows.length && econOk)
  ? `✓ Recomputed in this page: the curve (slope ${fitHere.slope.toFixed(4)}, RMSE ${fitHere.rmse.toFixed(3)}), all ${valuesOk}/${D.rows.length} implied values (value-if-launches × odds), and the default farm economics match the program's output.`
  : `⚠ Recompute mismatch: curve ${fitOk ? "ok" : "DIFFERS"}, implied values ${valuesOk}/${D.rows.length}, economics ${econOk ? "ok" : "DIFFER"}.`;
if (!(fitOk && valuesOk === D.rows.length && econOk)) qs("#recompute").classList.add("bad");
renderKpis();
renderTabs();
renderBoard();

/* ---- Deep links: #detail/<slug>, #verdict/<FARM|MARGINAL|SKIP>, #watchlist, #oos ---- */
(function deepLink() {
  const h = location.hash || "";
  const mD = /^#detail\/([a-z0-9-]+)$/.exec(h);
  if (mD) { openDetail(mD[1]); qs("#detail-panel").scrollIntoView(); return; }
  const mV = h.match(/^#verdict\/(FARM|MARGINAL|SKIP)$/);
  if (mV) { verdictTab = mV[1]; renderTabs(); renderBoard(); return; }
  if (h === "#watchlist") { verdictTab = "WATCH"; renderTabs(); renderBoard(); return; }
  if (h === "#oos") { qs("#oos").scrollIntoView(); }
})();
})();
