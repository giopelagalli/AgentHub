# JD on the web, wired to AgentHub — the build plan

Date: 2026-09-21. Status: agreed direction, nothing below built yet unless marked.

## What we're building, in one paragraph

JD stays one person with one memory, and gains hands and a second door. **Hands:** AgentHub runs
on the Spark as the execution engine, JD drives it (start a project, run a turn, pause), reads its
briefings, and reports progress in the same voice he reports anything else. **Door:** a website at
`hub.rosenroot.com`, behind the DigitalOcean proxy AgentHub already designed, where you log in,
see projects, chat with JD, and talk to him hands-free. Telegram stays exactly as it is; it becomes
one connector among several (web now, Discord and email after). Claude, signed in on the Spark,
becomes the orchestrator brain for project work; the local Qwen does the volume.

```
 phone ── Telegram ──┐                     ┌── vLLM :8888  (Qwen, priority 0 for JD, 10 for agents)
 browser ── https ── droplet (Caddy) ──tailnet──▶ Spark ──┤── voice :8890  (whisper / kokoro / embeddings)
   hub.rosenroot.com   basic auth + hub login            │── JD core :8891  (connectors: telegram, web, …)
                                                          │── AgentHub hub :4000 + node daemon
                                                          └── Claude (Anthropic SDK login) for orchestrator turns
```

## Decisions (confirm the first two, the rest are mine)

1. **The Spark is the control node.** The hub, the node daemon, JD and the model all live on the
   one always-on box. The Mac mini joins later as the browser node, not as the hub. Reason: one
   machine to keep alive, no cross-machine state, the Spark is already the thing that's on.
2. **`hub.rosenroot.com` for the site; the apex stays free for the learning app.** One site, one
   login: the AgentHub UI gets a JD page instead of running a second assistant.
3. **JD is the only assistant.** AgentHub's built-in assistant and its Telegram bot stay off. Its
   project machinery (orchestrators, master, briefings, jobs, browser lease) is what JD uses.
4. **The browser only ever talks to the hub.** JD's web API is on the tailnet; the hub proxies to it
   with a server-held token. No second login, no second public surface.
5. **"Calls" ship as a hands-free loop first, true telephony-grade duplex later.** Mic → voice
   activity detection in the browser → JD → spoken reply → listening again. Same pipeline as a
   Telegram voice note, no WebRTC stack. It's a 5–6 s exchange, which is the model's time anyway.
6. **Progress reaches you the way everything else does: few messages, on schedule.** A turn you
   asked for reports back when it lands. Auto-run turns roll up into the morning briefing and the
   evening wrap-up. Blocked projects and dead nodes are the only things that interrupt.

## Phases, in the order that unlocks the next

### Phase 0 — the Spark hosts AgentHub (mostly your keyboard, one small code change from me)

- **Hub on the Spark.** Node 20+, clone AgentHub, `npm install`, `npm run build:ui`, hub under
  systemd with `HUB_PASSWORD`, `HUB_SESSION_SECRET`, `DAEMON_TOKEN`, `PROJECTS_ROOT`, data under
  `~/agenthub-data`. Port 4000, tailnet only.
- **Node daemon on the Spark, attached to the existing vLLM.** Code change in AgentHub: a serving
  entry may omit `cmd` (attach mode: no process to supervise, just register and health-check the
  URL). Both tiers → `http://localhost:8888`, model `qwen3.8-flash-next`, `priority: 10`,
  `maxStreams` 3 and 2. Merge `feat/vllm-request-priority`. `jobTypes: ["shell-task"]`, no
  `video-gen`.
- **Claude on the Spark.** `ant auth login` as `giospark1`; hub env `CLOUD_ANTHROPIC=1`. Default
  project policy: orchestrator on Claude, workers local (`prefer: local` for the worker tier).
  That's the batching story: one Claude turn fans out to N local workers on Qwen, at priority 10,
  behind JD.
- **Acceptance:** `curl localhost:4000/api/health` → ok; `/api/nodes` shows `spark` online with
  two endpoints; a test project's first turn completes on Claude + Qwen; JD keeps answering in
  under 5 s while a turn is running.

### Phase 1 — JD drives AgentHub (~1 day, me)

- JD tools: `project_new(title, intent)`, `project_turn(slug, instruction?)`, `project_pause`,
  `project_resume`, `project_priority`. Natural language does it: "start a project: …", "run a
  turn on rosenroot, focus on the ingest", "pause the probability engine".
- JD's context carries a **Projects** block from `/api/briefings`: slug, status, priority, one
  line of the latest briefing, blocked-on if any. So "how's rosenroot going" is a plain answer.
- `/projects` command: each project as a button → status + latest briefing, with Run turn / Pause /
  Resume / Priority buttons, same in-place pattern as `/courses`.
- **Reporting rules:** a turn *you* triggered → one message when it lands ("Rosenroot turn 8:
  built the ingest worker, tests green. Next: the stream view."). Auto-run turns → rolled into the
  morning and evening briefings ("Projects: rosenroot 2 turns, probability-engine blocked on the
  odds API key"). Blocked / node offline → immediate, once, via the existing proactive budget.
- **Acceptance:** start a project from Telegram, watch it appear in the hub UI, get one message
  when its turn finishes, see it in the next briefing.

### Phase 2 — JD gets a web door (~3 days, me + one Caddy afternoon for you)

- **Connector layer in JD.** `Connector` = `send(outbound)`; the Telegram sender becomes one;
  proactive messages fan out to every connected connector (Telegram always, web when a browser is
  attached). Buttons, voice, edits already live on `Outbound`, so the web renders the same things.
- **JD web API on the Spark, `:8891`, tailnet only, bearer token.** `POST /messages`
  (text → replies), `POST /voice` (audio in → transcript + reply text + reply audio), `POST /photo`,
  `POST /callback` (a button tap), `WS /stream` (proactive messages and typing state pushed to the
  browser). Same router underneath; nothing forks.
- **Hub proxies it.** `/api/jd/*` → JD with the token, behind the hub's session cookie; the UI gets
  a **JD** page: chat with inline buttons, voice-note record/play, the quick keys. The hub's own
  assistant page points here.
- **The droplet.** Follow `deploy/do/README.md` as written: $6 droplet, Tailscale, Caddy, basic
  auth, `hub.rosenroot.com` A record, proxy to `spark-f9a9:4000`. Stateless; rebuildable.
- **Acceptance:** log in at `hub.rosenroot.com` from your phone's browser and from a laptop, send
  JD a message there, get the reply in the browser *and* see it in the Telegram transcript later;
  tap a check-in button on the web; record a voice note and get one back.

### Phase 3 — call mode (~2 days, me)

- **Hands-free loop in the JD page.** Press Call: the browser listens, detects when you stop
  talking, sends the clip, plays JD's reply as it arrives, listens again. Interrupting works by
  talking. Ends on Hang up or 10 s of silence twice.
- **Streaming to cut the wait:** reply text streams into the page; speech is synthesized per
  sentence and played in order, so the first words arrive in ~2 s instead of after the whole reply.
- **Later, if this feels laggy:** WebRTC with a streaming STT and a duplex voice model on the Spark.
  Not now; the loop gets 80 % of the feeling for 10 % of the work.
- **Acceptance:** a two-minute conversation without touching the screen; a Telegram message sent
  during the call shows up in the transcript in order.

### Phase 4 — more connectors (~1 day each, me)

- **Discord:** a DM with the same bot; same connector interface; useful when you're on desktop.
- **Email:** inbound only at first — forward a syllabus, a newsletter, a receipt, and it goes
  through the same ingest as a Telegram document. Outbound email later if ever needed.
- **Acceptance:** each connector passes the same six-message conversation test as Telegram.

### Phase 5 — JD works on himself (~2 days, me; the guardrails are the work)

- A standing AgentHub project pointed at the `telegramManager` repo. JD can say "I'd like to
  add X" (from your requests or his own notes), the orchestrator implements it on a branch, runs
  the suite, and JD reports: "Built X on branch jd/x, 412 tests green. Deploy?" **Deploy is a
  button, never automatic.** Yes → the Spark pulls the branch, restarts, and JD confirms he's back.
- Guardrails: no direct pushes to `main`; tests must pass; secrets never in the bundle; a rollback
  button that redeploys the previous commit; JD can't approve his own deploy.
- **Acceptance:** one real feature goes from "JD, add …" in Telegram to running on the Spark with
  you tapping exactly one button.

### Phase 0b — the 7900 XTX box joins as the second node (your install, my JD tools)

The desktop (Radeon 7900 XTX 24 GB, i7 14th gen, 128 GB RAM, Linux) is the right home for two
things the Spark shouldn't carry:

- **Worker-tier LLM.** AgentHub's own AMD playbook (`deploy/amd/README.md`): llama.cpp with the
  HIP build serving `Qwen3.6-35B-A3B` Q4 (~23 GB, ~65 tok/s, 4 parallel streams). Every subagent
  turn lands here instead of on the Spark, so the Spark's KV cache is JD's and the orchestrator's
  alone. This is the real concurrency win; priority scheduling is the backstop. llama.cpp ignores
  the `priority` field, so the AMD entry doesn't set one.
- **A second serving profile: one big model, slowly.** The same box can run a 100–235B-class MoE
  with experts in the 128 GB of system RAM and attention/KV on the GPU (llama.cpp `--n-cpu-moe`,
  or KTransformers' ROCm beta). Decode is bound by RAM bandwidth — dual-channel DDR5 is ~80–95 GB/s,
  so a model with ~20 B active parameters at Q4 lands around 5–8 tok/s. Fine for a private local
  fallback when the Spark reloads, or a second opinion; not for a worker pool. The GPU can't hold
  both at once, so this is an AgentHub *profile* the hub switches to on purpose, not the default.
- **Image and video.** For anything that fits in 24 GB the 7900 XTX is several times faster per
  step than the Spark (≈960 GB/s memory bandwidth vs ≈270, and far more FP16 compute). The Spark's
  128 GB only helps for models bigger than 24 GB, which it would then run slowly and which don't fit
  next to Flash-Next anyway. So: ComfyUI on ROCm on the PC, `video-gen` and an `image-gen` job type
  here, none on the Spark.
- **Which model:** not MiniMax-H3. AgentHub's notes record two blockers: the ROCm noise bug
  (Comfy-Org/ComfyUI#15314) and a license that excludes US use. Wan 2.2 (5B, or 14B in fp8/GGUF)
  and LTX-2 both have native ComfyUI support and run on RDNA3; Flux for stills. Verify on the box
  before wiring the job type: one clip by hand through ComfyUI's UI first.
- **JD side:** "make me a 6-second clip of …" / "generate an image of …" → an AgentHub job → the
  result arrives as a Telegram video/photo (the hub's `/video` path already does this) or in the
  web page. Reported like any other job: once, when it lands.
- **Acceptance:** `/api/nodes` shows `amd` online with a worker endpoint; a project turn's
  subagents run there (visible in `/queue`: Spark streams stay low); one clip rendered on the PC
  and delivered to Telegram.

Box-level for the PC: Ubuntu 24.04, ROCm (current stable), Tailscale, always on, the daemon under
systemd per the playbook. Power: it's a desktop GPU running around the clock; budget for it.

### Not in this plan, on purpose

- Rosenroot the learning app; the apex domain is reserved for it.
- Replacing Telegram; it stays the phone-side surface for good.
- MiniMax-H3 anywhere (ROCm bug + license); revisit if both change.

## Risks I want on the record

- **KV cache is the shared resource.** ~1M tokens in flight on the Spark. With the worker tier on
  the PC only JD and the orchestrator share it; if the PC is off, workers fall back to the Spark at
  priority 10 and "first" still waits when it's full. `/queue` is where you see it.
- **Model reloads.** ~10 minutes, during which JD falls back to Fireworks and AgentHub turns fail
  or wait. Recipe updates happen on your schedule, not auto.
- **Two boxes at home, one internet connection.** When home internet is down, everything is down
  except the droplet's login page. The droplet-as-blind-failover idea from before is still available if that
  ever bites.
- **The AgentHub attach-mode change** is small but it's in a codebase I've only read pieces of;
  its 773 tests are the safety net.

## What you do vs what I do

| You | Me |
|---|---|
| Confirm decisions 1 and 2 | Attach mode + priority merge in AgentHub |
| Node + AgentHub install on the Spark, env, systemd | JD ↔ AgentHub tools, context, `/projects`, reporting |
| The PC: Linux, ROCm, Tailscale, llama.cpp worker, ComfyUI, one clip by hand | Image/video request tools in JD, delivery to Telegram and web |
| `ant auth login` on the Spark | Connector layer, JD web API, hub JD page |
| Droplet, Tailscale, Caddy, DNS for `hub.rosenroot.com` | Call mode |
| Try each phase for a day before the next | Discord, email, the self-improvement loop |
