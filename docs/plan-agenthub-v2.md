# AgentHub v2 — the workbench, the node network, and other people

Date: 2026-09-22. Status: **decided 2026-09-23** — the owner's answers are recorded in `docs/prd-agenthub-v2.md`
(Goals & non-goals → Decisions), which is now the source of truth for *what*; this file keeps the phases.
Changes from the review: D-installer moves ahead of B (the PC joins through the installer); pi is the
default employee harness with Claude Code optional; F waits but its foundations (ownership, per-node
tokens, the OpenAI door) are built in D.
Parent: `docs/plan-jd-web-agenthub.md` (JD + web door; its Phases 1–2 are Phase C here, unchanged).

## 1. What we're building, in one paragraph

AgentHub today is a single-owner hub on the Spark that plans a project (PRD → roadmap) and runs
turns where a manager delegates to agents on the local Qwen, with Fireworks as the fallback. v2
makes it a place you *work in* rather than a thing you *watch*: every agent is inspectable and
configurable on its own; the app being built is visible live (a web preview or a terminal) and its
code is browsable like a book with a guide beside it; nodes join with one command and can be
removed with one click; the shared browser becomes a pool; images and video render on the PC; JD
can start and drive projects and is reachable from the website, and every member gets a JD of their own; the harness an agent runs in is a
choice (built-in, Claude Code, pi); and, last because it changes everything underneath, other
people get accounts, their own projects, their own nodes, and the ability to borrow yours.

## 2. Decisions to confirm (the ones that change the architecture)

1. **Order.** The phases below run A → G. The two that matter: the workbench (B) lands before
   accounts (F), because you'll use it every day and F is the riskiest change; and the node
   installer (D) lands before F, because a friend's first hour is "install the node," and
   per-node tokens are the same auth work accounts need.
2. **Who gets in.** Invite-only accounts, you are the admin, no open signup. A member owns their
   projects and the nodes they enroll. Nothing is public without a login.
3. **Sharing a node = one model, your priority.** A shared node serves whatever model *you* put
   on it (weights don't swap per user). Your assistant runs at vLLM priority 0, your agents 10,
   a guest's assistant 15, a guest's agents 20 — they get whatever is left, batched with yours.
   Cloud: each member brings their own Fireworks key; the admin can optionally lend the hub's key
   under a per-member daily cap.
4. **Everyone gets a JD.** JD is the product's assistant, not only yours. Each member gets their
   own — named JD by default, renameable — as their *own instance* running on a node they own,
   with their memory on their machine. The installer sets it up ("also install your assistant")
   and picks a model that fits the hardware (an M-series Mac with 32 GB runs a 30B-class MoE
   well; 16 GB gets a smaller one; a box with no capable GPU gets none locally). A member with no
   capable node powers their JD with nodes shared with them, at guest priority. Telegram is
   optional per member (their own bot token); the web chat always works. Your JD keeps its
   name, its memory and its Spark.
5. **Media.** Stills: Qwen-Image; video: Wan 2.2 (or LTX-2) — both via ComfyUI on the 7900 XTX.
   Not MiniMax-H3: it doesn't fit beside Flash-Next on the Spark, and on AMD it has the ROCm noise
   bug plus a license that excludes US use. H3 gets a slot when a second Spark exists.
6. **Harnesses.** The built-in tool loop stays the default and works with any model. Claude Code
   is the first external harness (the `claude` CLI signed in with your subscription on the box
   that holds the workspace — no API key). pi is second (OpenAI-compatible, so it can drive Qwen
   or Fireworks). The DeepSeek agent CLI goes on the same interface if it exists as a CLI when we
   get there. Harness is chosen per employee, with a project default.
7. **Previews go through the hub.** The preview and the terminal are proxied under the hub's login
   at `/preview/<slug>/` and `/term/<slug>`, never raw ports — the website needs that, and so does
   multi-user.

## 3. Facts the plan leans on

- The workspace lives in the project bundle on the hub's `DATA_ROOT`; `run_shell` and the
  workspace tools execute **on the hub host**. `shell-task` jobs can run on any node with a
  `workspaceRoot`, but today's turns don't use them. So "the machine that holds the code" is the
  Spark. Previews, terminals and external harnesses need that machine; the plan keeps the Spark
  as the workspace host and adds a *workspace node* field later only if a project must live
  elsewhere.
- Auth is one password + one shared `DAEMON_TOKEN`; routes are `open | daemon | owner`. Accounts
  replace `owner` with a user, and per-node tokens replace `DAEMON_TOKEN`.
- Nodes register and heartbeat; there is no remove, drain, or enrollment.
- The browser is one lease on the Mac mini's Playwright driver, with a recorder and a proxy.
- The roster (`team.yaml`) is `{id, name, role, avatar, instructions}` per employee; models are
  set per project (`modelPolicy`), not per employee.
- Turn events already carry `memberId`, so a per-agent live view is a filter, not new plumbing.

## 4. Phases

Each phase is a working increment we dogfood on `pomodoro-cli` before the next starts. Sizes are
my estimates of focused work; "you" items are installs, keys, and decisions.

### Phase A — Quick wins (≈3 days, me)

- **Per-employee model.** `TeamMember.model?: ModelPolicy` overrides the project policy for that
  employee; the manager keeps the project's orchestrator model. Drawer gets a Model select
  ("Project default" + the same list as the project picker). `PATCH /api/projects/:slug/team/:id`.
- **Click an agent, see them live.** The employee drawer (and the manager's) gains a *Now* panel:
  status, current task, and the live turn feed filtered to them (tool calls with results and
  timings), above the existing one-on-one chat. Idle agents show their last session's summary.
- **Node remove / drain.** Cluster page: *Drain* (no new work; running work finishes), *Remove*
  (forget the node; its daemon gets a 410 on the next heartbeat and exits with a clear message).
  `DELETE /api/nodes/:name`, `POST /api/nodes/:name/drain`.
- **User guide v1.** `docs/guide.md`, rendered in the UI under *Help* in the rail: concepts (hub,
  nodes, projects, PRD/roadmap/docs/activity, turns, auto-run and the caps, models and Fireworks,
  budgets), how-tos, and troubleshooting (systemd, logs, the three checks). Grows with every
  phase; every phase's acceptance includes "the guide covers it."
- **Acceptance:** Ada on `deepseek-v4p1-flash` while Vex stays local, visible in the drawer; a
  running turn shows Ada's tool calls as they happen when you click her card; removing a node
  makes its daemon exit and the Cluster page forget it; Help opens and answers "how do I add a
  node."

### Phase B — The workbench: preview, terminal, code (≈1.5 weeks, me)

- **Preview.** `manifest.preview = { cmd, port, path? }`, set by the planner when the PRD says
  "web app" or by you in the project header. The hub supervises the process in the workspace,
  proxies `/preview/<slug>/` (HTTP + WebSocket, so HMR works) behind the login, and a *Preview*
  big button opens it in a sheet with restart/stop, a log tail, and open-in-tab. The manager is
  told the base path so it configures the dev server's `base`/`basePath` accordingly.
- **Terminal.** For CLIs (like `pomo`) and for you: a web terminal (xterm.js ↔ node-pty over the
  hub's WebSocket) opened in the workspace. It is *your* shell on the workspace host — fine for
  the owner; in Phase F it is scoped to the member's own workspace on nodes they own.
- **Code.** A *Code* big button: file tree of the workspace, CodeMirror viewer with highlighting,
  editable — a save commits "Owner edit: path" so the next turn sees it. Docked beside it, a
  *Guide* chat persona with read-only tools over the workspace and the bundle ("what does
  `lib/timer.js` do, and why?"). And the book: a **Code map** docs page the manager writes and
  refreshes at each milestone — chapters from entry points down, each line linking
  `path:line` into the viewer. That is the table of contents you read the code through.
  **Tour mode** turns the map into a walkthrough: *Next* steps through the code snippet by
  snippet in reading order, the Guide explains each one — what it does, and why it was done
  that way, citing the decision log — and the explanations are cached as docs pages so the
  second reader (or JD) gets them instantly.
- **Acceptance:** `pomodoro-cli` opens in a terminal and `pomo start 1` rings in the browser;
  a throwaway Vite project shows its page in Preview and hot-reloads when Ada edits it; the Code
  map lists every module of `pomodoro-cli` with working links; the Guide answers a "why" question
  by citing the decision log.

### Phase C — JD drives AgentHub and gets a web door (≈2 weeks, me, in `telegramManager`)

Unchanged from `plan-jd-web-agenthub.md` Phases 1–2: `project_new` (uses the same PRD-from-idea
flow), `project_turn`, `project_pause/resume/priority`, the Projects block in JD's context, `/projects`
in Telegram, reporting rules (your turn → one message when it lands; auto-run → the briefings);
then the connector layer, JD's web API on the Spark, the hub proxying it at `/api/jd/*`, and the
JD page in the UI. The droplet + Caddy + `hub.rosenroot.com` is your afternoon (`deploy/do/README.md`).

- **Acceptance:** "JD, start a project: a habit tracker CLI" from Telegram → the project appears
  in the hub with a PRD; "run a turn on it" → one Telegram message when the turn lands; the same
  conversation continues in the browser at `hub.rosenroot.com`.

### Phase D — Nodes that join with one command, and a browser pool (≈1.5 weeks, me; your installs)

- **Per-node tokens and enrollment.** Cluster page *Add node* mints a one-time enrollment token
  (24 h) and shows the command. The daemon trades it for its own bearer at
  `POST /api/nodes/enroll`; the hub stores a token hash and the enrolling user. `DAEMON_TOKEN`
  stays as the admin's break-glass.
- **The installer.** `curl -fsSL https://hub.rosenroot.com/install.sh | sh -s -- --token …`
  (or the tailnet URL). It detects OS/arch/GPU (nvidia-smi, rocm-smi, Apple Silicon), installs
  Node if missing, fetches the daemon at a pinned tag into `~/.agenthub`, writes `node.yaml`
  (name = hostname, `advertiseHost` = tailnet name when Tailscale is up), probes for an
  OpenAI-compatible server already running (vLLM, llama.cpp, Ollama, LM Studio) and attaches to it
  — otherwise offers a recipe for the hardware (vLLM on NVIDIA, llama.cpp HIP on AMD, llama.cpp
  Metal on Apple) or registers as compute-only (shell tasks, browser) — installs a systemd user
  unit or a launchd agent, enrolls, starts, and prints the node's line from `/api/nodes`.
  Re-running it updates. `agenthub-node uninstall` reverses it.
- **The recipe catalog.** A small table the installer and the Cluster page share: hardware class
  → model + serving stack + memory it needs (Apple Silicon 16/32/64 GB+, NVIDIA 24 GB, DGX
  Spark, AMD 24 GB, CPU-only). Verified by hand per class before it is listed; the JD-on-a-Mac
  case (decision 4) is the first entry after the three boxes we own.
- **An OpenAI-compatible door on the hub.** `POST /v1/chat/completions` on the hub, authenticated
  per member, routed by the gateway with the member's priority and grants. This is how a JD
  instance (or any external harness, Phase G) uses "my nodes or the ones shared with me" without
  knowing where they are. Your JD switches from `SPARK_URL` to it in Phase C.
- **Browser pool.** A browser node advertises `slots`; the lease manager hands out (node, slot)
  pairs; a project holds at most one at a time by default; the Computer page shows every live
  session as a thumbnail with *Watch* / *Take control*. The Mac mini's real desktop (virtual HDMI)
  becomes a separate `desktop` capability for native apps — listed, not built, in this plan.
- **Acceptance:** the 7900 XTX box and the Mac mini both join via the installer with no hand-
  written YAML; two projects browse at once on the mini; removing a node from the UI stops its
  daemon; a recipe-run vLLM on the PC serves the worker tier and `/queue` shows Spark streams
  staying low during a turn.

### Phase E — Images and video on the PC (≈1 week, me; ComfyUI is your install)

- ComfyUI on ROCm on the 7900 XTX; one still and one clip by hand through its UI before any
  wiring. Then `image-gen` (new job type) and `video-gen` (exists) on that node with workflow
  templates in `deploy/amd/`.
- UI: a *Media* panel per project (assets land in the bundle under `media/`, committed); an
  owner prompt box; a `generate_image` / `generate_video` tool for employees with the `designer`
  role; JD: "make me an image of …" → the result as a Telegram photo, via Phase C's tools.
- **Acceptance:** a designer employee produces the app icon for `pomodoro-cli` into `media/`
  during a turn; JD returns a 6-second clip.

### Phase F — Accounts, ownership, sharing, the public site (≈2–3 weeks, me; the friend is the test)

- **Accounts.** `users` (username, password hash, role admin|member), invite links, per-user
  sessions. Your `HUB_PASSWORD` becomes the admin's initial password. Login throttling stays;
  passkeys later.
- **Ownership.** `owner` on projects and nodes; project list = mine + shared with me; a member's
  turns run only on nodes they own or are granted, else their own cloud key.
- **Sharing.** *Share node* → pick a member; the grant carries the priority tier from decision 3.
  The gateway sets `priority` per request from (node owner, requesting user, assistant-or-agent).
  Per-member daily turn caps; Fireworks usage logged per user; optional lending of the hub's key
  under a cap.
- **Their JD.** A node may host a member's assistant: the daemon registers an `assistant`
  capability (`{ url, owner }`), the hub proxies that member's web chat to it at `/api/jd/*`
  (the same door as yours), and the instance calls the hub's OpenAI-compatible door with the
  member's token, so its model comes from their nodes or their grants. The installer offers it;
  JD's repo gets a tagged release the installer can fetch. Memory never leaves their machine.
- **The site.** `hub.rosenroot.com` with real logins replaces the Caddy basic-auth wall (or keeps
  it as a second door for admin only). Terminals and previews scoped to the member's own
  workspaces on their own nodes.
- **Acceptance:** your friend accepts an invite, installs the node on his machine with the
  Phase-D command, creates a project that builds on his node, and — with a grant — runs a turn on
  your Spark while you're chatting with JD without noticing.

### Phase G — Harnesses (≈1–2 weeks, me)

- A `Harness` interface: run one employee task in a workspace with a model, stream events,
  return a report and the files written. `builtin` is today's loop moved behind it.
- `claude-code`: spawns `claude -p … --output-format stream-json` in the workspace on the
  workspace host, maps its events to turn events, reports files written. Needs the CLI signed in
  on that box; nothing in the hub touches your credentials. Check your subscription's usage terms
  before leaning on it for unattended runs.
- `pi`: same shape, pointed at the node's OpenAI-compatible endpoint or Fireworks.
- Chosen per employee in the drawer (`TeamMember.harness`), project default in the header.
- **Acceptance:** the same milestone built by Ada on `builtin`+Qwen and by Ada on `claude-code`,
  both visible in Activity in the same shape, with Vex reviewing both.

## 5. Risks I want on the record

- **This is a quarter of work.** A→G is roughly 10–12 weeks of my focused time plus your installs.
  Each phase ships on its own; the order can change, but F is not a weekend.
- **Public multi-user is a real attack surface.** Terminals, previews, and shell tools on your
  machines mean isolation has to be per-user and per-node, not cosmetic. Invite-only, no open
  signup, and Phase F does not start until D's per-node tokens are in.
- **Qwen as the coder.** The first Spark turn ended with the coder aborted and no report; we need
  a few clean turns before judging. Phase G's harnesses are the hedge.
- **KV cache.** More users and more agents share ~1 M tokens on the Spark; the worker tier moving
  to the PC (Phase D) is what makes sharing comfortable.
- **ROCm.** Every AMD step (llama.cpp HIP, ComfyUI) gets verified by hand on the box before the
  hub depends on it.

## 6. Not in this plan, on purpose

- Open signup, billing, or anything resembling a service. It's you and people you invite.
- A mobile app; the website is responsive and Telegram is the phone surface.
- MiniMax-H3 (see decision 5). Native desktop automation on the Mac mini (listed under D, later).
- Replacing Telegram or JD's memory model.

## 7. What you do vs what I do

| You | Me |
|---|---|
| Confirm §2 (or reorder) | Phase A this week; the guide v1 |
| The PC: Ubuntu, ROCm, Tailscale, ComfyUI, one clip by hand | Workbench (B), then JD (C) |
| The droplet, Caddy, DNS for `hub.rosenroot.com` | Enrollment, installer, browser pool (D) |
| Run the installer on the PC and the mini and tell me what hurt | Media (E), accounts and sharing (F) |
| Invite the friend once F's acceptance passes on a test account; his Mac is the first JD-on-a-Mac | Harnesses (G) |
