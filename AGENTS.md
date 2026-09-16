# Financial Seer agent guide

## Ownership and paths

- Primary agent: Hermes.
- Windows source: `C:\Projects\FinancialSeer`.
- Hermes path: `/opt/data/projects/FinancialSeer`.
- OpenClaw path: `/home/openclaw/.openclaw/workspace/finance-seer`.
- OpenClaw may inspect or accept an explicit handoff.
- Git remote: `https://github.com/yeapv/finance-seer.git`.

## Start every task

1. Read this file, `README.md`, and the relevant implementation files; some existing documentation is stale.
2. Run `git status --short --branch` before editing. Never discard or overwrite unrelated local work.
3. Check the shared vault note `Projects/Agent Project Registry.md` for ownership or handoff changes.
4. Restore dependencies reproducibly before judging the application build (`npm ci` for Node and an isolated Python environment for `requirements.txt`).

## Current technical baseline

- Next.js 14/React/TypeScript frontend and API routes, plus Python automation scripts.
- Core unit suite: `npm test` (144 tests passed during the 2026-09-14 audit).
- The application build currently cannot start because Node dependencies are absent.
- Several runtime paths and documents still target retired Ollama/Qwen3.5 endpoints. The current GX10 service is OpenAI-compatible vLLM at `http://192.168.10.163:8000/v1`, model `qwen3.8-flash-next`.
- IBKR code currently assumes a WSL-to-Windows address and paper port 4002. From Hermes Docker, use an explicit configurable host such as `host.docker.internal`; do not add another hardcoded container-specific address.

## Trading safety boundary

- Paper trading is the default and mandatory until the user explicitly authorizes a live-trading transition.
- Separate read-only portfolio/market-data operations from order mutations.
- Never place, modify, or cancel a live order merely because a coding or test task mentions trading.
- Keep account identifiers, tokens, API credentials, and Telegram secrets out of source, logs, the shared Obsidian vault, fixtures, and prompts.
- Require deterministic validation of symbol, side, quantity, price, account, trading mode, duplicate-order protection, and maximum risk before any order adapter is called.
- Prefer mocks for ordinary tests and a dedicated paper-account integration gate for broker connectivity.

## Verification

- Run targeted tests, then `npm test` and `npm run build` when dependencies are present.
- Broker integration tests must clearly report whether they used a mock, read-only connection, or paper account.
- Never describe a connectivity-only test as proof that order execution is safe.

## Handoffs

- Only one agent should actively modify this project at a time.
- Before taking over, inspect Git state and the shared registry, then record the new owner and task.
- A handoff must state branch/commit, dirty files, changed files, checks run, remaining work, and broker mode used.
