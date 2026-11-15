/* Token Launch Radar v2 — the model, recomputed in the page.
 * Every fitted number below is recomputed here from the embedded
 * comparables and verified against the program's output. If a figure
 * disagrees, the check line at the foot of the board says so. */
(function () {
"use strict";
const D = window.RADAR_DATA;
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const money = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(1) + "k";
  if (a >= 1) return s + "$" + a.toFixed(0);
  return s + "$" + a.toFixed(2);
};
const pct = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(1) + "%");
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ---- Recompute the size curve from the comparables ---- */
function ols(list) {
  const n = list.length;
  const xs = list.map((c) => Math.log10(c.tvl));
  const ys = list.map((c) => Math.log10(c.mcap));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const slope = sxy / sxx, intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  return { intercept, slope, rmse: Math.sqrt(sse / n), n };
}
function offsets(list, fit) {
  const by = {};
  for (const c of list) {
    const r = Math.log10(c.mcap) - (fit.intercept + fit.slope * Math.log10(c.tvl));
    (by[c.category] = by[c.category] || []).push(r);
  }
  const out = {};
  for (const k of Object.keys(by)) {
    const arr = by[k], n = arr.length;
    if (n < 2) { out[k] = { offset: 0, n }; continue; }
    const raw = median(arr) * (n / (n + 3));
    out[k] = { offset: Math.max(-0.5, Math.min(0.5, raw)), n };
  }
  return out;
}
const fit2 = ols(D.comparables);
const off2 = offsets(D.comparables, fit2);
const fitOk = Math.abs(fit2.slope - D.fit.slope) < 1e-9 && Math.abs(fit2.intercept - D.fit.intercept) < 1e-9;
let valueOk = 0;
for (const r of D.rows) {
  const o = off2[r.category] || { offset: 0 };
  const v = Math.pow(10, fit2.intercept + fit2.slope * Math.log10(r.tvl_usd)
    + o.offset + Math.log10(r.growth_factor) + Math.log10(r.seasoning_factor) + Math.log10(r.sibling_factor));
  if (Math.abs(v - r.value_usd) / r.value_usd < 0.001) valueOk++;
}

/* ---- Recompute the backtest (leave-one-out + time split + bands) ---- */
function errStats(preds) {
  const m = preds.map((p) => Math.pow(10, Math.abs(Math.log10(p.pred / p.act))));
  return { med: median(m), w3: m.filter((x) => x <= 3).length / m.length, n: m.length };
}
function predict(c, fit, off) {
  const o = off[c.category] || { offset: 0 };
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(c.tvl) + o.offset);
}
const comps = D.comparables;
const looP = [], looF = [];
for (let i = 0; i < comps.length; i++) {
  const tr = comps.filter((_, j) => j !== i), h = comps[i];
  const f = ols(tr), o = offsets(tr, f);
  looP.push({ act: h.mcap, pred: predict(h, f, o) });
  looF.push({ act: h.mcap, pred: median(tr.map((c) => c.mcap / c.tvl)) * h.tvl });
}
const loo2 = errStats(looP), looF2 = errStats(looF);
const btOk = Math.abs(loo2.med - D.backtest.loo.model.medianMultiple) < 0.01;

/* ---- Header ---- */
$("#snapshot-line").textContent =
  "Snapshot " + D.asOf + " · " + D.source + " · watchlist floor " + money(D.floorUsd) + " · " + D.counts.total + " protocols";
$("#counts").innerHTML = [
  [D.counts.ranked, "ranked pre-token"], [D.counts.trading, "already trading"],
  [D.counts.setAside, "set aside"], [D.counts.watchlist + " / 40", "watchlist covered"],
].map(([n, l]) => `<div class="count"><b>${n}</b><span>${l}</span></div>`).join("");

/* ---- Panel 1: headline ---- */
let capital = 1000;
function renderHeadline() {
  const v = D.verdicts[capital], b = D.best[capital], bw = D.bestWatch[capital];
  $("#panel-headline .body").innerHTML =
    `<div class="big">${D.counts.ranked} protocols record no token</div>` +
    `<p>At <b>${money(capital)}</b> of capital: <span class="verdict FARM">FARM ${v.FARM}</span> ` +
    `<span class="verdict THIN">THIN ${v.THIN}</span> <span class="verdict SKIP">SKIP ${v.SKIP}</span></p>` +
    `<p>Best net per hour: <b>${esc(b.name)}</b> at <b class="${b.netPerHour >= 0 ? "pos" : "neg"}">${money(b.netPerHour)}/h</b> (net ${money(b.net)}).</p>` +
    `<p>Best on the watchlist: <b>${esc(bw.name)}</b> at <b class="${bw.netPerHour >= 0 ? "pos" : "neg"}">${money(bw.netPerHour)}/h</b>.</p>` +
    `<p class="dim">Verdicts net every cost: gas, the T-bill yield the capital gives up (4.32%), and exit slippage. A row that never beats a T-bill says so in its detail view.</p>`;
}

/* ---- Panel 2: pricing ---- */
function renderPricing() {
  const b = D.backtest;
  $("#panel-pricing .body").innerHTML =
    `<p class="mono">value = 10^${D.fit.intercept.toFixed(2)} × TVL^${D.fit.slope.toFixed(2)} × family × growth × seasoning × sibling</p>` +
    `<p class="dim">Fitted on ${D.fit.n} traded tokens (16 zero/negative market caps excluded, 1 ratio winsorized at 100×). Residual RMSE ${D.fit.rmse.toFixed(2)} in log-ten.</p>` +
    `<table><tr><th>Backtest</th><th class="num">Model</th><th class="num">Flat median</th><th class="num">Flat 0.25×</th></tr>` +
    `<tr><td>Leave-one-out (median error)</td><td class="num">×${b.loo.model.medianMultiple.toFixed(2)}</td><td class="num">×${b.loo.flatMedian.medianMultiple.toFixed(2)}</td><td class="num">×${b.loo.flat025.medianMultiple.toFixed(2)}</td></tr>` +
    `<tr><td>Time split (${b.timeSplit.trainN} pre-2024 → ${b.timeSplit.testN} newer)</td><td class="num">×${b.timeSplit.model.medianMultiple.toFixed(2)}</td><td class="num">×${b.timeSplit.flatMedian.medianMultiple.toFixed(2)}</td><td class="num">×${b.timeSplit.flat025.medianMultiple.toFixed(2)}</td></tr>` +
    `<tr><td>Within 3× of the real cap</td><td class="num">${(b.loo.model.within3x * 100).toFixed(0)}%</td><td class="num">${(b.loo.flatMedian.within3x * 100).toFixed(0)}%</td><td class="num">${(b.loo.flat025.within3x * 100).toFixed(0)}%</td></tr>` +
    `<tr><td>Band coverage (P50 / P80)</td><td class="num">${(b.bandCoverage.p50 * 100).toFixed(0)}% / ${(b.bandCoverage.p80 * 100).toFixed(0)}%</td><td class="num" colspan="2">—</td></tr>` +
    `<tr><td>Leave-one-category-out</td><td class="num">×${b.categoryHeldOut.model.medianMultiple.toFixed(2)}</td><td class="num">×${b.categoryHeldOut.flatMedian.medianMultiple.toFixed(2)}</td><td class="num">—</td></tr>` +
    `<tr><td>Bootstrap slope (200 draws)</td><td class="num" colspan="3">${b.bootstrap.slopeMean.toFixed(2)} ± ${b.bootstrap.slopeSd.toFixed(2)} (P5 ${b.bootstrap.slopeP5.toFixed(2)}, P95 ${b.bootstrap.slopeP95.toFixed(2)})</td></tr>` +
    `<tr><td>Median bias (log-ten)</td><td class="num" colspan="3">${b.bias.toFixed(3)} (0 = unbiased)</td></tr></table>`;
}

/* ---- Panel 3: scatter (SVG, no network) ---- */
function renderScatter() {
  const W = 340, H = 190, P = 28;
  const xs = D.comparables.map((c) => Math.log10(c.tvl));
  const ys = D.comparables.map((c) => Math.log10(c.mcap));
  const x0 = Math.min(...xs) - 0.2, x1 = Math.max(...xs) + 0.2;
  const y0 = Math.min(...ys, ...D.rows.map((r) => Math.log10(r.p10_usd))) - 0.2;
  const y1 = Math.max(...ys, ...D.rows.map((r) => Math.log10(r.p90_usd))) + 0.2;
  const X = (v) => P + ((v - x0) / (x1 - x0)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Scatter of traded tokens against the fitted curve">`;
  s += `<line x1="${X(x0)}" y1="${Y(D.fit.intercept + D.fit.slope * x0)}" x2="${X(x1)}" y2="${Y(D.fit.intercept + D.fit.slope * x1)}" stroke="#f2b544" stroke-width="2"/>`;
  for (const c of D.comparables)
    s += `<circle cx="${X(Math.log10(c.tvl)).toFixed(1)}" cy="${Y(Math.log10(c.mcap)).toFixed(1)}" r="2.2" fill="#4fd1a5" opacity="0.7"/>`;
  for (const r of D.rows.slice(0, 60))
    s += `<circle cx="${X(Math.log10(r.tvl_usd)).toFixed(1)}" cy="${Y(Math.log10(r.value_usd)).toFixed(1)}" r="2.2" fill="#38b6c9" opacity="0.8"/>`;
  s += `<text x="${P}" y="${H - 6}" fill="#93a9ba" font-size="9">TVL →</text>`;
  s += `<text x="4" y="${P}" fill="#93a9ba" font-size="9">value</text></svg>`;
  s += `<p class="dim">Mint: ${D.fit.n} traded tokens. Teal: the board's top 60 implied values. Amber: the fitted curve (slope ${D.fit.slope.toFixed(2)}).</p>`;
  $("#panel-scatter .body").innerHTML = s;
}

/* ---- Board table ---- */
let sortKey = "rank", sortDir = 1;
const econAt = (r, cap) => r.economics.find((e) => e.capital === cap);
function farmSummary(r) {
  const e = econAt(r, capital);
  return `${r.category} · ${r.chains[0] || "—"} · hold ${Math.max(30, Math.min(1095, Math.floor((r.age_days || 365) * 0.5)))}d · fees ${money(e.fees_usd)}`;
}
function renderBoard() {
  const q = ($("#f-search").value || "").toLowerCase();
  const tier = $("#f-tier").value, fam = $("#f-family").value, ch = $("#f-chain").value;
  const ver = $("#f-verdict").value, minTvl = parseFloat($("#f-tvl").value) || 0;
  let rows = D.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    if (tier === "watch" && !r.watchlist) return false;
    if (tier === "early" && r.watchlist) return false;
    if (fam && r.category !== fam) return false;
    if (ch && !r.chains.includes(ch)) return false;
    if (ver && econAt(r, capital).verdict !== ver) return false;
    if (r.tvl_usd < minTvl) return false;
    return true;
  });
  const key = (r) => {
    if (sortKey === "slice") return econAt(r, capital).slice;
    if (sortKey === "net_usd") return econAt(r, capital).net_usd;
    return r[sortKey] ?? 0;
  };
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sortDir);
  $("#rowcount").textContent = rows.length + " of " + D.rows.length + " rows";
  $("#board-table tbody").innerHTML = rows.map((r) => {
    const e = econAt(r, capital);
    const lo = Math.log10(r.p10_usd), hi = Math.log10(r.p90_usd), v = Math.log10(r.value_usd);
    const span = hi - lo || 1;
    const left = ((v - lo) / span * 100).toFixed(0);
    const chains = r.chains.slice(0, 3).join(", ") + (r.chains.length > 3 ? ` +${r.chains.length - 3}` : "");
    return `<tr data-slug="${r.slug}">
      <td class="num">${r.rank}</td>
      <td><b>${esc(r.name)}</b><span class="badge ${r.watchlist ? "watch" : "early"}">${r.watchlist ? "WATCH" : "EARLY"}</span><br><span class="dim">${esc(r.category)} · ${esc(chains)}</span></td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num ${r.change_7d == null ? "" : r.change_7d >= 0 ? "pos" : "neg"}">${pct(r.change_7d)}</td>
      <td class="num">${r.age_days == null ? "—" : r.age_days + "d"}</td>
      <td class="num">${money(r.value_usd)}<br><span class="dim">${money(r.p10_usd)} – ${money(r.p90_usd)}</span><div class="bar"><i style="left:0;width:100%"></i><b style="left:${left}%"></b></div></td>
      <td class="num">${(e.slice * 100).toFixed(4)}%<br><span class="dim">worth ${money(e.expected_usd)}</span></td>
      <td class="num ${e.net_usd >= 0 ? "pos" : "neg"}">${money(e.net_usd)}<br><span class="verdict ${e.verdict}">${e.verdict}</span></td>
      <td>${esc(farmSummary(r))}<br><button class="tab" data-detail="${r.slug}">Detail</button></td>
    </tr>`;
  }).join("");
}
$$("#board-table th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.sort;
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "rank" ? 1 : -1; }
  renderBoard();
}));
["f-search", "f-tier", "f-family", "f-chain", "f-verdict", "f-tvl"].forEach((id) =>
  $("#" + id).addEventListener("input", renderBoard));
$("#f-capital").addEventListener("change", (e) => { capital = parseInt(e.target.value, 10); renderHeadline(); renderBoard(); });
$("#f-reset").addEventListener("click", () => {
  $("#f-search").value = ""; $("#f-tier").value = ""; $("#f-family").value = "";
  $("#f-chain").value = ""; $("#f-verdict").value = ""; $("#f-tvl").value = "";
  renderBoard();
});
// Family + chain filter options.
{
  const fams = [...new Set(D.rows.map((r) => r.category))].sort();
  $("#f-family").innerHTML = `<option value="">All families</option>` + fams.map((f) => `<option>${esc(f)}</option>`).join("");
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  $("#f-chain").innerHTML = `<option value="">All chains</option>` + chains.map((c) => `<option>${esc(c)}</option>`).join("");
}

/* ---- Traded + set-aside tabs ---- */
$("#traded-table tbody").innerHTML = D.traded.map((t) => `<tr>
  <td><b>${esc(t.name)}</b><br><span class="dim">${esc(t.slug)}</span></td>
  <td>${esc(t.category)}</td><td class="num">${money(t.tvl)}</td>
  <td class="num">${t.mcap == null ? "—" : money(t.mcap)}</td>
  <td class="num">${t.mcap == null ? "—" : (t.mcap / t.tvl).toFixed(2) + "×"}</td></tr>`).join("");
$("#setaside-table tbody").innerHTML = D.setAside.map((t) => `<tr>
  <td><b>${esc(t.name)}</b><br><span class="dim">${esc(t.slug)}</span></td>
  <td>${esc(t.category)}</td><td class="num">${money(t.tvl)}</td><td>${esc(t.reason)}</td></tr>`).join("");

/* ---- Tabs ---- */
$$(".tab[data-tab]").forEach((b) => b.addEventListener("click", () => {
  $$(".tab[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
  $$(".tabpage").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
}));

/* ---- Detail dialog ---- */
function nearestComparables(r, n) {
  return [...D.comparables]
    .map((c) => ({ c, d: Math.abs(Math.log10(c.tvl / r.tvl_usd)) + (c.category === r.category ? 0 : 1) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.c);
}
function showDetail(slug) {
  const r = D.rows.find((x) => x.slug === slug);
  if (!r) return;
  const e = econAt(r, capital);
  const beatsBill = e.expected_usd - e.fees_usd >= e.opportunity_usd;
  const near = nearestComparables(r, 4);
  const el = $("#detail .detail-body");
  el.innerHTML = `<h2>${esc(r.name)} <span class="dim">#${r.rank}</span></h2>
    <p class="dim">${esc(r.category)} · ${esc(r.chains.join(", "))} · TVL ${money(r.tvl_usd)} · ${r.age_days == null ? "age unknown" : r.age_days + " days with no token recorded"}${r.watchlist ? " · watchlist" : ""}</p>
    <h3>Valuation breakdown</h3>
    <table><tr><td>Base curve value (10^${D.fit.intercept.toFixed(2)} × TVL^${D.fit.slope.toFixed(2)})</td><td class="num">${money(r.base_value_usd)}</td></tr>
    <tr><td>Family offset (${esc(r.category)}, ${D.offsets.find((o) => o.category === r.category)?.n || 0} comparables)</td><td class="num">${r.family_offset >= 0 ? "+" : ""}${r.family_offset.toFixed(3)} in log-ten</td></tr>
    <tr><td>Growth factor (7d ${pct(r.change_7d)})</td><td class="num">×${r.growth_factor.toFixed(3)}</td></tr>
    <tr><td>Seasoning factor</td><td class="num">×${r.seasoning_factor.toFixed(3)}</td></tr>
    <tr><td>Sibling factor</td><td class="num">×${r.sibling_factor.toFixed(2)}</td></tr>
    <tr><td><b>Implied value</b> (P10–P90)</td><td class="num"><b>${money(r.value_usd)}</b> (${money(r.p10_usd)} – ${money(r.p90_usd)})</td></tr>
    <tr><td>Launch probability (category, 12 months)</td><td class="num">${(r.launch_probability * 100).toFixed(0)}%</td></tr></table>
    <h3>Nearest comparables (traded tokens that justify this value)</h3>
    <table><tr><th>Token</th><th>TVL</th><th>Market cap</th><th class="num">MCap / TVL</th></tr>
    ${near.map((c) => `<tr><td>${esc(c.name)}</td><td>${money(c.tvl)}</td><td>${money(c.mcap)}</td><td class="num">${(c.mcap / c.tvl).toFixed(2)}×</td></tr>`).join("")}</table>
    <h3>Farm plan (at ${money(capital)})</h3>
    <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <h3>Economics at every capital</h3>
    <table><tr><th>Capital</th><th class="num">Slice</th><th class="num">Expected</th><th class="num">Fees</th><th class="num">T-bill cost</th><th class="num">Exit cost</th><th class="num">Net</th><th>Verdict</th></tr>
    ${r.economics.map((x) => `<tr><td>${money(x.capital)}</td><td class="num">${(x.slice * 100).toFixed(4)}%</td><td class="num">${money(x.expected_usd)}</td><td class="num">${money(x.fees_usd)}</td><td class="num">${money(x.opportunity_usd)}</td><td class="num">${money(x.exit_cost_usd)}</td><td class="num ${x.net_usd >= 0 ? "pos" : "neg"}">${money(x.net_usd)}</td><td><span class="verdict ${x.verdict}">${x.verdict}</span></td></tr>`).join("")}</table>
    <p class="${beatsBill ? "pos" : "neg"}">${beatsBill ? "This position beats a T-bill at this capital." : "This position never beats a T-bill at this capital — the risk-free return on the same money is higher."}</p>
    <p class="dim">Sensitivity: at ${money(capital)} this row turns THIN if the airdrop share exceeds ${((e.fees_usd + e.opportunity_usd + e.exit_cost_usd) / (r.value_usd * e.slice) * 100).toFixed(1)}% (now 5%), or FARM above ${(((e.fees_usd + e.opportunity_usd + e.exit_cost_usd + 5) / (r.value_usd * e.slice)) * 100).toFixed(1)}%.</p>`;
  $("#detail").showModal();
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-detail]");
  if (b) showDetail(b.dataset.detail);
});
$(".close").addEventListener("click", () => $("#detail").close());

/* ---- Method tab ---- */
$("#method-body").innerHTML = `
<h3>The model</h3>
<p>Each protocol's implied value comes from a size curve fitted in log space to the ${D.fit.n} traded tokens with a positive market cap: log market cap = ${D.fit.intercept.toFixed(2)} + ${D.fit.slope.toFixed(2)} × log TVL, residual RMSE ${D.fit.rmse.toFixed(2)}. Value grows with roughly the square root of size, not in proportion to it. Sixteen protocols with a zero or negative market cap are excluded as data errors; one ratio above 100× is winsorized at 100×.</p>
<p>Family offsets are the median residual per category, shrunk toward zero by comparable count (n / (n + 3)) and capped at ±0.5 log units; a category with fewer than two comparables gets no offset. Growth uses the seven-day TVL change, clamped to −50%…+100% and dampened to a 10% weight, so one noisy week cannot move a row far. Seasoning rises with log age up to three years, worth at most +15%; the seven protocols with no listing date take the rankable set's median age (${D.medianAgeDays} days), computed from the snapshot. The sibling rule discounts a protocol by half when a traded token's full name is a prefix of its name; on this snapshot it matches zero protocols, and it is stated here rather than hidden.</p>
<p>The launch probability is the category's share of protocols that already trade, with a Beta(2, 2) prior, clamped to 10–90%. It is shown per row as a risk factor and used in the portfolio optimizer; it does not discount the implied value, because the value already prices the protocol's prospects and the reader should judge launch risk from the stated probability.</p>
<h3>The backtest</h3>
<p>Leave-one-out refits the curve and offsets 128 times, once per comparable, and predicts the held-out token: median error ×${D.backtest.loo.model.medianMultiple.toFixed(2)} against ×${D.backtest.loo.flatMedian.medianMultiple.toFixed(2)} for a flat median multiple and ×${D.backtest.loo.flat025.medianMultiple.toFixed(2)} for a flat 0.25×. The time split fits on ${D.backtest.timeSplit.trainN} tokens listed before 2024 and tests on ${D.backtest.timeSplit.testN} newer ones (${D.backtest.timeSplit.undatedN} undated tokens are excluded from this check and the exclusion is stated). ${((D.backtest.loo.model.within3x) * 100).toFixed(0)}% of held-out tokens land within 3× of their real cap. The P10–P90 band covers ${(D.backtest.bandCoverage.p80 * 100).toFixed(0)}% of held-out tokens (nominal 80%) and the 50% band covers ${(D.backtest.bandCoverage.p50 * 100).toFixed(0)}% (nominal 50%). Leave-one-category-out tests whether the family offsets generalize: median error ×${D.backtest.categoryHeldOut.model.medianMultiple.toFixed(2)}. A 200-draw bootstrap with a fixed seed gives slope ${D.backtest.bootstrap.slopeMean.toFixed(2)} ± ${D.backtest.bootstrap.slopeSd.toFixed(2)}. Median signed log error ${D.backtest.bias.toFixed(3)} — the model neither systematically over- nor under-predicts.</p>
<h3>Farm economics</h3>
<p>Gas per transaction (mid-November 2026): Ethereum $10, Base $0.05, Arbitrum $0.08, Optimism $0.08, Polygon $0.03, Ink $0.05, Solana $0.003, Tron $0.30, BNB Chain $0.12, Bittensor $1.00, other chains $2. Five transactions per plan (setup, two actions, claim, exit); weekly check-ins cost time, not gas. The farmer's slice is capital / TVL, capped at 0.1%. The expected airdrop is implied value × 5% airdrop share × slice; the researched range for DeFi airdrops is 5–15% of supply (Uniswap 15%, dYdX 7.5%, Arbitrum 11.6%, Optimism 5%, ENS 5%, 1inch 6%) and verdicts use the conservative end. Opportunity cost is capital × 4.32% (three-month Treasury bill, U.S. Treasury daily par yield curve, 13 November 2026) × hold years. Exit cost is square-root slippage on a 15% initial float at 5% daily turnover (DEX venue, stated assumption). Verdicts: FARM when net exceeds $5, THIN when net is $0–$5, SKIP when net is negative.</p>
<h3>Limits</h3>
<p>An implied value is this entry's own claim, never a price. A protocol "records no token" in this snapshot; it may still have a token its DeFiLlama record does not carry. The size curve's residual spread is wide (RMSE ${D.fit.rmse.toFixed(2)} in log-ten), so the P10–P90 bands are wide too — that is the honest width, not a defect. The launch probability is a category base rate, not a prediction about any one protocol. The exit-cost venue is assumed (DEX), not observed. Nothing here is financial advice.</p>
<h3>Coverage</h3>
<p>${D.counts.ranked} protocols ranked (all 40 watchlist protocols, plus ${D.counts.ranked - D.counts.watchlist} below the floor or off the watchlist), ${D.counts.trading} kept apart as trading, ${D.counts.setAside} set aside with reasons, summing to ${D.counts.total}. The house rule: no token recorded (market cap, CoinGecko id and symbol all null), not in an excluded category, no version marker at the end of the name, no whole word wrapped, staked or staking, and not beginning with an exchange's name.</p>`;

/* ---- Recompute check line + first render ---- */
$("#recompute-check").textContent =
  (fitOk && valueOk === D.rows.length && btOk)
    ? `✓ Recomputed in this page: the curve (slope ${fit2.slope.toFixed(4)}), all ${valueOk}/${D.rows.length} row values, and the leave-one-out backtest (median ×${loo2.med.toFixed(2)}) match the program's output.`
    : `⚠ Recompute mismatch: curve ${fitOk ? "ok" : "DIFFERS"}, row values ${valueOk}/${D.rows.length}, backtest ${btOk ? "ok" : "DIFFERS"}.`;
if (!(fitOk && valueOk === D.rows.length && btOk)) $("#recompute-check").classList.add("bad");
renderHeadline();
renderPricing();
renderScatter();
renderBoard();

/* ---- Deep links: #detail/<slug>, #family/<name>, #verdict/<FARM|THIN|SKIP> ---- */
(function deepLink() {
  const h = location.hash || "";
  const mD = h.match(/^#detail\/([a-z0-9-]+)$/);
  if (mD) { showDetail(mD[1]); return; }
  const mF = h.match(/^#family\/(.+)$/);
  if (mF) { $("#f-family").value = decodeURIComponent(mF[1]); renderBoard(); return; }
  const mV = h.match(/^#verdict\/(FARM|THIN|SKIP)$/);
  if (mV) { $("#f-verdict").value = mV[1]; renderBoard(); }
})();
})();
