# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/fadliferdian28/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/fadliferdian28/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's "Build the best token launch radar" bounty ($1,325 in USDC). It reads a sealed snapshot of 758 DeFi protocols, ranks the 198 that record no token by implied launch value, and hands each one a costed 12-week farm plan. Implied value = value if it launches × launch odds, where the odds come from a ridge-logistic model fitted jointly on category and age across all 758 protocols. The value model is a log-log size curve fitted on the 95 dated traded comparables, validated out of sample before it is shown: leave-one-out ×3.17 and walk-forward ×2.74 under nested tuning (flat ×2.94 / ×3.08 beside them, so the tuning optimism is visible), time-split ×2.83, leave-one-category-out ×3.24, with per-row rank ranges from 200 bootstrap refits.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18 or later, standard library only, no network. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory, then checks its own board against the gate's rules (198 rows, 40/40 watchlist, ranks 1–198, implied value non-rising, farm steps 3–12 of 20–600 characters). Run it twice and both runs write identical bytes (fixed seeds, no clocks, no randomness).

## What it does

- **Value model** — OLS log10(market cap) on log10(TVL), slope 0.465, intercept 3.462, RMSE 0.825, fitted on the 95 dated comparables (16 zero-cap comps dropped as data errors, 1 ratio winsorized at 100×). Family offsets are median residuals per category, shrunk n/(n+10) and capped at ±0.5 log units — the shrinkage is tuned by leave-one-out, and the tuning table is on the board. TVL is carried forward by the 7-day change, clamped to ±20%.
- **Launch odds, multiplied in (new in v4)** — the ranking value is value-if-launches × odds. The odds are a ridge-logit: logit(odds) = intercept + category effect + age-band effect, penalty λ=2 picked by cross-fitted Brier, the effects estimated jointly. A protocol with no listing date takes no age term — the intercept already reflects undated protocols (79% of them record a token). Cross-fitted Brier 0.1925, log-loss 0.5691, AUC 0.774, ECE 0.0385, against 0.2010 for the multiplicative model it replaces. Every detail view opens the logit up: intercept, category effect, age effect, log-odds, sigmoid.
- **Validation, nested throughout (new in v4)** — the shrinkage is re-tuned inside every check (per held-out comp for leave-one-out, per origin for walk-forward, on the pre-2024 set for the time split), so no check's tuning sees its held-out comps. Headlines: leave-one-out ×3.17 nested, walk-forward ×2.74 nested over five yearly origins (four scored — the 2021 origin had no training comps), time-split ×2.83 nested, leave-one-category-out ×3.24, fair all-128 ×3.26 — against a flat-median baseline of ×5.00. Bands are empirical quantiles of the leave-one-out errors (P50 51% coverage at ×2.94, P80 80% at ×10.08). The ablation table is nested too: under nested tuning the family offsets tie the curve alone on leave-one-out and win on walk-forward.
- **Farm economics** — twelve weeks, 8.5 hours, five transactions. Expected drop = implied value × drop share × slice of the pool (capped at 0.1%), minus gas on the home chain, minus the T-bill yield the deposit gives up (4.32%), minus square-root exit slippage on a 15% float at 5% daily turnover. FARM clears $5 net; MARGINAL is $0–$5; SKIP loses money. At $1,000 / 7%: 28 FARM, 23 MARGINAL, 147 SKIP. Every farm plan states each step's cost and time, and the break-even deposit is solved per row (some rows never break even — the board says so).
- **The dashboard recomputes itself** — the page refits the curve from the comparables, recomputes all 198 launch odds from the logit coefficients, all 198 implied values, and the default farm economics, and reports whether they match the program's output. It does: 198/198 on every check.

## What v4 changed from v3

- **Odds model replaced.** v3 multiplied two separately-shrunk rates (a category rate × an age factor). v4 fits one ridge-logistic model jointly on category + age, cross-fitted and calibrated. Paired bootstrap on the cross-fitted Brier: −0.0084, 95% CI [−0.0130, −0.0039] — a real improvement, not noise. The board reorders accordingly (Spearman 0.738 vs the value-if-launches order; undated protocols rise, since the old model under-priced them).
- **Nested tuning.** v3 tuned the shrinkage once on the full set and reused it in every check. v4 re-tunes inside every check. The flat numbers are still shown beside the nested ones, so the tuning optimism is on the record.
- **New checks.** Leave-one-category-out (×3.24; the worst categories are n=1 singletons, an honest failure mode) and empirical bands (v3 used normal-theory bands from each fold's RMSE). The odds calibration panel — Brier, log-loss, AUC, ECE, λ grid, baselines, and a 10-bin calibration curve — is new.
- **Gas table fixed.** The snapshot names BSC "Binance"; v3's table keyed it "BNB Chain", so eleven BSC rows were costed at the $2 fallback instead of $0.12. The table now uses the snapshot's own chain names, and the frequent cheap chains (Sui, Hyperliquid L1, Monad, Stellar, Flare, Arc, Provenance) get their own entries.
- **Pricing unchanged — deliberately.** The experiments tried k-NN comps, Theil-Sen, slope shrinkage, log-age, category-specific slopes, time-decay weighting, Huber loss, quadratic and piecewise curves, a 7-day-change feature, fitting on all 128 comps, one-per-ticker dedup, and mean offsets. None beat the OLS curve on held-out data under a paired test (k-NN's headline gain was a median artifact; the per-comp effect was zero or significantly worse). So v4 keeps v3's curve and says so in the ablation table rather than dressing noise up as a gain.

## Layout

- `main.ts` — entrypoint: fit, calibrate odds, price, validate, cost, write, self-check
- `lib/snapshot.ts` — snapshot types, token classification, the house rule, comparables
- `lib/curve.ts` — the size curve, family offsets, shrinkage tuning, board pricing, bootstrap rank ranges
- `lib/odds.ts` — the ridge-logit odds model, IRLS fit, cross-fit calibration, baselines
- `lib/checks.ts` — the nested validation suite: leave-one-out, walk-forward, time-split, LOCO, bands, ablation
- `lib/farm.ts` — farm economics, break-even solver, costed farm plans
- `dashboard/` — `index.html`, `theme.css`, `board.js` (43,291 bytes total, under the 64 KB dossier text cap)
- `screenshots/` — board, detail, farm-filtered, out-of-sample views
- `shoot-v4.py` — re-captures the screenshots with headless Chrome via Playwright
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte from the kit

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
