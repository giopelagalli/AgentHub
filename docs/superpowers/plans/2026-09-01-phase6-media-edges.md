# AgentHub Phase 6 — Auth, Video Generation, External Tools, Control-Node Switch & DO Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the PRD: the hub is safe to expose (owner login + daemon tokens), video generation runs as a job on the Spark with the LLM/video exclusivity swap, the three sanctioned external tools (Grok, Gemini, web search) exist with an audit trail and confirmation for outward actions, `/video` and `/controlnode` work from Telegram, the control node can be switched between the Mac mini and the Strix Halo, and a DigitalOcean droplet proxies the UI over Tailscale.

**Architecture:** Auth is a Fastify hook: browser sessions via an HttpOnly cookie issued by `POST /api/login` (owner password from env), daemons via `Authorization: Bearer <DAEMON_TOKEN>`; the WebSocket upgrade checks the cookie. Video generation is a `video-gen` job executed by a daemon `video` capability that talks to a local ComfyUI API; the hub's `ResourceManager` performs the Spark swap (park worker-tier serving → run → restore) by driving daemon *profiles*. External tools are `Tool`s with an `audit` wrapper writing `tool_audit` rows; outward ones go through the Phase-4 gate. Control-node switching is a hub-driven procedure using daemon control endpoints (checkpoint DB → rsync `data/` → stop here → start there). The DO proxy is config only (Caddy + Tailscale).

**Tech Stack:** unchanged. Tests use mock HTTP servers for ComfyUI, xAI, Gemini and search.

**Spec reference:** PRD §4.2 (control-node switch), §4.3 (Spark exclusivity), §11 (video), §12 (external APIs), §13 (security), §14 phase 6 acceptance: */video from Telegram returns a clip; /controlnode round-trips.*

## Global Constraints

- Conventions from Phases 1–5 hold.
- Env: `HUB_PASSWORD` (owner login), `HUB_SESSION_SECRET`, `DAEMON_TOKEN`, `XAI_API_KEY`, `GEMINI_API_KEY`, `SEARCH_API_KEY` (+ `SEARCH_PROVIDER=brave|tavily`), `COMFY_URL` per node config. Missing keys disable the corresponding tool with one log line — never crash.
- Auth applies to every `/api/*` and `/ws` route except `POST /api/login` and `GET /api/health`. Daemon-facing routes (`/api/nodes/*`, `/api/jobs/claim|log|complete|fail`, browser act relay) accept the bearer token; everything else requires the session cookie. Tests construct hubs with `auth: { password, daemonToken }` and log in via inject.
- Outbound network policy: agents have no generic `fetch` tool; the only outbound calls are the three named tools + Telegram + ComfyUI on the tailnet. Enforce by construction (no such tool exists), document in README.
- `tool_audit(id, at, session_id, tool, purpose, request_bytes, response_bytes, ok)` row for every external tool call; `GET /api/audit?limit=` route.
- Video payload exactly: `{ prompt: string; mode: 't2v'|'i2v'|'ref2v'; durationSec: 4..15; aspect: '16:9'|'9:16'|'1:1'|'3:4'|'4:3'|'21:9'|'3:2'; resolution: '768p'|'1080p'; imagePath?: string }`. Output `workspace/media/video/<jobId>.mp4` in the requesting project (or memory root `media/` when none).
- Spark exclusivity policy lives in `configs/<node>.yaml` as `profiles: { llm: [serving entry names], video: [serving entry names to keep] }`; the daemon switches by stopping/starting those supervisor entries.

---

### Task 1: Auth (owner session + daemon token) and UI login

**Files:** `packages/hub/src/auth.ts`, server hook, `POST /api/login {password}` → cookie (`hub_session`, HttpOnly, SameSite=Lax, 30d, HMAC-signed with `HUB_SESSION_SECRET`), `POST /api/logout`, `GET /api/me`; `ws.ts` upgrade check; daemon: `Authorization` header on every hub call (`config.hubToken` or env `DAEMON_TOKEN`); UI: `packages/ui/src/panels/login.ts` GB-style password box shown when `GET /api/me` is 401; `net.ts` includes credentials; tests `packages/hub/test/auth.test.ts` (401 without cookie, 200 after login, daemon routes accept bearer only, WS upgrade 401 without cookie), daemon test updated for the header.

**Art rule:** the login box reuses `.gb-panel` styling — no new sprites; if art is needed, escalate.

Commit `feat: owner session auth, daemon bearer tokens, UI login`.

---

### Task 2: Daemon profiles + video-gen executor (ComfyUI)

**Files:** `packages/node-daemon/src/supervisor.ts` (`startEntries(names)`, `stopEntries(names)`; entries gain a `name`), `config.ts` (`profiles?: Record<string, string[]>`, `video?: { comfyUrl: string; workflow?: string /* path to workflow JSON template */ }`), `daemon.ts` (local control server — reuse the Phase-5b Fastify server if present, else add one — `POST /control/profile {name}` protected by the daemon token; registration gains `profiles: string[]`, `video: boolean`), `packages/node-daemon/src/video-gen.ts` (`runVideoGen(payload, { comfyUrl, workflowTemplate, outDir, onLine, signal })`: fill the template (prompt/mode/duration/aspect/resolution), `POST /prompt`, poll `/history/<id>` until done, download the mp4 from `/view`, return `JobResult { data: { path, durationSec } }`), `packages/mocks/src/comfy-mock.ts` (fake ComfyUI: `/prompt` → id, `/history` completes after N polls, `/view` serves a tiny mp4 stub), tests for the executor and the profile switch.

`deploy/spark/README.md` gains the MiniMax-H3 ComfyUI workflow template pointer (`deploy/spark/minimax-h3-t2v.json` — a documented minimal ComfyUI API-format workflow using the four H3 nodes; parameters marked `{{prompt}}` etc.) and the license notice from PRD §11. Commit `feat(node-daemon): serving profiles and ComfyUI video-gen executor`.

---

### Task 3: ResourceManager (exclusivity swap) + video job flow + /video

**Files:** `packages/hub/src/resources.ts` (`ResourceManager.withVideoSlot(nodeName, fn)`: mark the node's `worker` endpoint unhealthy in the gateway → wait until its active streams are 0 (≤ 60s, else proceed) → `POST /control/profile {name:'video'}` → run `fn` → `profile 'llm'` → clear unhealthy), scheduler hook in the daemon claim path (the hub only offers `video-gen` jobs to a node when `ResourceManager` grants the slot — implement as: claim of a `video-gen` job by a node triggers the swap before returning the job; completion/failure restores), `JobRunner` default executor dispatches `video-gen` → `runVideoGen`; Telegram `/video <prompt>` (Phase-4 router) → enqueue `video-gen` (batch priority, project `_telegram`) → on completion the Alerts/Scheduler layer sends the mp4 via `port.send({ video })` (extend `OutgoingMessage` + `GrammyPort.sendVideo`); `POST /api/video {payload, project?}` for the UI/agents; agent tool `generate_video(payload)` (orchestrator tier, batch priority, returns the job id; a later `get_job(id)` tool reads status). Tests: fake daemon with profiles + comfy-mock: swap order verified via recorded profile calls; `/video` on the fake port yields a message with a video buffer.

Commit `feat: video generation jobs with spark exclusivity swap and /video`.

---

### Task 4: External tools (Grok, Gemini, web search) with audit

**Files:** `packages/hub/src/tools/external/{grok,gemini,websearch}.ts`, `packages/hub/src/tools/audit.ts` (wrapper + table via `ensureTable`), server route `GET /api/audit`, mocks `packages/mocks/src/{xai,gemini,search}-mock.ts`, tests.

- `grok_query(prompt)` → xAI chat completions (`grok-4` default, model from env); `post_to_x(text)` — **outward**: returns pending action through the gate; on confirm posts via the xAI/X API adapter (implement the HTTP call behind an interface with a mock; document the real endpoint in `deploy/external-apis.md`).
- `understand_youtube(url, question?)` → Gemini `generateContent` with the video URL as `file_data` (documented format), returns the text.
- `web_search(query, n=5)` → Brave or Tavily by env; returns `[{title,url,snippet}]`.
- All three register into `assistantTools()` and orchestrator `hubTools()` only when their key exists; every call audited; UI: queue panel gains an "Audit" tab? — NO UI in this task; `GET /api/audit` only.

Commit `feat(hub): grok, gemini and web-search tools with audit log and confirmation gate`.

---

### Task 5: Control-node switch + `/controlnode`

**Files:** `packages/node-daemon` control endpoints `POST /control/hub {action:'start'|'stop'}` (runs `config.control.startHub` / `stopHub` argv commands — e.g. `launchctl`/`systemctl` wrappers; registration gains `controlCandidate: boolean`), `packages/hub/src/control-switch.ts` (`switchTo(nodeName)`: 1) `db.pragma('wal_checkpoint(TRUNCATE)')` + `VACUUM INTO data/checkpoint.db`; 2) run `rsync -a --delete data/ <node>:<dataPath>/` via configured argv (`config.control.rsync` template; tests substitute `cp -r`); 3) call target `POST /control/hub start`; 4) respond, then stop self after 2s), routes `POST /api/control/switch {node}`, `GET /api/control` (candidates + current), Telegram `/controlnode [name]` (list or switch, with Confirm/Cancel buttons — outward-ish, destructive), `deploy/control-node.md` (Mac mini ↔ Strix Halo procedure, launchd/systemd scripts, `data/` layout).

Tests: two fake control daemons with `echo`-based scripts and a temp-dir rsync substitute: switch checkpoints, copies, calls start on the target, and the hub reports stopping; refuse switch when the target isn't online. Commit `feat: control-node switch procedure and /controlnode`.

---

### Task 6: DigitalOcean proxy + Tailscale docs + acceptance

**Files:** `deploy/do/Caddyfile` (reverse_proxy to `http://<control-node-tailnet-name>:4000`, HTTPS via Let's Encrypt, `header` hardening, optional basic-auth gate in front of the hub's own login), `deploy/do/docker-compose.yml` (caddy + tailscale sidecar with `TS_AUTHKEY`, `network_mode: service:tailscale`), `deploy/do/README.md` (droplet sizing, DNS, tailnet ACL: droplet may reach only port 4000 on control nodes), README security section; `packages/hub/test/e2e-phase6.test.ts`: login → `/video` from the fake Telegram port with a fake daemon + comfy-mock → video message; `/controlnode strix` on fake daemons → switch sequence recorded; unauthenticated `/api/state` → 401; audit rows exist after a `web_search` scripted call.

Commit `feat: phase 6 acceptance, DO proxy deployment, security docs`.

## Self-review notes

- PRD §13 security → T1 + T6 docs; §11 video (+ license note) → T2/T3; §12 external APIs + audit → T4; §4.2 switch → T5; §4.3 exclusivity → T3; §8 `/video`, `/controlnode` → T3/T5; §14 phase 6 acceptance → T6.
- Not built (documented as future): Kokoro voice notes, MacBook MLX serving alternative, 7900XTX video (blocked upstream).
