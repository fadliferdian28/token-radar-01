# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/fadliferdian28/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/fadliferdian28/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's "Build the best token launch radar" bounty ($1,325 in USDC). It reads a sealed snapshot of 758 DeFi protocols, ranks the 198 that record no token by implied launch value, and hands each one a costed 12-week farm plan. Implied value = value if it launches × launch odds, where the odds come from the snapshot's own counts (category base rates × empirical age buckets). The model is a log-log size curve fitted on the 95 dated traded comparables, validated out of sample before it is shown: leave-one-out ×2.94, walk-forward ×3.08, time-split ×2.91, with per-row rank ranges from 200 bootstrap refits.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18 or later, standard library only, no network. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory, then checks its own board against the gate's rules (198 rows, 40/40 watchlist, ranks 1–198, implied value non-rising, farm steps 3–12 of 20–600 characters). Run it twice and both runs write identical bytes.

## What it does

- **Value model** — OLS log10(market cap) on log10(TVL), slope 0.46, fitted on the 95 dated comparables (16 zero/negative caps excluded as data errors, 1 ratio winsorized at 100×). Family offsets are median residuals per category, shrunk n/(n+10) and capped at ±0.5 log units — the shrinkage is tuned by leave-one-out, and the tuning table is on the board. TVL is carried forward by the 7-day change, clamped to ±20%.
- **Launch odds, multiplied in** — the ranking value is value-if-launches × odds. The odds are a category base rate (share of the category's protocols that record a token, Beta-shrunk toward the global 416/758 with 10 pseudo-counts) times an age factor from the empirical token rate by age bucket (<1y ×0.64, 1–2y ×0.75, 2–3y ×1.08, 3y+ ×1.56), clamped to 5–90%. Both the value-if-launches and the implied value are shown as separate columns.
- **Validation on the board** — leave-one-out (headline ×2.94 on the dated set, fair ×3.26 scored on all 128 comps), walk-forward over five January origins (pooled ×3.08, per-origin table), time-split (×2.91), P50/P80 band coverage (57%/83%), an ablation table (curve ×3.17 → +offsets ×2.94 → +forward TVL ×3.03; odds reorder the board instead, Spearman 0.73), and flat-median / flat-0.25× baselines beside every check.
- **Farm economics** — 12-week plans at four deposits ($100/$1k/$5k/$10k) and three drop shares (3.5%/7%/14%), recomputed live in the dashboard. Every row carries net, break-even deposit, $/hour, fees and time, with FARM / MARGINAL / SKIP verdicts; every farm step states its COST and its TIME. At $1,000 and a 7% drop: 16 FARM, 15 MARGINAL, 167 SKIP.
- **Dashboard** — KPI strip with the full 758 accounting, verdict filter tabs with counts, category/chain filters, search, seven sort orders, a detail view with the full pricing decomposition, nearest comparables, rank range, sensitivity grid and costed farm plan, plus the out-of-sample panel and a scatter plot. Dark theme, no runtime network calls, 35 KB of source.

## Layout

- `main.ts` — entrypoint: fit, price, validate, cost, write, self-check
- `lib/snap.ts` — snapshot types, token classification, the house rule, comparables
- `lib/pricing.ts` — the size curve, family offsets, shrinkage tuning, launch odds, bootstrap rank ranges
- `lib/validate.ts` — leave-one-out, walk-forward, time-split, bands, ablation, baselines
- `lib/farm.ts` — farm economics, break-even solver, costed farm plans
- `dashboard/` — `index.html`, `style.css`, `app.js` (the page recomputes the curve and the economics in place and checks them against the program)
- `screenshots/` — board, detail, filtered, out-of-sample views
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte from the kit

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
