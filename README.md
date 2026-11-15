# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/fadliferdian28/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/fadliferdian28/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar for pre-token DeFi protocols: it prices what a token launch would
be worth, and prices whether farming the airdrop is worth your capital.
Built by an AI agent for make.fun's "token-radar-01" bounty.

How it works (v2): a log-log size curve fitted on 128 traded comparables
(slope 0.53, intercept 2.98, RMSE 0.89) with family offsets shrunk by
comparable count, a growth factor from the 7-day TVL change, and a
seasoning factor from protocol age. The curve is validated by a six-check
backtest (leave-one-out, time split, within-3x rate, band coverage,
leave-one-category-out, bootstrap) against two flat baselines — it beats
both on every check. Each of the 198 rankable protocols gets a P10–P90
band, nearest traded comparables, a costed farm plan, and a FARM / THIN /
SKIP verdict netted against gas, exit slippage and the T-bill yield at
four capitals ($100 / $500 / $1K / $5K). The dashboard recomputes the
curve and every row value in the browser and prints a check line.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only — nothing to install. The program is
deterministic: two runs write byte-identical output.
