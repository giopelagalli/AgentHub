# AgentHub PRD — Local Multi-Node Agent Hub

**Date:** 2026-09-01
**Status:** Approved (design review with owner, 2026-09-01)
**Supersedes:** the single-machine pixel-office prototype (moved to `legacy-prototype/`, reference only)

## 1. Overview

AgentHub is a self-hosted, fully local AI agent platform running across a home
compute cluster. A master orchestrator supervises per-project orchestrators,
each of which spawns subagent workers; all inference runs on local nodes
(DGX Spark, 7900XTX PC, Macs) through a shared model gateway and priority
queue. The owner controls everything from a Pokemon-style pixel-art web UI
(reachable remotely via a DigitalOcean proxy) and from Telegram. A personal
assistant agent with a markdown knowledge store manages the owner's day and
delivers daily briefings.

**Privacy stance:** all model inference is local. The only external API calls
are three named tools — Grok (X/Twitter posting), Gemini (YouTube video
understanding), and a web-search API — each audited.

## 2. Goals

1. Run multiple concurrent projects, each driven by its own orchestrator agent
   with durable, portable context (no context rot).
2. Pool heterogeneous compute nodes; nodes join/leave freely, jobs re-queue.
3. Full control from Telegram and from a web UI; visual "walk around the
   office" view of projects, agents, and nodes.
4. Personal assistant that slowly learns about the owner via a readable
   markdown memory, handles `/goals` `/todo` `/backlog`, checks in, and sends
   daily briefings.
5. Local AI video generation (MiniMax-H3) as a schedulable job type.

### Non-goals (v1)

- Real phone calls / SMS (Telegram only; voice notes OK).
- Multi-user support. Single owner.
- Cloud-hosted state. The DO droplet is a stateless proxy.
- Training or fine-tuning models.
- Windows support for the node daemon (7900XTX PC runs Linux).

## 3. Hardware & model matrix

| Node | Hardware | Role | Serving stack | Models |
|---|---|---|---|---|
| `spark` | DGX Spark (GB10, 128GB unified) | Primary inference + video | vLLM (NGC `nvcr.io/nvidia/vllm:26.05+` — stock vLLM lacks sm_121) + ComfyUI | **Orchestrator tier:** Qwen3.8-Flash-Next NVFP4 (RadixArk checkpoint, n-gram table mmap'd per blazux single-Spark recipe). **Worker tier:** `nvidia/Qwen3.6-35B-A3B-NVFP4` (~81 tok/s, official playbook, `--kv-cache-dtype fp8 --enable-prefix-caching --async-scheduling`). **Video:** MiniMax-H3 NVFP4 via ComfyUI + SageAttention 2.2 |
| `amd` | 7900XTX (24GB), i7-14th, 128GB DDR5, Linux | Worker inference overflow | llama.cpp server (HIP) — vLLM ROCm is second-class on RDNA3 | Qwen3.6-35B-A3B GGUF UD-Q4_K_XL (~23GB, ~65 tok/s). Video-eligible **only after** ComfyUI RDNA3 noise bug (Comfy-Org/ComfyUI#15314) is fixed upstream |
| `macmini` | Mac mini M2 Pro, virtual-HDMI dummy plug | **Default control node** + browser simulator | hub process; Playwright/CDP browser | (control plane; no LLM serving by default) |
| `macbook` | MacBook M4 Pro | Ephemeral worker | llama.cpp (Metal) or MLX server | Qwen3.6-27B GGUF or similar; joins/leaves at will |
| `strixhalo` | AMD Strix Halo (future) | Alternate control node | hub process | — |

Model assignments live in config, not code; every serving endpoint is
OpenAI-compatible, so swapping models is a config edit.

**Capability tiers** (what agents request; the gateway resolves to a node/endpoint):

- `orchestrator` — smartest available brain, few sessions (Qwen3.8-Flash-Next on spark)
- `worker` — high-concurrency task work (Qwen3.6-35B-A3B on spark; overflow to amd/macbook)
- `vision` — multimodal understanding (Qwen3.8-Flash-Next or Qwen3.6-35B-A3B, both multimodal)
- `video-gen` — MiniMax-H3 job (spark only in v1)

## 4. Architecture

Three process kinds, all networked over **Tailscale** (no port forwarding,
nodes addressed by tailnet hostname):

```
[DO droplet: caddy reverse proxy + auth]  ──tailnet──┐
                                                      v
[Hub / control plane — active control node]
  ├─ REST + WebSocket API (Fastify)
  ├─ Web UI (pixel-art, static SPA)
  ├─ Telegram bot (grammY, long-polling — no inbound port)
  ├─ Job queue + scheduler (SQLite-backed)
  ├─ Model gateway (capability tier → endpoint resolution)
  ├─ Agent runtime (master, project orchestrators, subagents, assistant)
  └─ State: SQLite (better-sqlite3) + file stores (projects/, memory/)
        │
        ├──tailnet──> [node daemon @ spark]    ─ manages vLLM ×2 + ComfyUI
        ├──tailnet──> [node daemon @ amd]      ─ manages llama.cpp
        ├──tailnet──> [node daemon @ macbook]  ─ manages llama.cpp/MLX (ephemeral)
        └──tailnet──> [node daemon @ macmini]  ─ manages browser simulator
```

**Language/stack:** TypeScript (Node 22) monorepo, npm workspaces. Packages:
`hub`, `node-daemon`, `ui`, `shared` (types, protocol). SQLite for all
relational state. No Kubernetes/Ray — a bespoke thin daemon per node is the
right weight for a 3–5 node personal cluster of heterogeneous machines
(aarch64 CUDA + ROCm + macOS would fight any off-the-shelf cluster stack).

### 4.1 Node daemon

One small daemon per node. Responsibilities:

- Register with the hub (capabilities: arch, VRAM/unified mem, stacks
  available, model files present); heartbeat every 5s.
- Start/stop/monitor serving processes (vLLM, llama.cpp, ComfyUI) as
  instructed by the hub ("profiles": e.g. spark profile `llm-serving` = both
  vLLM instances; profile `video` = ComfyUI with vLLM worker-tier parked).
- Execute jobs dispatched to it and stream results/logs back.
- Report per-process health, memory, and queue depth.

Node loss (missed heartbeats ×3) ⇒ hub marks node offline, re-queues its
in-flight jobs to other nodes with the required capability; if none, jobs
wait in queue (the MacBook-unplugged case: work pauses and resumes on spark
or whichever node frees up).

### 4.2 Control-node switching

The hub is a single process whose state is `data/` (SQLite DB + project and
memory file stores). `data/` is synced to the new control node by
rsync-over-tailnet at switch time (no continuous sync daemon in v1). The UI/Telegram command `/controlnode <name>`
performs: checkpoint DB → sync `data/` → stop hub on old node → node daemon
on new node starts hub → DO proxy re-resolves (both candidates are on the
tailnet; proxy targets a tailnet DNS alias). Mac mini M2 Pro is default;
Strix Halo is a click away for comparison.

### 4.3 Job queue & resource arbitration

Single priority queue in SQLite. Job = {type: llm-session | video-gen |
browser-lease | shell-task, tier, priority, project, payload}. Priorities:

1. Owner-interactive (assistant chat, Telegram commands)
2. Project work (per-project priority set by master orchestrator or owner)
3. Batch (video generation, indexing, housekeeping)

Per-node resource managers enforce admission: each node advertises capacity
per job type (e.g. spark: 48 worker-tier streams, 4 orchestrator-tier
streams, 1 video job). **Spark exclusivity rule:** a `video-gen` job requires
the worker-tier vLLM parked; the scheduler drains/parks worker sessions
(shifting them to `amd`/`macbook` when present), runs the video job, then
restores the LLM profile. Orchestrator-tier vLLM stays resident (it fits
alongside ComfyUI in 128GB with reduced `--gpu-memory-utilization`; if
measurement disproves this, video jobs park it too and orchestrators queue —
policy is config, not code).

## 5. Orchestration model

Adopted from the owner's spec, verbatim in intent:

- **Master orchestrator** — always-on, orchestrator tier. Supervises one
  long-lived orchestrator per active project. **Never holds raw project
  context**: it reads structured briefings (JSON + short markdown) that
  project orchestrators publish on a schedule and on significant events. Can
  create/pause/resume/archive projects and reprioritize or pause any
  project's jobs. Also supervises the personal assistant.
- **Project orchestrator** — one per active project; owns the project's
  knowledge bundle (§6); plans, spawns subagents, reviews their output,
  updates the bundle, publishes briefings.
- **Subagents** — ephemeral workers (worker tier) spawned per task with only
  the spec + pointers they need. Types: coder, researcher, reviewer,
  browser-operator (uses the browser lease), video-producer, etc. Agent
  loop is a simple tool-use loop (OpenAI-compatible tool calling) with tools:
  shell (sandboxed to project workspace), file read/write, web-search API,
  browser lease, spawn-job, and the named external tools (Grok, Gemini) where
  granted.
- All orchestrator/agent conversations are persisted (SQLite) and visible in
  the UI's project rooms.

## 6. Project knowledge bundles (portable context)

Each project = one directory `projects/<slug>/` that is a git repo:

```
projects/<slug>/
  manifest.yaml        # OKF-inspired: id, title, status, priority, owner intent,
                       # links (repos, urls), index of bundle contents, schema ver
  project.md           # living charter: goal, current state, constraints
  decisions.log.md     # append-only decision log (dated entries, rationale)
  briefings/           # published structured briefings (JSON + md), latest.json symlink
  tasks.yaml           # task board: backlog / in-progress / done, owned by orchestrator
  skills/              # project-specific playbooks the orchestrator accumulates
  workspace/           # actual working files / cloned repos
```

Rehydration contract: a project orchestrator cold-started with only its
bundle must produce a coherent briefing and resume work. Pause = stop the
orchestrator session; resume = new session, reads manifest → project.md →
tasks.yaml → recent decisions. This is the anti-context-rot mechanism: the
bundle, not the chat transcript, is the durable memory. The manifest follows
OKF's spirit (self-describing package: metadata + index + assets) in YAML.

## 7. Personal assistant & memory

- Assistant agent (orchestrator tier) with its own memory store
  `memory/`: `MEMORY.md` index (one line per note) + one-fact-per-file
  markdown notes with YAML frontmatter (type: person | preference | routine |
  goal | fact | reference), `[[wikilinks]]` between notes. Git-versioned,
  human-editable. The assistant walks the TOC; no vector DB in v1 (add later
  if recall degrades at scale).
- Owner task state lives in `memory/planner/`: `goals.md`, `todo.md`,
  `backlog.md` — plain markdown lists the assistant maintains.
- **Proactive behaviors** (hub scheduler, not agent-initiated): daily
  briefing at a configured time (assembled from latest project briefings +
  planner state + calendar-free summary of yesterday), configurable check-ins,
  alerts on project blockers or node failures. Delivered via Telegram; long
  briefings also as Telegram voice notes (local TTS, e.g. Kokoro on the
  control node).

## 8. Telegram interface

grammY bot, long-polling (works from behind NAT, no inbound port), owner's
chat ID allowlisted — all other users ignored.

Commands: `/brief` (on-demand daily briefing), `/projects` (status list, inline
buttons to pause/resume/reprioritize), `/goals` `/todo` `/backlog` (view +
add/complete via replies), `/new <project idea>` (master orchestrator
scaffolds a project bundle and confirms), `/nodes` (cluster health),
`/video <prompt>` (queue a video-gen job; result delivered as Telegram video),
`/controlnode <name>`. Free-form messages go to the assistant. Anything the
assistant wants to do that is outward-facing (e.g. post to X via Grok)
requires an inline-button confirmation from the owner.

## 9. Web UI (Pokemon-style)

Static SPA (Vite + TypeScript, canvas-rendered pixel art — no game engine
dependency; the prototype's tile aesthetic is the art direction reference).
Views:

1. **Hub map** — top-down pixel town: one building per project (signboard
   shows status/priority), a "server room" showing nodes as machines with
   live health lights, the assistant's desk, and the Mac mini as a TV
   showing the browser simulator thumbnail.
2. **Project room** — enter a building: orchestrator at the big desk,
   subagents at cubicles; speech bubbles for current activity; side panel
   with live task board (tasks.yaml), briefings, decision log, and streaming
   agent transcripts/logs.
3. **Browser room** — live view of the Mac mini browser (CDP screencast),
   current lease holder badge, lease queue, and a "Take control" button that
   preempts agents (owner always wins).
4. **Queue/nodes panel** — jobs with priorities, per-node capacity gauges,
   video job progress.

Transport: WebSocket state stream from the hub. Auth: single-owner session
login; the DO proxy additionally enforces auth (Caddy + forward-auth) before
anything reaches the tailnet.

## 10. Browser simulator (Mac mini)

Chromium driven via Playwright/CDP rendering on the virtual-HDMI display.
**Lease system:** one holder at a time (agent or owner); FIFO queue with
priority (owner preempts instantly, orchestrator > subagent); lease TTL with
renewal so a crashed agent can't wedge the browser. Agents get a browser
toolset (navigate, read, click, type, screenshot) only while holding the
lease. All sessions recorded (screenshot timeline) for the project log.

## 11. Video generation

Job type `video-gen`: {prompt, mode: t2v | i2v | ref2v, duration ≤15s,
aspect, resolution}. Runs on spark via ComfyUI API (MiniMax-H3 NVFP4,
SageAttention 2.2, 10–14 steps, low-res + SPAN upscale per the published
Spark recipe; ~12 min for 15s 1080p). Outputs land in the requesting
project's `workspace/media/` and are delivered via Telegram/UI.
**License note:** the MiniMax-H3 community license excludes use in the US,
EU, UK, and South Korea without separate authorization from MiniMax, and
requires "MiniMax H3" attribution in commercial products. Owner acknowledges
and owns this decision. 7900XTX becomes video-eligible when
Comfy-Org/ComfyUI#15314 (RDNA3 noise) is fixed.

## 12. External APIs (the only cloud calls)

Named tools, each with per-call audit log (timestamp, agent, purpose,
payload size) visible in the UI:

- `grok` — X/Twitter posting + Grok queries (owner-confirmed before posting)
- `gemini` — YouTube video understanding (URL in, summary out)
- `websearch` — search API (Brave/Tavily-class, configurable)

A hub-level policy blocks all other outbound model/API calls from agents.

## 13. Security

- Everything on the tailnet; zero port-forwards. DO droplet is the only
  public surface: Caddy + auth → hub UI/API only.
- Telegram: owner chat-ID allowlist.
- Secrets in `.env` on the control node only; node daemons receive no API keys.
- Agent shell tools are sandboxed to the project workspace directory.
- Outward-facing agent actions (posting, sending) require owner confirmation.

## 14. Rollout phases (working layers)

Each phase lands as a working increment with its verification:

1. **Skeleton cluster** — monorepo; hub + queue + model gateway + node daemon;
   spark serving both tiers; agent chat end-to-end.
   *Verify:* two concurrent agent sessions stream from vLLM via the gateway.
2. **Multi-node + elasticity** — amd + macbook daemons; capability routing;
   join/leave. *Verify:* kill the macbook daemon mid-job → job re-queues and
   completes on spark.
3. **Orchestration** — master + project orchestrators, bundles, briefings,
   subagent spawning. *Verify:* pause project → restart hub → rehydrate from
   bundle → coherent briefing.
4. **Telegram + assistant** — bot, commands, memory store, daily briefing
   schedule. *Verify:* /new creates a project from phone; briefing arrives on
   schedule with real project state.
5. **UI** — hub map, project rooms, queue panel; browser simulator + lease +
   browser room. *Verify:* watch an agent browse live, preempt it.
6. **Media & edges** — video-gen jobs with spark exclusivity swap; Grok/
   Gemini/websearch tools; DO proxy + auth; control-node switch.
   *Verify:* /video from Telegram returns a clip; /controlnode round-trips.

Development note: phases 1–5 are testable on the dev machine with mock node
daemons and a mock OpenAI-compatible server; real-node configs (Spark NGC
vLLM compose files, llama.cpp units, ComfyUI setup) ship as per-node
playbooks in `deploy/`.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Qwen3.8-Flash-Next single-Spark recipe is a week old (determinism, long-context caveats) | Orchestrator tier only (few sessions); config-swap fallback to Qwen3.6-35B-A3B; pin known-good container digests |
| Spark memory contention (orchestrator vLLM + ComfyUI) | Measured during phase 6; policy fallback = full park |
| H3 license territory exclusion | Documented (§11); owner's decision |
| RDNA3 video bug never fixed | Video stays spark-only; capacity is adequate |
| Control-node switch splits state | Switch is checkpoint-then-sync, refuses to start if sync is stale |
| Tailscale outage | Cluster is LAN-local; tailnet loss only affects remote access |
