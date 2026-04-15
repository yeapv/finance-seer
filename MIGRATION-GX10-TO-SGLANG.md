# Migration Plan: GX10 Ollama → SGLang (GX10) + LM Studio (AMD AI Max)
**Status: PROPOSAL — No changes made. Review before execution.**
**Prepared by: Jared (AI Assistant)**
**Date: 2026-04-15**
**Last updated: 2026-04-15 18:48 SGT** — LM Studio model confirmed as `qwen3.5:30b`; crontab warmup confirmed not required (per Jarvis)

---

## 1. Executive Summary

Finance Seer currently points all AI/LLM workloads at **GX10 Ollama** (`192.168.10.163:11434`).
The goal is to migrate the GX10 from Ollama → SGLang (5–8× faster), while Jarvis moves to
**AMD AI Max+ 395 + LM Studio** (`192.168.10.58:1234`). This document maps every dependency,
identifies every risk, and proposes the exact changes needed — with nothing executed yet.

---

## 2. Current Architecture

```
Finance Seer (Vercel)
  └── API routes → OPENAI_API_URL → GX10 Ollama (:11434/v1)

Lobster (this machine, 172.23.166.167)
  ├── PM2: finance-seer-monitor → scripts/monitor.py
  │     └── imports fetch_news.py → calls GX10 Ollama :11434/api/chat (native API)
  ├── PM2: finance-seer-heartbeat → scripts/heartbeat.js
  └── PM2: finance-seer-health-monitor → scripts/health-monitor.js

GX10 (192.168.10.163)
  ├── Ollama (systemd, :11434) ← ACTIVE, qwen3.5:35b in GPU
  │   Models: qwen3.5:35b (23GB), qwen3.5:122b (81GB), qwen2.5-coder:32b (19GB)
  ├── Vane/Perplexica (Docker, :3000) → config.json type:"ollama" → :11434
  ├── Crontab: @reboot → warms up qwen3.5:122b via /api/chat
  └── SearXNG (:8080) → independent, unaffected

Jarvis (192.168.10.246)
  └── Currently calling GX10 Ollama → migrating to AMD AI Max + LM Studio
```

---

## 3. Complete Dependency Inventory

### 3A. Files to Change on Lobster (Finance Seer codebase)

| File | Current value | Proposed change | Why |
|------|--------------|-----------------|-----|
| `.env.local` L6 | `OPENAI_API_URL="http://192.168.10.163:11434/v1"` | `http://192.168.10.58:1234/v1` | LM Studio endpoint |
| `.env.local` L7 | `AI_MODEL="qwen3.5:122b"` | `qwen3.5:30b` | LM Studio model name (confirmed) |
| `.env.production` L6 | `OPENAI_API_URL="http://192.168.10.163:11434/v1"` | `http://192.168.10.58:1234/v1` | Same |
| `.env.production` L7 | `AI_MODEL="qwen3.5:122b"` | `qwen3.5:30b` | LM Studio model name (confirmed) |
| `scripts/fetch_news.py` L19 | `GROQ_URL = 'http://192.168.10.163:11434/api/chat'` | `http://192.168.10.58:1234/v1/chat/completions` | OpenAI-compat format |
| `scripts/fetch_news.py` L20 | `GROQ_MODEL = 'qwen3.5:122b'` | `qwen3.5:30b` | LM Studio model name (confirmed) |
| `scripts/fetch_news.py` L99–112 | Native Ollama request body (`think`, `options`) | OpenAI-compat body (`max_tokens`, `temperature`) | API format change (see §5) |
| `app/api/portfolio/monitor/route.ts` L218 | hardcoded `model: 'llama-3.3-70b-versatile'` | `process.env.AI_MODEL` | Use env var consistently |
| `app/api/portfolio/close/route.ts` L60 | hardcoded `model: 'llama-3.3-70b-versatile'` | `process.env.AI_MODEL` | Use env var consistently |

### 3B. Files to Change on GX10

| File/Service | Current | Proposed change |
|-------------|---------|-----------------|
| Vane `config.json` (via Docker UI) | `"type": "ollama"`, `"baseURL": "http://192.168.10.163:11434"` | Change to OpenAI-compat provider type, `"baseURL": "http://192.168.10.163:30000"` |
| Crontab warmup | `curl localhost:11434/api/chat` native Ollama body | **Remove entirely** — not required per Jarvis findings |
| Ollama systemd service | enabled + running | Stop → disable → remove |
| SGLang Docker container | (new) | Start with NGC image on `:30000` |

### 3C. Not affected

- `scripts/heartbeat.js` — only pings `PORTAL_URL` (Vercel), no LLM calls
- `scripts/health-monitor.js` — monitors Vercel health endpoint
- `scripts/market_update.py` — needs verification (see §6)
- `scripts/morning_briefing.py` — needs verification (see §6)
- SearXNG on GX10 — independent service, unaffected
- CI/CD pipeline — unaffected (tests don't call live LLM endpoints)
- Vercel deployment — unaffected (uses env vars at runtime)

---

## 4. The `fetch_news.py` API Change (Most Complex)

This is the **highest-risk change**. It uses the **native Ollama `/api/chat` format** specifically
to pass `"think": false` — which suppresses Qwen3's internal chain-of-thought reasoning for faster
responses. The OpenAI-compatible `/v1/chat/completions` endpoint handles this differently.

### Current code (native Ollama format):
```python
GROQ_URL   = 'http://192.168.10.163:11434/api/chat'
GROQ_MODEL = 'qwen3.5:122b'

body = json.dumps({
    'model': GROQ_MODEL,
    'messages': [{'role': 'user', 'content': prompt}],
    'think': False,           # ← Ollama-native: suppress thinking tokens
    'stream': False,
    'options': {'temperature': 0.3, 'num_predict': max_tokens},
}).encode()
# response: resp['message']['content']
```

### Proposed code (OpenAI-compat format for LM Studio):
```python
GROQ_URL   = 'http://192.168.10.58:1234/v1/chat/completions'
GROQ_MODEL = 'qwen3.5:30b'  # confirmed model ID in LM Studio (Jarvis migration)

body = json.dumps({
    'model': GROQ_MODEL,
    'messages': [
        {
            'role': 'system',
            'content': 'You are a concise financial analyst. Answer directly without lengthy reasoning or preamble.'
        },
        {'role': 'user', 'content': prompt}
    ],
    'temperature': 0.3,
    'max_tokens': max_tokens,
    'stream': False,
}).encode()
req = urllib.request.Request(GROQ_URL, data=body,
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer lmstudio'})
# response: resp['choices'][0]['message']['content']
```

> **Note on `think: false`:** LM Studio doesn't support this Ollama-native flag. The system prompt
> instructing "answer directly without lengthy reasoning" is the standard mitigation for Qwen3's
> thinking mode in OpenAI-compat APIs. LM Studio may also expose a `/chat/completions` parameter
> `"thinking": {"type": "disabled"}` — confirm after LM Studio is running.

---

## 5. SGLang Setup on GX10 (Proposed Command)

**Image:** `nvcr.io/nvidia/sglang:26.02-py3` (NOT `lmsysorg/sglang:spark` — that image is outdated/buggy per NVIDIA's own advisory)

```bash
docker run -d \
  --name sglang \
  --gpus all \
  --shm-size 32g \
  --ipc=host \
  --restart unless-stopped \
  -p 30000:30000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HF_TOKEN=$HF_TOKEN \
  -e FLASHINFER_DISABLE_VERSION_CHECK=1 \
  nvcr.io/nvidia/sglang:26.02-py3 \
  python3 -m sglang.launch_server \
    --model-path Qwen/Qwen3.5-30B-A3B \  # same model family as LM Studio qwen3.5:30b
    --host 0.0.0.0 \
    --port 30000 \
    --dtype bfloat16 \
    --disable-cuda-graph \
    --mem-fraction-static 0.85
```

**Why these flags:**
| Flag | Reason |
|------|--------|
| `nvcr.io/nvidia/sglang:26.02-py3` | NVIDIA-validated, not the buggy community spark image |
| `--dtype bfloat16` | Safe starting point; FP8/FP4 has NaN issues on GB10 sm_121a |
| `--disable-cuda-graph` | Prevents Triton PTXAS crashes during warmup on GB10 |
| `--mem-fraction-static 0.85` | GX10 UMA reports less allocatable memory than actual |
| `FLASHINFER_DISABLE_VERSION_CHECK=1` | FlashInfer SM121a wheels not yet matched |

**After stability confirmed** (1–2 days), can enable:
- `--quantization fp8` for ~2× additional speedup
- Remove `--disable-cuda-graph` for ~15% throughput improvement

---

## 6. Scripts Needing Verification

These scripts weren't fully audited. Confirm before GX10 migration:

```bash
grep -n "11434\|ollama\|192.168.10.163" \
  scripts/monitor.py \
  scripts/morning_briefing.py \
  scripts/market_update.py \
  scripts/propose_trade.py \
  scripts/record_trade.py
```

`monitor.py` confirmed: imports `fetch_news.py` → indirect Ollama dependency.
The others should be checked — flag any hardcoded `11434` or `192.168.10.163` references.

---

## 7. Ollama Clean Removal (GX10)

```bash
# Step 1: Stop and disable service
sudo systemctl stop ollama
sudo systemctl disable ollama

# Step 2: Remove service files
sudo rm -f /etc/systemd/system/ollama.service
sudo rm -rf /etc/systemd/system/ollama.service.d/
sudo systemctl daemon-reload

# Step 3: Remove binary
sudo rm -f /usr/local/bin/ollama

# Step 4: Remove library
sudo rm -rf /usr/local/lib/ollama

# Step 5: Remove model data (123GB freed) — CONFIRM before running
sudo rm -rf /usr/share/ollama

# Step 6: Remove user config
rm -rf /home/yvincent/.ollama

# Step 7: Remove ollama user/group
sudo userdel ollama
sudo groupdel ollama

# Step 8: Remove crontab warmup entry
crontab -e  # delete the @reboot ollama warmup line

# Verify
which ollama  # should return nothing
```

> **Decision needed:** Keep model blobs as backup or delete?
> - `qwen3.5:122b` = 81GB, `qwen3.5:35b` = 23GB, `qwen2.5-coder:32b` = 19GB
> - Total: ~123GB. GX10 has 689GB free, so space isn't urgent.
> - Recommendation: **delete** — models are re-downloadable from HuggingFace if ever needed.

---

## 8. Vane Reconfiguration (GX10 — via UI, no file edit needed)

1. Open `http://192.168.10.163:3000` → Settings → Model Providers
2. Find the "GX10" provider (currently `type: ollama`)
3. Change to **"Local OpenAI-API-Compliant Server"** type
4. Set `baseURL` → `http://192.168.10.163:30000`
5. Set API key → `sglang-local` (any non-empty string)
6. Save and test

The `config.json` in the `vane-data` Docker volume will be updated automatically.

---

## 9. Known Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SGLang FP8 NaN errors on GB10 sm_121a | Medium | 🔴 Model outputs garbage | Start with `bfloat16`, upgrade after stability confirmed |
| Triton PTXAS compilation crash on warmup | Medium | 🟡 Container crash loop | `--disable-cuda-graph` flag |
| LM Studio model name mismatch | Low | 🟡 API 404 errors | Confirm exact model ID via `GET http://192.168.10.58:1234/v1/models` |
| Qwen3 thinking tokens in LM Studio output | Medium | 🟡 `<think>...</think>` tags in responses | Add system prompt to suppress; or strip `<think>` tags in `groq_summarise()` |
| `fetch_news.py` response parse failure | Low | 🟡 News summary empty, graceful fallback | Test locally before deploying |
| 111+ CI tests catching regression | Low | 🟢 Build blocked (safe) | Tests are the safety net — let them catch issues |
| Vane embeddings broken after migration | Unknown | 🟡 RAG search degrades | SGLang does support `/v1/embeddings` but needs embedding model loaded separately |
| Docker group missing on GX10 for yvincent | Confirmed | 🟡 All docker commands need sudo | `sudo usermod -aG docker yvincent` + re-login |

---

## 10. Execution Sequence (When Ready)

### Prerequisites (confirm before starting)
- [ ] Jarvis fully migrated to LM Studio on AMD AI Max (`192.168.10.58:1234`) and no longer calling GX10
- [ ] LM Studio is running with Qwen3.5 model loaded; confirm model ID via `GET /v1/models`
- [ ] `think: false` / thinking suppression approach confirmed for LM Studio
- [ ] All other scripts audited for hardcoded `11434` references
- [ ] Migration window agreed (brief downtime of ~15 min for Finance Seer AI features)
- [ ] HuggingFace token obtained for SGLang model download on GX10

### Phase 0 — Code changes on Lobster (this machine)
1. Update `.env.local` and `.env.production` (4 lines)
2. Update `scripts/fetch_news.py` (3 lines config + API call format)
3. Update hardcoded model names in `route.ts` files (use `AI_MODEL` env var)
4. Run full test suite locally: `node tests/run-all-tests.js`
5. Commit → push → CI/CD runs → Vercel deploys (automated)

### Phase 1 — GX10 prep (no disruption)
6. Pull SGLang image: `docker pull nvcr.io/nvidia/sglang:26.02-py3` (~20GB, background)
7. Add docker group: `sudo usermod -aG docker yvincent`

### Phase 2 — GX10 cutover (~15 min window)
8. Notify any active users (Vane UI will be briefly unavailable)
9. Stop Ollama: `sudo systemctl stop ollama`
10. Start SGLang container (command in §5)
11. Wait for model load (~3–5 min): `docker logs -f sglang`
12. Verify: `curl http://localhost:30000/v1/models`
13. Disable + remove Ollama (§7)

### Phase 3 — Reconnect clients
14. Update Vane provider via UI (§8)
15. ~~Update GX10 crontab warmup script~~ → **Remove crontab entry entirely** (not required per Jarvis)
16. Run test suite again to confirm end-to-end

### Phase 4 — Validate & tune
17. Monitor SGLang logs for 24h (check for NaN / Triton errors)
18. Benchmark: time a chat response vs old Ollama baseline
19. If stable → enable FP8 quantization for additional speedup
20. Update OpenClaw config on this machine to use `sglang` provider if desired

---

## 11. Rollback Plan

If SGLang causes issues:
```bash
# On GX10 — re-install Ollama
curl -fsSL https://ollama.ai/install.sh | sh
sudo systemctl start ollama
ollama pull qwen3.5:35b  # re-download (or restore from backup if kept)

# On Lobster — revert env files
# .env.local and .env.production back to 192.168.10.163:11434
# fetch_news.py back to native Ollama format
```
> This is why keeping Ollama model blobs during Phase 1 (before confirmation) is an option — makes rollback faster.

---

## 12. Open Questions

1. ~~**LM Studio model ID**~~ → **RESOLVED**: `qwen3.5:30b` (confirmed by Jarvis migration)
2. **Thinking mode suppression** — Does LM Studio's `/v1/chat/completions` support any `thinking` parameter, or is system-prompt suppression the only option?
3. **Embedding model** — Vane uses RAG search. Does it rely on Ollama for embeddings too? If so, SGLang needs an embedding model loaded alongside the chat model, or a separate embedding service.
4. **`morning_briefing.py` and `market_update.py`** — Do these have hardcoded Ollama references? (Need grep audit.)
5. **GX10 migration timing** — Jarvis is actively migrating now. GX10 cutover can begin once Jarvis confirms LM Studio is fully operational and no longer calling GX10.

---

*This document is read-only / planning only. No changes have been made to any running system.*
*When approved, execute in the sequence above, checking off each step.*
