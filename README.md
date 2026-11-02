# grokbot paper dashboard

Static dashboard for a **paper-only** crypto book. Traded symbols are BTC-USD and ETH-USD. SOL-USD is on the charts as watch-only. The page does not place orders and does not contain the bot, its strategy, or any secrets.

Account numbers are whatever is in [`data/snapshot.json`](data/snapshot.json). The seeded file is a real export from the paper bot (flat $1,000 book, no closed trades). Empty lists stay empty. Candlesticks are loaded in the browser from the public Coinbase Exchange API:

`https://api.exchange.coinbase.com/products/{BTC-USD|ETH-USD|SOL-USD}/candles`

The page fetches `data/snapshot.json` again every 60 seconds. The badge reads **LIVE** when the snapshot `generated` time is within 10 minutes, and **STALE** when it is older than that (or missing). Timestamps in `generated` that have no timezone are read as UTC.

## Pages

After this is on `main` and Pages is enabled, the site is:

**https://antzcales-byte.github.io/grokbot/**

The owner has to turn Pages on once:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions** (not “Deploy from a branch”).
3. Allow GitHub Actions for this repository if it is disabled.
4. Merge to `main`. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the site.
5. If the `github-pages` environment asks for approval on the first deploy, approve it.

The workflow does not run for pull requests. The URL starts serving after the merge and the first successful deploy.

## What the page shows

- A sticky **PAPER MODE** banner.
- Equity, profit versus start, and a goal bar. If the snapshot has a numeric `goal`, the bar is progress from `start` to that equity target. Otherwise it shows equity as a share of starting capital and says there is no profit target.
- Risk meters from the snapshot: daily loss (limit 2%), weekly loss (5%), drawdown (10%), open trades (max 3), new trades today (max 4).
- Closed-trade profit stacked by `setup`, and a two-column grid of closed trades (green when `pnl` is positive, red when it is negative).
- BTC, ETH, and SOL candlesticks (1H, 4H aggregated from 1H, 1D). ETH is tagged **EXPERIMENTAL** from the snapshot (`EXPERIMENTAL (mean-reversion)` in the seed). SOL is tagged **WATCH ONLY**.
- Equity curve from `equity_series`.
- Blocked-trade / veto feed (`events` with kind `VETO` or `SKIP`, plus log lines that mention a veto) and the events list. Bot `messages` are shown beside events.

## Publish a new snapshot

On the machine that runs the bot, from a checkout of this repo on `main`:

```bash
export GH_DASH_TOKEN=...          # contents:write on this repo; do not commit it
export TRADEBOT_DIR=/path/to/tradebot   # optional, default /workspace/tradebot
./scripts/publish_snapshot.sh
```

The script runs `$TRADEBOT_DIR/scripts/dashboard_data.py`, validates the JSON, and replaces `data/snapshot.json`. It commits and pushes only when that file changed (or a previous snapshot commit has not reached `origin/main`). The push uses an `https://github.com/<owner>/<repo>.git` remote built at runtime. `GH_DASH_TOKEN` is passed through `GIT_ASKPASS` and is not written to the repo, git config, the helper script, or the script’s own logs. Do not run it under `bash -x`.

The token needs permission to push to this repository. A fine-grained token with Contents read/write on this repo is enough. The script refuses to push if `main` is ahead of `origin/main` by any file other than `data/snapshot.json`.

`DASH_BRANCH` overrides the branch (default `main`). `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` are used only when this checkout has no git identity.

## Snapshot fields

`dashboard_data.py` prints one JSON object:

| Field | Use |
| --- | --- |
| `equity`, `start`, `peak` | Equity card. Optional `goal` is an equity target. |
| `generated` | Snapshot clock for LIVE / STALE. |
| `equity_series` | `[timestamp, equity]` points. |
| `status` | Heartbeat, last scan, cycle count, kill switch, day halt, week halt. |
| `risk` | `daily_loss_pct` / `daily_limit`, weekly, `drawdown_pct` / `dd_limit`, `open_trades` / `max_open`, `new_today` / `max_new`. |
| `instruments` | Per-symbol name, tag, pnl, open trades, last bar. ETH carries the experimental tag. |
| `trades` | Paper trades. Closed rows have `exit_time`. Cards use symbol, side, setup, prices, `pnl`, `r_multiple`, `exit_reason`. |
| `events` | `{ts, kind, msg}`. Vetoes and skips feed the blocked-trade list. |
| `messages` | Recent paper-bot log lines. |
| `market` | Snapshot quotes, spreads, and candle fallback if Coinbase is unreachable. |

## What is not in this repo

The trading bot, its database, broker tokens, and strategy code stay on the bot machine. This repository is the static site plus the latest paper snapshot.
