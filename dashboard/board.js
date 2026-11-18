// Token Launch Radar v4 — dashboard logic. Everything renders from
// window.RADAR_DATA (written by main.ts); no number is typed in here.
(() => {
  const D = window.RADAR_DATA;
  const EP = D.econParams;
  const qs = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const money = (n) => {
    if (n === null || n === undefined) return "—";
    const a = Math.abs(n);
    const sign = n < 0 ? "−" : "";
    if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "k";
    return sign + "$" + a.toFixed(a < 10 ? 2 : 0);
  };
  const moneyExact = (n) => {
    if (Math.abs(n) < 1 && n !== 0)
      return (n < 0 ? "−$" : "$") + Math.abs(n).toFixed(2);
    return "$" + Math.round(n).toLocaleString("en-US");
  };
  const mult = (x) => "×" + x.toFixed(2);
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  const days = (n) =>
    n === null ? "not recorded" : n + " days";

  /* ---- Farm economics, recomputed live (mirrors lib/farm.ts). ---- */
  const gasFor = (chain) => EP.gas[chain] ?? EP.gasFallback;
  function econFor(row, deposit, share) {
    const slice = Math.min(deposit / row.tvl_usd, EP.sliceCap);
    const expected = row.implied_value_usd * share * slice;
    const fees = EP.txPerPlan * gasFor(row.chains[0] ?? "Ethereum");
    const forgone = deposit * EP.tbill * (EP.planDays / 365);
    const dailyVol =
      EP.floatAtLaunch * row.implied_value_usd * EP.dailyTurnover;
    const slip =
      dailyVol > 0
        ? EP.slipK * Math.sqrt(Math.max(0, expected) / dailyVol)
        : 0;
    const exit = Math.min(expected, expected * slip);
    const net = expected - fees - forgone - exit;
    return {
      slice,
      expected,
      fees,
      forgone,
      exit,
      net,
      perHour: net / EP.planHours,
      verdict: net > EP.farmLine ? "FARM" : net > 0 ? "MARGINAL" : "SKIP",
    };
  }

  /* ---- State ---- */
  let verdictTab = "ALL";
  let query = "";
  let catSel = "";
  let chainSel = "";
  let sortSel = "rank";
  let deposit = EP.defaultDeposit;
  let share = EP.defaultShare;

  /* ---- Header + KPI strip ---- */
  qs("#snap-line").textContent =
    `Snapshot ${D.asOf} · ${D.counts.total} protocols · ` +
    `${D.fit.datedComps} dated comparables fit the curve · ` +
    `odds from a ridge-logit on all ${D.counts.total}`;
  const v = D.validation;
  const o = D.odds.calibration;
  const multBrier = o.baselines.find((b) =>
    b.name.startsWith("Multiplicative"),
  ).brier;
  const kpis = [
    [
      String(D.counts.total),
      `${D.counts.ranked} ranked · ${D.counts.trading} already trading · ${D.counts.setAside} set aside — every protocol accounted for`,
    ],
    [
      mult(v.loo.nested.median),
      `leave-one-out, nested tuning (flat ${mult(v.loo.flat.median)}; flat-median baseline ${mult(v.loo.flatMedian.median)})`,
    ],
    [
      mult(v.walkForward.nested.pooled.median),
      `walk-forward, 5 yearly origins (4 scored), nested tuning (flat ${mult(v.walkForward.flat.median)})`,
    ],
    [
      o.brier.toFixed(4),
      `launch-odds Brier, 5-fold cross-fitted (multiplicative ${multBrier.toFixed(4)}; AUC ${o.auc.toFixed(3)}, ECE ${o.ece.toFixed(3)})`,
    ],
    [
      String(D.verdictsDefault.FARM),
      `FARM at $${EP.defaultDeposit.toLocaleString("en-US")} / ${(EP.defaultShare * 100).toFixed(0)}% drop (${D.verdictsDefault.MARGINAL} marginal, ${D.verdictsDefault.SKIP} skip)`,
    ],
    [
      money(D.rows[0].implied_value_usd),
      `#1 ${D.rows[0].name} — implied value after odds, rank range ${D.rows[0].rank_lo}–${D.rows[0].rank_hi} over ${D.slopeStats.draws} refits`,
    ],
  ];
  qs("#kpis").innerHTML = kpis
    .map(([b, s]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(s)}</span></div>`)
    .join("");

  /* ---- Verdict tabs ---- */
  function verdictCounts() {
    const c = { FARM: 0, MARGINAL: 0, SKIP: 0, WATCH: 0 };
    for (const r of D.rows) {
      c[econFor(r, deposit, share).verdict] += 1;
      if (r.watchlist) c.WATCH += 1;
    }
    return c;
  }
  function renderTabs() {
    const c = verdictCounts();
    const tabs = [
      ["ALL", `All (${D.rows.length})`],
      ["FARM", `FARM (${c.FARM})`],
      ["MARGINAL", `Marginal (${c.MARGINAL})`],
      ["SKIP", `Skip (${c.SKIP})`],
      ["WATCH", `Watchlist (${c.WATCH})`],
    ];
    qs("#verdict-tabs").innerHTML = tabs
      .map(
        ([k, label]) =>
          `<button type="button" data-tab="${k}" class="${k === verdictTab ? "on" : ""}">${esc(label)}</button>`,
      )
      .join("");
    qs("#verdict-tabs")
      .querySelectorAll("button")
      .forEach((b) =>
        b.addEventListener("click", () => {
          verdictTab = b.dataset.tab;
          renderTabs();
          renderBoard();
        }),
      );
  }

  /* ---- Board table ---- */
  function visibleRows() {
    const q = query.trim().toLowerCase();
    let rows = D.rows.filter((r) => {
      if (verdictTab === "WATCH" && !r.watchlist) return false;
      if (
        verdictTab !== "ALL" &&
        verdictTab !== "WATCH" &&
        econFor(r, deposit, share).verdict !== verdictTab
      )
        return false;
      if (catSel && r.category !== catSel) return false;
      if (chainSel && !r.chains.includes(chainSel)) return false;
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !r.slug.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
    const key = {
      rank: (r) => r.rank,
      implied_value_usd: (r) => -r.implied_value_usd,
      value_if_launches_usd: (r) => -r.value_if_launches_usd,
      tvl_usd: (r) => -r.tvl_usd,
      launch_odds: (r) => -r.launch_odds,
      net: (r) => -econFor(r, deposit, share).net,
      perhour: (r) => -econFor(r, deposit, share).perHour,
    }[sortSel];
    rows = [...rows].sort((a, b) => key(a) - key(b) || a.rank - b.rank);
    return rows;
  }
  function renderBoard() {
    const rows = visibleRows();
    qs("#row-count").textContent = `${rows.length} of ${D.rows.length} rows`;
    qs("#board tbody").innerHTML = rows
      .map((r) => {
        const e = econFor(r, deposit, share);
        return `<tr data-slug="${esc(r.slug)}"><td class="num">${r.rank}</td>` +
          `<td><b>${esc(r.name)}</b><span class="sub">${esc(r.category)}${r.watchlist ? " · ★ watchlist" : ""}${r.same_name_trades ? " · ⚠ same name trades" : ""}</span></td>` +
          `<td>${money(r.tvl_usd)}</td><td>${money(r.value_if_launches_usd)}</td>` +
          `<td>${pct(r.launch_odds, 0)}</td><td><b>${money(r.implied_value_usd)}</b></td>` +
          `<td>${r.rank_lo}–${r.rank_hi}</td>` +
          `<td>${money(e.net)}</td><td>${money(e.perHour)}/h</td>` +
          `<td><span class="pill ${e.verdict}">${e.verdict}</span></td></tr>`;
      })
      .join("");
    qs("#board tbody")
      .querySelectorAll("tr")
      .forEach((tr) =>
        tr.addEventListener("click", () => openDetail(tr.dataset.slug)),
      );
  }

  /* ---- Controls ---- */
  const cats = [...new Set(D.rows.map((r) => r.category))].sort();
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  qs("#cat").innerHTML =
    `<option value="">All categories</option>` +
    cats.map((c) => `<option>${esc(c)}</option>`).join("");
  qs("#chain").innerHTML =
    `<option value="">All chains</option>` +
    chains.map((c) => `<option>${esc(c)}</option>`).join("");
  qs("#q").addEventListener("input", (e) => {
    query = e.target.value;
    renderBoard();
  });
  qs("#cat").addEventListener("change", (e) => {
    catSel = e.target.value;
    renderBoard();
  });
  qs("#chain").addEventListener("change", (e) => {
    chainSel = e.target.value;
    renderBoard();
  });
  qs("#sort").addEventListener("change", (e) => {
    sortSel = e.target.value;
    renderBoard();
  });
  qs("#deposit").addEventListener("change", (e) => {
    deposit = Number(e.target.value);
    renderTabs();
    renderBoard();
    if (!qs("#detail-panel").hidden) openDetail(qs("#detail-panel").dataset.slug);
  });
  qs("#share").addEventListener("change", (e) => {
    share = Number(e.target.value);
    renderTabs();
    renderBoard();
    if (!qs("#detail-panel").hidden) openDetail(qs("#detail-panel").dataset.slug);
  });
  qs("#reset").addEventListener("click", () => {
    verdictTab = "ALL";
    query = "";
    catSel = "";
    chainSel = "";
    sortSel = "rank";
    deposit = EP.defaultDeposit;
    share = EP.defaultShare;
    qs("#q").value = "";
    qs("#cat").value = "";
    qs("#chain").value = "";
    qs("#sort").value = "rank";
    qs("#deposit").value = String(EP.defaultDeposit);
    qs("#share").value = String(EP.defaultShare);
    renderTabs();
    renderBoard();
  });
  qs("#detail-close").addEventListener("click", () => {
    qs("#detail-panel").hidden = true;
  });

  /* ---- Detail view: full decomposition, farm plan, sensitivity. ---- */
  function closestComps(row, n) {
    return [...D.comparables]
      .map((c) => ({
        c,
        d:
          Math.abs(Math.log10(c.tvl / row.tvl_usd)) +
          (c.category === row.category ? 0 : 1),
      }))
      .sort((a, b) => a.d - b.d || a.c.slug.localeCompare(b.c.slug))
      .slice(0, n)
      .map((x) => x.c);
  }
  function openDetail(slug) {
    const r = D.rows.find((x) => x.slug === slug);
    if (!r) return;
    const panel = qs("#detail-panel");
    panel.dataset.slug = slug;
    panel.hidden = false;
    const e = econFor(r, deposit, share);
    qs("#detail-title").textContent =
      `#${r.rank} ${r.name} — ${r.category} · ${r.chains.join(", ")}`;
    const logOdds =
      D.odds.intercept + r.cat_effect + r.age_effect;
    const sig = 1 / (1 + Math.exp(-logOdds));
    const flags = [];
    if (r.watchlist) flags.push("★ on the watchlist");
    if (r.same_name_trades)
      flags.push(
        "⚠ a traded protocol shares this name — the radar prices the tokenless protocol only; check before farming",
      );
    if (r.age_days === null)
      flags.push(
        "no listing date is recorded, so the odds take no age term (the intercept already reflects undated protocols)",
      );
    const grid = EP.deposits
      .map(
        (d) =>
          `<tr><td>${moneyExact(d)}</td>${EP.shares
            .map((s) => `<td>${money(econFor(r, d, s).net)}</td>`)
            .join("")}</tr>`,
      )
      .join("");
    qs("#detail-body").innerHTML =
      (flags.length
        ? `<p class="flag">${flags.map(esc).join("<br>")}</p>`
        : "") +
      `<div class="detail-grid"><div><h3>Pricing — curve to implied value</h3><table><tbody>` +
      `<tr><td>TVL</td><td>${moneyExact(r.tvl_usd)}</td></tr>` +
      `<tr><td>7-day change</td><td>${r.change_7d === null ? "not recorded" : (r.change_7d >= 0 ? "+" : "") + r.change_7d.toFixed(1) + "%"}</td></tr>` +
      `<tr><td>Forward TVL (change carried forward, ±20%)</td><td>${moneyExact(r.forward_tvl_usd)}</td></tr>` +
      `<tr><td>Curve value — 10^(${D.fit.intercept.toFixed(3)} + ${D.fit.slope.toFixed(3)} · log₁₀ forward TVL)</td><td>${moneyExact(r.curve_value_usd)}</td></tr>` +
      `<tr><td>Family offset, ${esc(r.category)} (${r.family_n} comps, ${r.family_offset >= 0 ? "+" : ""}${r.family_offset.toFixed(3)} in log₁₀)</td><td>×${Math.pow(10, r.family_offset).toFixed(2)}</td></tr>` +
      `<tr><td><b>Value if it launches</b></td><td><b>${moneyExact(r.value_if_launches_usd)}</b></td></tr>` +
      `<tr><td>Launch odds (logit, below)</td><td>${pct(r.launch_odds)}</td></tr>` +
      `<tr><td><b>Implied value</b></td><td><b>${moneyExact(r.implied_value_usd)}</b></td></tr>` +
      `<tr><td>Rank range over ${D.slopeStats.draws} bootstrap refits</td><td>${r.rank_lo}–${r.rank_hi}</td></tr>` +
      `</tbody></table></div>` +
      `<div><h3>Launch odds — the logit, opened up</h3><table><tbody>` +
      `<tr><td>Intercept (all ${D.counts.total} protocols)</td><td>${D.odds.intercept >= 0 ? "+" : ""}${D.odds.intercept.toFixed(3)}</td></tr>` +
      `<tr><td>Category effect, ${esc(r.category)}</td><td>${r.cat_effect >= 0 ? "+" : ""}${r.cat_effect.toFixed(3)}</td></tr>` +
      `<tr><td>Age effect, ${esc(r.age_bucket)}${r.age_days === null ? "" : ` (${days(r.age_days)})`}</td><td>${r.age_effect >= 0 ? "+" : ""}${r.age_effect.toFixed(3)}</td></tr>` +
      `<tr><td>Log-odds</td><td>${logOdds.toFixed(3)}</td></tr>` +
      `<tr><td>Sigmoid (clamped to 5%–90%)</td><td>${pct(sig)}${Math.abs(sig - r.launch_odds) > 0.001 ? ` → clamped to ${pct(r.launch_odds)}` : ""}</td></tr>` +
      `<tr><td>Typical wait from listing to token, traded protocols</td><td>${D.odds.typicalWaitDays} days</td></tr>` +
      `</tbody></table>` +
      `<h3 style="margin-top:16px">Nearest traded comparables</h3><table><tbody>` +
      closestComps(r, 5)
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}<span class="sub">${esc(c.category)}${c.dated ? "" : " · undated"}</span></td><td>${money(c.tvl)} TVL</td><td>${money(c.mcap)} cap</td></tr>`,
        )
        .join("") +
      `</tbody></table></div></div>` +
      `<div class="detail-grid"><div><h3>Farm economics — ${moneyExact(deposit)} at a ${(share * 100).toFixed(1)}% drop, ${EP.planWeeks}-week plan</h3><table><tbody>` +
      `<tr><td>Slice of the pool (capped at ${pct(EP.sliceCap, 2)})</td><td>${pct(e.slice, 4)}</td></tr>` +
      `<tr><td>Expected drop, if it launches</td><td>${moneyExact(e.expected)}</td></tr>` +
      `<tr><td>Fees — ${EP.txPerPlan} transactions on ${esc(r.chains[0] ?? "Ethereum")} at ${money(gasFor(r.chains[0] ?? "Ethereum"))} each</td><td>−${moneyExact(e.fees)}</td></tr>` +
      `<tr><td>Forgone T-bill yield (${pct(EP.tbill)} over ${EP.planDays} days)</td><td>−${moneyExact(e.forgone)}</td></tr>` +
      `<tr><td>Exit slippage (${pct(EP.floatAtLaunch, 0)} float, ${pct(EP.dailyTurnover, 0)} daily turnover)</td><td>−${moneyExact(e.exit)}</td></tr>` +
      `<tr><td><b>Net</b></td><td><b>${moneyExact(e.net)}</b> (${money(e.perHour)}/hour over ${EP.planHours} hours)</td></tr>` +
      `<tr><td>Verdict</td><td><span class="pill ${e.verdict}">${e.verdict}</span></td></tr>` +
      `<tr><td>Break-even deposit at a ${(EP.defaultShare * 100).toFixed(0)}% drop</td><td>${r.break_even_usd === null ? "never — no deposit breaks even" : moneyExact(r.break_even_usd)}</td></tr>` +
      `</tbody></table></div>` +
      `<div><h3>Net, by deposit and drop share</h3><table><thead><tr><th>Deposit</th>${EP.shares.map((s) => `<th>${(s * 100).toFixed(1)}% drop</th>`).join("")}</tr></thead><tbody>${grid}</tbody></table>` +
      `<p class="dim" style="margin-top:10px">The grid re-prices the same plan at other deposits and drop shares — the verdict at the top of the page follows the selectors, not this grid.</p></div></div>` +
      `<h3 style="margin-top:18px">Farm plan — ${EP.planWeeks} weeks, ${EP.planHours} hours</h3><ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---- Out-of-sample panel ---- */
  qs("#oos-intro").textContent =
    `The shrinkage is re-tuned INSIDE every check (nested tuning): per held-out comp for leave-one-out, per origin for walk-forward, on the pre-2024 set for the time split. ` +
    `The flat numbers beside them tune once on the full set and reuse that k — they flatter leave-one-out and are shown so the tuning optimism is visible, not hidden. ` +
    `Median miss is the median |log₁₀ error| as a multiple: ×1 is exact, ×2 means the prediction is typically within a factor of two.`;
  const ms = (s) =>
    `${mult(s.median)} (mean ${mult(s.mean)}, ${pct(s.within2x, 0)} within ×2, n=${s.n})`;
  qs("#oos-head").innerHTML =
    `<table><tbody>` +
    `<tr><td>Leave-one-out, nested</td><td>${ms(v.loo.nested)}</td></tr>` +
    `<tr><td>Leave-one-out, flat (k=${D.fit.k})</td><td>${ms(v.loo.flat)}</td></tr>` +
    `<tr><td>Leave-one-out, fair — dated fit on all ${D.fit.allComps} comps</td><td>${ms(v.looFair)}</td></tr>` +
    `<tr><td>Walk-forward, nested (4 of 5 origins scored)</td><td>${ms(v.walkForward.nested.pooled)}</td></tr>` +
    `<tr><td>Walk-forward, flat</td><td>${ms(v.walkForward.flat)}</td></tr>` +
    `<tr><td>Time split, nested (fit pre-2024, test ${v.timeSplit.testN} post-2024)</td><td>${ms(v.timeSplit.nested)}</td></tr>` +
    `<tr><td>Leave-one-category-out</td><td>${ms(v.loco.pooled)}</td></tr>` +
    `<tr><td>Baseline: flat global median multiple</td><td>${ms(v.loo.flatMedian)}</td></tr>` +
    `<tr><td>Baseline: flat 0.25× TVL</td><td>${ms(v.loo.flat025)}</td></tr>` +
    `<tr><td>Band coverage (empirical LOO quantiles)</td><td>P50 ${pct(v.bands.p50)} / P80 ${pct(v.bands.p80)} (n=${v.bands.n})</td></tr>` +
    `<tr><td>Band half-widths</td><td>P50 ${mult(v.bands.halfWidth50x)} · P80 ${mult(v.bands.halfWidth80x)} · P90 ${mult(v.bands.halfWidth90x)}</td></tr>` +
    `<tr><td>Median bias (signed log₁₀ error)</td><td>${v.bias >= 0 ? "+" : ""}${v.bias.toFixed(4)} — the curve ${v.bias < 0 ? "under" : "over"}-predicts by ${pct(Math.pow(10, Math.abs(v.bias)) - 1, 1)}</td></tr>` +
    `<tr><td>Slope over ${D.slopeStats.draws} bootstrap refits</td><td>mean ${D.slopeStats.slopeMean.toFixed(3)} ± ${D.slopeStats.slopeSd.toFixed(3)}, P5–P95 ${D.slopeStats.slopeP5.toFixed(3)}–${D.slopeStats.slopeP95.toFixed(3)}</td></tr>` +
    `<tr><td>Odds reorder the board</td><td>Spearman ${v.oddsRanking.spearman.toFixed(3)} vs the value-if-launches order, ${v.oddsRanking.top10Overlap}/10 of the top 10 stay</td></tr>` +
    `</tbody></table>`;
  qs("#oos-calib").innerHTML =
    `<table><tbody>` +
    `<tr><td>Model</td><td>${esc(D.odds.model)}, λ=${D.odds.lambda}</td></tr>` +
    `<tr><td>Brier score (lower is better)</td><td>${o.brier.toFixed(4)}</td></tr>` +
    `<tr><td>Log-loss</td><td>${o.logloss.toFixed(4)}</td></tr>` +
    `<tr><td>AUC</td><td>${o.auc.toFixed(3)}</td></tr>` +
    `<tr><td>Expected calibration error</td><td>${o.ece.toFixed(4)}</td></tr>` +
    `<tr><td>Cross-fit</td><td>${o.folds} folds, n=${o.n} protocols, sorted by slug</td></tr>` +
    `</tbody></table>` +
    `<h3 style="margin-top:12px">λ grid (picked: smallest Brier; among λ within 0.0005, the largest)</h3>` +
    `<table><thead><tr><th>λ</th><th>Cross-fitted Brier</th></tr></thead><tbody>` +
    o.lambdaGrid
      .map(
        (g) =>
          `<tr><td>${g.lambda}${g.lambda === o.lambdaPicked ? " ★ picked" : ""}</td><td>${g.brier.toFixed(4)}</td></tr>`,
      )
      .join("") +
    `</tbody></table>` +
    `<h3 style="margin-top:12px">Baselines, same cross-fit</h3>` +
    `<table><thead><tr><th>Model</th><th>Brier</th><th>AUC</th></tr></thead><tbody>` +
    `<tr><td><b>Ridge-logit (this board)</b></td><td><b>${o.brier.toFixed(4)}</b></td><td><b>${o.auc.toFixed(3)}</b></td></tr>` +
    o.baselines
      .map(
        (b) => `<tr><td>${esc(b.name)}</td><td>${b.brier.toFixed(4)}</td><td>${b.auc.toFixed(3)}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`;
  const wf22 = v.walkForward.nested.origins.find((g) => g.year === 2022);
  qs("#oos-wf").innerHTML =
    `<table><thead><tr><th>Origin</th><th>Train</th><th>Test</th><th>Tuned k</th><th>Median miss</th></tr></thead><tbody>` +
    v.walkForward.nested.origins
      .map(
        (g) =>
          `<tr><td>${g.year}</td><td>${g.trainN}</td><td>${g.testN}</td><td>${g.tunedK === null ? "—" : g.tunedK}</td><td>${g.median === null ? "— (too few to fit)" : mult(g.median)}</td></tr>`,
      )
      .join("") +
    `</tbody></table><p class="dim">The 2022 origin fits on ${wf22.trainN} comps only — its ${wf22.median === null ? "—" : mult(wf22.median)} is a small-sample artefact, shown, not dropped. The snapshot is one cross-section, so these origins sort comps by listing date but price them at today's TVL: a cohort test, not a true backtest in time.</p>`;
  qs("#oos-abl").innerHTML =
    `<table><thead><tr><th>Step</th><th>LOO</th><th>Walk-forward</th></tr></thead><tbody>` +
    v.ablation
      .map(
        (a) =>
          `<tr><td>${esc(a.step)}<span class="sub">${esc(a.note)}</span></td><td>${a.loo === null ? "n/a" : mult(a.loo)}</td><td>${a.wf === null ? "n/a" : mult(a.wf)}</td></tr>`,
      )
      .join("") +
    `</tbody></table><p class="dim">Under nested tuning the offsets tie the curve alone on LOO and win on walk-forward — the flat LOO gain was tuning optimism. Forward TVL helps LOO and costs walk-forward; both columns are shown.</p>`;
  qs("#oos-tune").innerHTML =
    `<table><thead><tr><th>k</th><th>min n</th><th>LOO</th></tr></thead><tbody>` +
    D.fit.tuningGrid
      .map(
        (g) =>
          `<tr><td>${g.k}</td><td>${g.minN}</td><td>${mult(g.loo)}${g.k === D.fit.k && g.minN === D.fit.minN ? " ★" : ""}</td></tr>`,
      )
      .join("") +
    `</tbody></table><p class="dim">Curve-only LOO ${mult(D.fit.curveOnlyLoo)}. Winner: the smallest LOO; among settings within 1%, the most-shrunk. Nested LOO re-picks k per fold: ${v.loo.nestedPicks.map((p) => `k=${p.k} on ${p.n}`).join(", ")}.</p>`;
  qs("#oos-loco").innerHTML =
    `<table><thead><tr><th>Category</th><th>n</th><th>Median miss</th></tr></thead><tbody>` +
    v.loco.perCategory
      .slice(0, 8)
      .map(
        (c) =>
          `<tr><td>${esc(c.category)}</td><td>${c.n}</td><td>${mult(c.miss)}</td></tr>`,
      )
      .join("") +
    `</tbody></table><p class="dim">Pooled ${mult(v.loco.pooled.median)}. The worst categories are mostly singletons (n=1): with no category-mate to learn from, the model falls back to the bare curve — an honest failure mode, and the reason small categories get heavy shrinkage.</p>`;
  qs("#calib-curve").innerHTML =
    o.curve
      .map(
        (b) =>
          `<div class="bar-row"><span class="lbl">Bin ${b.bin} · n=${b.n}</span>` +
          `<div class="bar-track"><div class="bar-fill" style="width:${(b.pred * 100).toFixed(1)}%"></div>` +
          `<div class="bar-mark" style="left:${(b.obs * 100).toFixed(1)}%"></div></div>` +
          `<span class="val">predicted ${pct(b.pred)} · observed ${pct(b.obs)}</span></div>`,
      )
      .join("") +
    `<p class="dim">Blue bar: the model's mean predicted odds in the bin. Red mark: the share of protocols in the bin that actually record a token. A calibrated model puts the mark on the bar's edge. Age effects (log-odds): ${D.odds.ageEffects.map((a) => `${a.band} ${a.effect >= 0 ? "+" : ""}${a.effect.toFixed(2)} (${a.launched}/${a.total} launched)`).join(" · ")}.</p>`;

  /* ---- Scatter: the fit, seen (log-log, comparables + curve). ---- */
  (function scatter() {
    const W = 900;
    const H = 300;
    const P = 34;
    const xs = D.comparables.map((c) => Math.log10(c.tvl));
    const ys = D.comparables.map((c) => Math.log10(c.mcap));
    const x0 = Math.floor(Math.min(...xs));
    const x1 = Math.ceil(Math.max(...xs));
    const y0 = Math.floor(Math.min(...ys));
    const y1 = Math.ceil(Math.max(...ys));
    const X = (x) => P + ((x - x0) / (x1 - x0)) * (W - 2 * P);
    const Y = (y) => H - P - ((y - y0) / (y1 - y0)) * (H - 2 * P);
    const pts = D.comparables
      .map(
        (c) =>
          `<circle cx="${X(Math.log10(c.tvl)).toFixed(1)}" cy="${Y(Math.log10(c.mcap)).toFixed(1)}" r="3" fill="${c.dated ? "#1d6fb8" : "#c07a00"}" opacity="0.75"><title>${esc(c.name)} — TVL ${money(c.tvl)}, cap ${money(c.mcap)}</title></circle>`,
      )
      .join("");
    const fy = (x) => D.fit.intercept + D.fit.slope * x;
    qs("#scatter").innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Log market cap against log TVL for the comparables, with the fitted curve">` +
      `<line x1="${X(x0)}" y1="${Y(fy(x0))}" x2="${X(x1)}" y2="${Y(fy(x1))}" stroke="#b3261e" stroke-width="2"/>` +
      pts +
      `<text x="${P}" y="${H - 8}" font-size="12" fill="#5b6478">log₁₀ TVL (${x0} to ${x1})</text>` +
      `<text x="8" y="${P}" font-size="12" fill="#5b6478">log₁₀ cap</text></svg>` +
      `<p class="dim">Blue: ${D.fit.datedComps} dated comps (the fit set). Amber: ${D.fit.undatedComps} undated comps (held out of the fit, scored in the fair check). Red: the fitted curve, slope ${D.fit.slope.toFixed(3)}, RMSE ${D.fit.rmse.toFixed(3)}. ${D.fit.droppedZeroCap} zero-cap comps dropped as data errors; ${D.fit.winsorized} ratio winsorized at 100×.</p>`;
  })();

  /* ---- Method ---- */
  qs("#method-body").innerHTML =
    `<p><b>The question.</b> Which tokenless protocol is worth farming today? The board ranks ${D.counts.ranked} of the snapshot's ${D.counts.total} protocols by implied value: what the protocol would be worth if it launched a token, times the odds that it does.</p>` +
    `<p><b>The size curve.</b> Ordinary least squares on log₁₀(market cap) against log₁₀(TVL), fitted on the ${D.fit.datedComps} dated comparables: slope ${D.fit.slope.toFixed(3)}, intercept ${D.fit.intercept.toFixed(3)}, RMSE ${D.fit.rmse.toFixed(3)}. Each protocol is priced at its forward TVL — today's TVL carried by its 7-day change, clamped to ±20%. Family offsets are median residuals per category, shrunk by n/(n+k) with k=${D.fit.k} and capped at ±0.5 in log₁₀, so a category with few comps barely moves its rows.</p>` +
    `<p><b>The odds (new in v4).</b> A ridge-logistic model on all ${D.counts.total} protocols: logit(odds) = intercept + category effect + age-band effect, penalty λ=${D.odds.lambda} picked by cross-fitted Brier. The effects are estimated jointly — v3 multiplied two separately-shrunk rates. A protocol with no listing date takes no age term: the intercept already reflects them (${D.odds.undatedLaunched} of ${D.odds.undatedTotal} undated protocols record a token). Cross-fitted Brier ${o.brier.toFixed(4)} against ${multBrier.toFixed(4)} for the multiplicative model it replaces, AUC ${o.auc.toFixed(3)}, ECE ${o.ece.toFixed(4)}. The honest limit: the cross-fit predicts has-token status today, the only observable proxy for a future launch — the odds are base rates, not forecasts about any one protocol.</p>` +
    `<p><b>The validation.</b> Leave-one-out ${mult(v.loo.nested.median)} nested (${mult(v.loo.flat.median)} flat), walk-forward ${mult(v.walkForward.nested.pooled.median)} nested over five origins (four scored — 2021 had no training comps), time-split ${mult(v.timeSplit.nested.median)} nested, leave-one-category-out ${mult(v.loco.pooled.median)}, fair all-${D.fit.allComps} ${mult(v.looFair.median)} — against a flat-median baseline of ${mult(v.loo.flatMedian.median)}. The bands are empirical quantiles of the leave-one-out errors: P50 ${pct(v.bands.p50)} coverage at ${mult(v.bands.halfWidth50x)}, P80 ${pct(v.bands.p80)} at ${mult(v.bands.halfWidth80x)}. Rank ranges come from ${D.slopeStats.draws} bootstrap refits of the curve at a fixed seed; the odds are not refit per draw.</p>` +
    `<p><b>The farm plan.</b> Twelve weeks, ${EP.planHours} hours, five transactions. Expected drop = implied value × drop share × slice of the pool (capped at ${pct(EP.sliceCap, 2)}), minus gas on the home chain, minus the T-bill yield the deposit gives up (${pct(EP.tbill)}), minus square-root exit slippage on a ${pct(EP.floatAtLaunch, 0)} float at ${pct(EP.dailyTurnover, 0)} daily turnover. FARM clears $${EP.farmLine} net; MARGINAL is $0–$${EP.farmLine}; SKIP loses money. Every step states its cost and its time. The break-even deposit is the smallest deposit whose net reaches $0 — some rows never break even, because each extra dollar earns less in expected drop than the T-bill yield it gives up.</p>` +
    `<p><b>The coverage.</b> ${D.counts.trading} protocols already record a token and anchor the curve. ${D.counts.setAside} tokenless protocols are set aside by the house rule — ${D.asideBreakdown.map((a) => `${a.n} ${a.reason.toLowerCase()}`).join("; ")} — each listed below with its reason, so nothing in the snapshot is silently missing.</p>` +
    `<p><b>What v4 changed.</b> The odds model is now a jointly-fitted ridge-logit, cross-fitted and calibrated (Brier ${o.brier.toFixed(4)} vs ${multBrier.toFixed(4)}). The validation is nested throughout, so no check's tuning sees its held-out comps. Leave-one-category-out and empirical bands are new. The gas table now uses the snapshot's own chain names (BSC was costed at the $2 fallback in v3). The pricing curve itself is unchanged: the experiments found no pricing variant that beat it on held-out data, and the board says so in the ablation table rather than dressing noise up as a gain.</p>`;

  /* ---- Traded anchors + set-aside tables ---- */
  qs("#traded-sum").textContent =
    `${D.counts.trading} protocols already trade a token — the anchors the curve learns from`;
  qs("#traded tbody").innerHTML = D.traded
    .map(
      (t) =>
        `<tr><td><b>${esc(t.name)}</b><br><span class="dim">${esc(t.slug)}</span></td><td>${esc(t.category ?? "—")}</td><td class="num">${money(t.tvl)}</td><td class="num">${t.mcap === null ? "—" : money(t.mcap)}</td><td class="num">${t.mcap === null ? "—" : (t.mcap / t.tvl).toFixed(2) + "×"}</td></tr>`,
    )
    .join("");
  qs("#aside-sum").textContent =
    `${D.counts.setAside} tokenless protocols set aside by the house rule, each with its reason`;
  qs("#aside tbody").innerHTML = D.setAside
    .map(
      (t) =>
        `<tr><td><b>${esc(t.name)}</b><br><span class="dim">${esc(t.slug)}</span></td><td>${esc(t.category ?? "—")}</td><td class="num">${money(t.tvl)}</td><td>${esc(t.reason ?? "")}</td></tr>`,
    )
    .join("");

  /* ---- Recompute check: refit the curve, odds, values and economics here. ---- */
  (function recompute() {
    const dated = D.comparables.filter((c) => c.dated);
    const pts = dated.map((c) => [Math.log10(c.tvl), Math.log10(c.mcap)]);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) * (x - mx);
      sxy += (x - mx) * (y - my);
    }
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let sq = 0;
    for (const [x, y] of pts) sq += (y - (intercept + slope * x)) ** 2;
    const rmse = Math.sqrt(sq / pts.length);
    const fitOk =
      Math.abs(slope - D.fit.slope) < 1e-6 &&
      Math.abs(intercept - D.fit.intercept) < 1e-6 &&
      Math.abs(rmse - D.fit.rmse) < 1e-6;
    let valuesOk = 0;
    let oddsOk = 0;
    for (const r of D.rows) {
      const z = D.odds.intercept + r.cat_effect + r.age_effect;
      const odds = Math.max(0.05, Math.min(0.9, 1 / (1 + Math.exp(-z))));
      if (Math.abs(odds - r.launch_odds) < 1e-9) oddsOk += 1;
      if (
        Math.abs(
          Math.round(r.value_if_launches_usd * r.launch_odds) -
            r.implied_value_usd,
        ) <= 1
      )
        valuesOk += 1;
    }
    let econOk = true;
    for (const r of D.rows) {
      const e = econFor(r, EP.defaultDeposit, EP.defaultShare);
      if (
        Math.abs(e.net - r.econ_default.net_usd) > 0.01 ||
        e.verdict !== r.econ_default.verdict
      ) {
        econOk = false;
        break;
      }
    }
    const allOk =
      fitOk && valuesOk === D.rows.length && oddsOk === D.rows.length && econOk;
    qs("#recompute").textContent = allOk
      ? `✓ Recomputed in this page: the curve (slope ${slope.toFixed(4)}, RMSE ${rmse.toFixed(3)}), all ${oddsOk}/${D.rows.length} launch odds from the logit coefficients, all ${valuesOk}/${D.rows.length} implied values (value-if-launches × odds), and the default farm economics match the program's output.`
      : `⚠ Recompute mismatch: curve ${fitOk ? "ok" : "DIFFERS"}, odds ${oddsOk}/${D.rows.length}, implied values ${valuesOk}/${D.rows.length}, economics ${econOk ? "ok" : "DIFFER"}.`;
    if (!allOk) qs("#recompute").classList.add("bad");
  })();

  /* ---- First render + deep links ---- */
  renderTabs();
  renderBoard();
  function deepLink() {
    const h = location.hash || "";
    const mD = /^#detail\/([a-z0-9-]+)$/.exec(h);
    if (mD) {
      openDetail(mD[1]);
      qs("#detail-panel").scrollIntoView();
      return;
    }
    const mV = h.match(/^#verdict\/(FARM|MARGINAL|SKIP)$/);
    if (mV) {
      verdictTab = mV[1];
      renderTabs();
      renderBoard();
      return;
    }
    if (h === "#watchlist") {
      verdictTab = "WATCH";
      renderTabs();
      renderBoard();
      return;
    }
    if (h === "#oos") qs("#oos").scrollIntoView();
  }
  deepLink();
  window.addEventListener("hashchange", deepLink);
})();
