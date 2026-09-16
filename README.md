# Finance Seer — AI-Powered Trading System

## Overview

**Finance Seer** is an autonomous trading-analysis system that ingests market data, detects technical patterns, and generates trading recommendations using a local LLM on the DGX Spark GX10 (no cloud API costs), with paper-trading execution through Interactive Brokers.

> **Stack note (Sep 2026):** the AI backend is **vLLM** serving `qwen3.8-flash-next` on the GX10 (GB10 Grace Blackwell). Ollama and LM Studio are **retired** — any doc or script still referencing ports `11434`/`1234` or model `qwen3.5:122b` is stale.

### Key features
- **Local LLM (GX10 vLLM)** — OpenAI-compatible endpoint, zero API cost
- **11 technical patterns** — double top/bottom, flags, triangles, EMA crossovers
- **8 pre-trade safety filters** — volume, volatility, EPS, debt, sentiment, RSI, P/E
- **Risk-based position sizing** — 5–15% by risk level
- **Autonomous heartbeat** — ~30-minute analysis intervals (NYSE-session aware)
- **Telegram alerts** — trade proposals and CI notifications
- **IBKR paper trading** — execution against the paper account (4002) is the mandatory default; live trading requires explicit owner authorization
- **Web dashboard** — Next.js 14 / React / TypeScript (stock analysis, watchlist, alerts)

## Architecture

```
Market data (Finnhub / Yahoo / IBKR) → Pattern detection → Analysis engine → Safety filters → Order proposals
                                                                ↓
                                                        Telegram alerts → IBKR paper execution
```

Pipeline stages (`scripts/`):
1. `heartbeat.js` — session-aware scheduler (~30 min cadence)
2. `fetch_news.py` — IBKR Briefing.com/Dow Jones news, Finnhub/Tavily fallbacks, vLLM summarisation
3. `monitor.py` — screener, signal scoring, ATR-based stops/targets, approval loop
4. `propose_trade.py` / `approval_handler.py` / `ibkr_trade.py` / `ibkr_execute.py` — proposal → Telegram approval → paper order
5. `market_update.py`, `sync_from_ibkr.py`, `record_trade.py` — portfolio state (Upstash KV + `data/portfolio.json`)

**Analysis engine status:** `lib/analysis.ts` currently performs deterministic signal scoring (SMA/RSI/MACD/patterns) *without* an LLM round-trip; the LLM is used for news summarisation. Re-enabling LLM-generated analysis is a tracked decision — see `AGENTS.md` conventions before starting it.

## Configuration

All secrets come from environment variables — never hardcode keys (see `AGENTS.md` policy; `.env` files with secrets are untracked).

| Variable | Purpose | Example |
|---|---|---|
| `OPENAI_API_URL` | vLLM base URL | `http://192.168.10.163:8000/v1` |
| `AI_MODEL` | Served model name | `qwen3.8-flash-next` |
| `FINNHUB_API_KEY` | Finnhub market data | (from your Finnhub dashboard) |
| `TAVILY_API_KEY` | Web news search | (optional) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Alerts | (from BotFather) |
| `IBKR_HOST` / `IBKR_PORT` | TWS/Gateway API | `host.docker.internal` / `4002` (paper) |
| `UPSTASH_REDIS_URL` / `UPSTASH_REDIS_TOKEN` | Portfolio KV | (Upstash dashboard) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Web portfolio store | same Upstash instance |

Copy `.env.example` → `.env` and fill in.

## Development

```bash
npm ci            # restore Node deps reproducibly
npm run dev       # Next.js at http://localhost:3000
npm test          # unit suite
```

Python automation needs `ib_insync` in an isolated venv (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`).

### GX10 vLLM endpoint

```bash
# health
curl http://192.168.10.163:8000/v1/models
# smoke test (thinking disabled for non-reasoning output)
curl -s http://192.168.10.163:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"Say OK"}],"max_tokens":8,"chat_template_kwargs":{"enable_thinking":false}}'
```

## Deployment

### PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js     # paths are relative to the repo root
pm2 logs finance-seer-monitor
```

### Vercel (web only)

CI gates deploys on passing tests; branch protection is configured per `GITHUB-BRANCH-PROTECTION.md`. Secrets are set in the Vercel dashboard, not committed.

## Trading safety

- **Paper trading is the default and mandatory** until the owner explicitly authorizes live.
- Orders require deterministic validation (symbol, side, quantity, price, account, mode, duplicate protection, max risk) before the broker adapter is called.
- Telegram approval gate for every proposal (`approval_handler.py`).
- See `AGENTS.md` for the full boundary and the single-editor handoff protocol.

## Troubleshooting

- **LLM calls return empty** — vLLM reasoning mode: `chat_template_kwargs.enable_thinking:false` must be set (see `fetch_news.py` `llm_summarise`).
- **Finnhub 403** — free tier limits (60 req/min, 300/day); the pipeline falls back to cached/IBKR data.
- **IBKR connection refused** — confirm TWS/Gateway is running with ActiveXML API enabled and paper port 4002; from Docker the host is `host.docker.internal`.

## Docs map

| File | Contents |
|---|---|
| `AGENTS.md` | Ownership, conventions, safety boundary — **read first** |
| `DEVELOPMENT.md` | Module-level developer guide |
| `DEPLOYMENT.md` | PM2/Docker/Vercel deployment |
| `MIGRATION-GX10-TO-SGLANG.md` | Historical (abandoned) SGLang evaluation — not the current stack |
| `QUICK_REFERENCE.md` | Day-to-day commands |

## License

MIT
