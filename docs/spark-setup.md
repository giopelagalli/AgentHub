# DGX Spark — what runs on it right now

State of the box as of 2026-09-21. Written for the next thing that lands here (AgentHub), so it
knows what it must share the machine with and what it must not touch. Host `spark-f9a9`, user
`giospark1`, reached over Tailscale.

---

## One sentence

The Spark runs **one vLLM** serving Qwen3.8-Flash-Next on `:8888`, a small **voice server** on
`:8890`, and **JD**, the owner's Telegram assistant, which talks to both over localhost. There is
no memory for a second model. Anything new that needs an LLM uses `:8888` and sends
`"priority": 10`.

---

## The model server

| | |
|---|---|
| Model | `Mia-AiLab/Qwen3.8-Flash-Next-NVFP4`, 99 GB, gated on HF |
| Recipe | https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark, cloned at `~/Models/Qwen3.8-Flash-Next-Single-DGX-Spark/` |
| Engine | vLLM in Docker, container `vllm-fn-tp1`, launched by the recipe's `start.sh` (applies its own vLLM patches, builds the 27 GB PLE table once) |
| Endpoint | `http://localhost:8888/v1` (OpenAI-compatible), model id `qwen3.8-flash-next` |
| Also serves | vision (the model is multimodal; JD uses it for photos) and tool calling (`--enable-auto-tool-choice --tool-call-parser qwen3_coder`) |
| Context | 262,144 native, fp8 KV cache, ~1M tokens of KV total |
| Thinking | switchable per request via `chat_template_kwargs: {enable_thinking: true/false}`; JD keeps it **on** by default |
| Service | `sparkmodel.service` (systemd, `Type=oneshot`, autostarts on boot, ~10 min to `/health`) |
| Priority scheduling | `EXTRA_VLLM_ARGS="--scheduling-policy priority"` in the recipe's `.env` (added 2026-09-21; verify with `docker inspect vllm-fn-tp1 --format '{{join .Args " "}}' \| grep scheduling`) |

Memory, the thing everything else bends around (121 GiB unified, shared CPU+GPU):

- weights on GPU: 71.8 GiB
- PLE n-gram table: 26.8 GiB, memory-mapped from NVMe, not on GPU
- runtime + MTP draft: ~7 GiB
- KV cache: ~16.7 GiB
- **host reserve: 26 GiB, non-negotiable** — exhausting the pool hangs the kernel with no OOM and no logs

So: **no second vLLM, no second model.** The AgentHub playbook's two-instance layout (35B worker
on 8001 + Flash-Next on 8002) does not fit here. Both AgentHub tiers point at `:8888`.

Operational notes from the recipe log:

- Load takes ~10 min and is a single-threaded CPU loop; nothing speeds it up. Don't restart casually.
- Bound to localhost by default. Over Tailscale it's reachable only if the container publishes on
  `0.0.0.0` (check `ss -ltnp | grep 8888`) or via `sudo tailscale serve --bg --http=8888 http://127.0.0.1:8888`.
- Update the recipe with `git pull` in its folder then `sudo systemctl restart sparkmodel`; weights don't change.
- The old admin Telegram bot from the recipe (`sparkbot.service`, `bot.py`) is **disabled**. JD is the only bot.

---

## The voice server

| | |
|---|---|
| Code | `~/telegramManager/spark/voice_server.py` (FastAPI + uvicorn) |
| Endpoint | `http://localhost:8890/v1` |
| Serves | `POST /v1/audio/transcriptions` (faster-whisper `small`), `POST /v1/audio/speech` (Kokoro, voice `am_onyx`, OGG/Opus out), `POST /v1/embeddings` (`nomic-ai/nomic-embed-text-v1.5` via sentence-transformers), `GET /v1/models` |
| Device | **CPU on purpose** (`VOICE_DEVICE=cpu`) — a few hundred MB of RAM, never the GPU pool. A voice note round trip is ~6 s |
| Service | `voice-server.service` (systemd), venv at `~/telegramManager/spark/.venv`, Kokoro files in `~/telegramManager/spark/models/`, needs `ffmpeg` |
| Optional | Chatterbox TTS (`TTS_ENGINE=chatterbox`) for a more human voice — not installed, would want GPU headroom that isn't there |

---

## JD (the Telegram assistant)

| | |
|---|---|
| Code | `~/telegramManager` (private GitHub repo `giopelagalli/telegramManager`, deploy key on the Spark) |
| Service | `assistant.service` (systemd, `After=sparkmodel.service voice-server.service`), venv `~/telegramManager/.venv`, runs `python -m bot` |
| Config | `~/telegramManager/.env` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `FIREWORKS_API_KEY`, `SPARK_URL=http://localhost:8888/v1`, `SPARK_VOICE_URL=http://localhost:8890/v1`, `GOOGLE_MAPS_API_KEY`, `BRAVE_API_KEY`; optional `AGENTHUB_URL` / `AGENTHUB_PASSWORD` (so `/queue` can show AgentHub's projects), `TWILIO_*`, `TTS_API_KEY` |
| Data | `~/telegramManager/knowledge/` — a git repo of markdown: todos, schedule (+ weekly series), goals, courses, sources, memories, chat transcript per day, food and tracker logs, profile. `~/telegramManager/data/state.json` is runtime state |
| Model use | chat, vision, coaching, exam plans → `:8888`. Voice in/out and embeddings → `:8890`. Fireworks (`deepseek-v4p1-flash`) only as fallback while the Spark is down, and for the explicit `/hard` command |
| Priority | JD sends **no** priority field (= 0, the front of the line). That's the whole point of the scheduling flag |
| Update | `cd ~/telegramManager && git pull -q && sudo systemctl restart assistant` (pip install only when told) |

JD polls the Spark's model every 60 s; when it stops answering he tells the owner "Spark's down"
and runs on Fireworks, then "Spark's back". A model reload is a normal event for him.

---

## Box-level

- **Tailscale** on; the box is `spark-f9a9` on the tailnet. Nothing is exposed publicly.
- **Unattended upgrades**: security + updates nightly, automatic reboot at 04:00 only when required,
  with `nvidia-*`, `libnvidia-*`, `cuda`, `docker`, `containerd`, `nvidia-container` blacklisted
  (`/etc/apt/apt.conf.d/52spark`). The GPU stack is never updated automatically.
- **Docker** is used only by the model recipe.
- Python is `python3`; system pip is locked (`externally-managed-environment`), always use a venv.

---

## Ports in use

| Port | What |
|---|---|
| 8888 | vLLM, Qwen3.8-Flash-Next (`sparkmodel.service`) |
| 8890 | voice server (`voice-server.service`) |
| 8188 | free — the AgentHub playbook wants ComfyUI here; nothing there yet |
| 8001 / 8002 | free — AgentHub's playbook ports; **don't launch model servers on them** (see memory) |

---

## Landing AgentHub here: what has to be true

1. **Both AgentHub tiers use the existing server.** Orchestrator and worker → `http://localhost:8888`,
   model `qwen3.8-flash-next`. Not a second vLLM. The daemon config currently requires a launch
   `cmd` per serving entry; it needs an "attach to a server I didn't start" option (or a no-op cmd)
   for this box.
2. **Every AgentHub request carries `"priority": 10`.** Branch `feat/vllm-request-priority` in the
   AgentHub repo (commit `8166c11`) adds `ServingEndpoint.priority` end to end and sets 10 on the
   Spark config. Merge it. Without the server flag above, a non-zero priority is a 400 — the flag
   is already on.
3. **Keep the KV budget in mind.** ~1M tokens in flight total, shared with JD. `maxStreams` of
   48 on the worker tier is for a box that isn't sharing; 2–3 is realistic here. When it's full,
   JD still goes first, but "first" still waits.
4. **Video (`video-gen`, ComfyUI + MiniMax-H3) is a separate memory question.** The host reserve
   is 26 GiB; a video model won't fit next to Flash-Next without stopping it. Don't enable
   `video-gen` on this node until that's decided.
5. **Don't touch** `sparkmodel.service`, `voice-server.service`, `assistant.service`, the recipe
   folder, or `~/telegramManager`. Node daemon under its own systemd unit, its own venv/node
   install, its own workspace root (`~/agenthub-workspace` is fine).
6. **Same tailnet name for the hub.** The daemon's `hub:` points at the control node's tailnet name
   (the Mac mini per the AgentHub README); `advertiseHost` is `spark-f9a9`.

Handy checks on the box:

```bash
systemctl status sparkmodel voice-server assistant --no-pager | grep -E "●|Active"
curl -s localhost:8888/v1/models | head -c 200; echo
curl -s localhost:8890/v1/models | head -c 200; echo
free -h
docker ps --format '{{.Names}} {{.Status}}'
```
