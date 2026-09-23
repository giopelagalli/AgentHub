# AgentHub v2 — Product Requirements

Date: 2026-09-23. Status: **decided** (owner review of `docs/plan-agenthub-v2.md` §2 on 2026-09-23; the
decisions are recorded under *Goals & non-goals*). This document is written in the same twelve
sections the hub's own PRD drafter uses, so it can be loaded into AgentHub as a project and built
by it. The phase plan and estimates live in `docs/plan-agenthub-v2.md`; this is the *what*.

## Overview & problem

AgentHub is a self-hosted software team: a hub on the owner's DGX Spark plans a project (idea →
PRD → roadmap) and runs turns in which a manager agent delegates to employees on local models, with
a cloud model as a visible, capped fallback. v1 proved the loop on real hardware (2026-09-22: a
milestone built, tested and reviewed on the Spark + Fireworks) and exposed what is missing.

The problems v2 removes, in the owner's words: agents are a black box while they work; the app
being built cannot be seen or run from the hub; the code cannot be read or understood without
leaving the hub; adding a machine means hand-writing YAML; only one browser session exists; there
is no image or video generation; the assistant (JD) cannot start or drive projects and is not on
the website; the agent's execution harness is fixed; and there is exactly one user.

v2 is a workbench (see the app, read the code, watch each agent), a node network you join with
one command, a media pipeline on the AMD box, JD as a first-class operator of the hub, a choice of
harness per employee with an open-source default, and — last — accounts, ownership and sharing so
that other people can bring their own machines and their own JD.

## Goals & non-goals

**Goals**

- G1. Every agent's work is visible live, and every agent's model and harness can be set per
  employee without restarting anything.
- G2. The app under construction is visible from the hub: a proxied live preview for web apps and
  a terminal for everything else; the code is browsable, editable and explained in place.
- G3. A machine becomes a node with one command and no hand-written config: hardware detected,
  a fitting model recipe chosen or an existing server attached, the service installed, the node
  enrolled under the user who ran the command, visible in the Cluster page within a minute.
- G4. Images and short videos render on the 7900 XTX through ComfyUI and land in the project.
- G5. JD starts, runs, pauses and reports on projects from Telegram and from the website.
- G6. Employees run in an open-source harness by default (pi), with Claude Code and the built-in
  loop as per-employee options; the same turn feed regardless of harness.
- G7. Multi-user is designed in from the start (ownership on every entity, per-node tokens, a
  per-user OpenAI-compatible door) and switched on last; a member gets their own projects, nodes,
  and a JD of their own on a node they own or nodes shared with them.
- G8. Cost stays boring: auto-run is opt-in and capped; cloud use is per-user, visible, and capped.

**Decisions (owner, 2026-09-23)**

- D1. Delivery order: A (done) → **D-installer** (pulled forward: the PC joins through the
  installer, not through hand-written YAML) → B workbench → G harnesses (pi default) → C JD →
  E media → D-browser pool → F accounts. F "can wait", but its foundations are built now where
  retrofitting would be painful (ownership fields, per-node tokens, user-scoped sessions).
- D2. Single user until F; invite-only accounts when F lands; never open signup.
- D3. A shared node serves one model, the owner's; vLLM priority tiers: owner assistant 0, owner
  agents 10, guest assistant 15, guest agents 20. Cloud: own key per member; the admin may lend
  the hub's key under a per-member daily cap.
- D4. Everyone gets a JD: default name "JD", renameable; an instance on a node they own (the
  installer sets it up, with a model that fits the hardware), or on shared nodes at guest priority;
  memory stays on their machine; Telegram optional; web chat always.
- D5. Media on the 7900 XTX via ComfyUI: Qwen-Image for stills, Wan 2.2 (or LTX-2) for video.
  MiniMax-H3 stays out: the ROCm noise bug could be fixed upstream, but its license excludes US
  use and that is not ours to fix. Revisit only if the license changes or a second Spark exists.
- D6. Harness: **pi (pi.dev, open source) is the default for employees**; Claude Code (the signed-in
  CLI, subscription, no API key) is an option; the built-in loop stays as a fallback and remains
  the manager's runtime (it owns the bundle tools: milestones, decisions, docs, verification).
- D7. Previews and terminals are proxied through the hub under the login, never raw ports; a
  project may have its own live browser session.

**Non-goals**

- Open signup, billing, quotas as a product, or any hosted/SaaS form. Owner plus invited people.
- A mobile app (the site is responsive; Telegram is the phone surface).
- Replacing Telegram, JD's memory model, or the OKF markdown memory.
- Native desktop automation on the Mac mini (listed for later; the browser pool comes first).
- Swapping model weights per user on a shared node.

## Users & use cases

**The owner** (Giovanni) — runs the hub on the Spark; starts projects from an idea; watches turns;
reads the code with the guide; sets models and harnesses per employee; adds the PC and the Mac
mini with one command; asks JD "how's rosenroot going" and "make me a 6-second clip of …".

**A member** (a friend, Phase F) — accepts an invite; installs the node on his Mac with the same
command; gets a JD that runs on his Mac; creates his own projects; may be granted the owner's
Spark at guest priority; brings his own Fireworks key.

**JD** (as a client of the hub) — an assistant instance that calls the hub's API with a user
token: creates projects, runs turns, reads briefings, and asks the hub's OpenAI-compatible door
for model completions routed to "my nodes or the ones shared with me".

**Agents** — the manager (built-in loop) and employees (pi by default) working in a project's
workspace on the node that holds it; the reviewer with read-only tools; a designer role for media.

**A node** — any machine with the daemon: serves model tiers, runs shell jobs, hosts a browser
pool, runs a harness for employee tasks, hosts a member's JD, renders media.

## Functional requirements

Numbered so decisions and milestones can cite them. "Owner" means the acting user; in F it is any
member acting on what they own or are granted.

**A — Agents (delivered 2026-09-23; kept here so the roadmap can reference them)**

- FR-A1. `TeamMember.model` overrides the project's model policy for that employee's tasks;
  `PATCH /api/projects/:slug/team/:id { model | null }`; the org-chart card shows a pill.
- FR-A2. Clicking an employee or the manager shows a *Now* section: status, current task, elapsed,
  and a live feed of their tool calls in the running turn; idle shows the last turn's summary.
- FR-A3. Cluster page: Drain (no new work, running work finishes) and Remove (daemon exits on its
  next heartbeat, running jobs requeued, name locked for 60 s). Cloud nodes have neither.
- FR-A4. A Help page renders `docs/guide.md` with a table of contents; every later requirement
  ships with its guide section.
- FR-A5. A turn or employee aborted by a hub stop or the time limit is labelled "cut short";
  a reviewer that never reported is not presented as change requests. `read_file`/`read_bundle`
  page long files (32k characters per page, continuation marker). Turn limit 45 min,
  `TURN_TIMEOUT_MINUTES`.

**B — Workbench**

- FR-B1. **Preview.** A project manifest may declare `preview { cmd, port, path? }`, set by the
  planner when the PRD describes a web app or by the owner in the header. The hub supervises the
  process in the workspace on the workspace host, proxies `/preview/<slug>/` (HTTP and WebSocket,
  so hot reload works) behind the login, and a *Preview* big button opens it in a sheet with
  restart/stop, a log tail and open-in-tab. The manager is told the base path so dev servers are
  configured with `base`/`basePath`. A preview that dies shows its last 50 log lines.
- FR-B2. **Terminal.** A *Terminal* button opens a web terminal (xterm.js ↔ pty over the hub's
  WebSocket) in the workspace on the workspace host; owner-only until F, then scoped to the
  member's own workspaces on nodes they own.
- FR-B3. **Code.** A *Code* button opens the workspace: file tree, viewer with syntax
  highlighting, editable; a save commits "Owner edit: <path>" to the bundle so the next turn sees
  it. Binary and >2 MB files are listed but not opened.
- FR-B4. **Guide chat.** Docked beside Code: a persona with read-only tools over the workspace and
  the bundle that answers "what does this do" and "why", citing `decisions.log.md` entries and
  PRD requirement numbers when they apply.
- FR-B5. **Code map.** A docs page `docs/code-map.md` the manager writes at milestone completion
  (and on a *Refresh map* click): chapters from entry points down, each item a `path:line` link
  that opens the viewer at that line.
- FR-B6. **Tour.** From the Code map, *Start tour* steps through the code in reading order; each
  step shows the snippet in the viewer and the Guide's explanation (what it does, why it was done
  that way, with citations); explanations are generated on first view and cached as docs pages
  under `docs/tour/`, so the second reader (or JD) gets them instantly. *Next* / *Back* /
  *Ask about this*.
- FR-B7. **Per-project live browser** (D7): a project may hold one browser session from the pool
  (FR-D8) and the *Browser* button shows it live with *Take control*.

**C — JD drives the hub**

- FR-C1. JD tools: `project_new(title, intent)` (uses the same PRD-from-idea flow),
  `project_turn(slug, instruction?)`, `project_pause`, `project_resume`, `project_priority`.
- FR-C2. JD's context carries a Projects block from `/api/briefings`: slug, status, order, one
  line of the latest briefing, blocked-on.
- FR-C3. Reporting: a turn the owner triggered → one message when it lands; auto-run turns →
  rolled into the morning and evening briefings; blocked project or dead node → once, immediately.
- FR-C4. Web door: JD's API on the Spark (`:8891`, tailnet, bearer), the hub proxies `/api/jd/*`
  behind its login, and the UI has a *JD* page: chat with inline buttons, voice note in/out.
- FR-C5. JD switches from `SPARK_URL` to the hub's OpenAI-compatible door (FR-D6) so its model
  comes from the same routing and priority rules as everything else.

**D — Node network**

- FR-D1. **Enrollment.** Cluster page *Add node* mints a one-time enrollment token (24 h) bound
  to the acting user and shows the install command. `POST /api/nodes/enroll` trades it for a
  per-node bearer; the hub stores a hash, the owner, and the enrolment time. `DAEMON_TOKEN`
  remains the admin's break-glass and is not needed for enrolled nodes.
- FR-D2. **Installer.** `curl -fsSL <hub>/install.sh | sh -s -- --token …` (also `--hub`) on
  Linux and macOS: detects OS, arch and GPU (nvidia-smi / rocm-smi / Apple Silicon); installs Node
  22 if missing; fetches the daemon at the hub's pinned tag into `~/.agenthub`; probes for an
  OpenAI-compatible server already listening (vLLM, llama.cpp, Ollama, LM Studio) and attaches to
  it; otherwise offers the recipe for the hardware class (FR-D3) or registers compute-only (shell
  jobs, browser); writes `node.yaml`; installs a systemd user unit or a launchd agent; enrolls;
  starts; prints the node's line from `/api/nodes`. Re-running updates in place;
  `agenthub-node uninstall` reverses everything it did.
- FR-D3. **Recipe catalog.** A table shared by the installer and the Cluster page: hardware class
  → model, serving stack, memory needed, expected tok/s. Initial classes: DGX Spark (attach),
  AMD 24 GB (llama.cpp HIP, Qwen3.6-35B-A3B Q4), NVIDIA 24 GB (vLLM), Apple Silicon 16/32/64 GB
  (llama.cpp Metal or MLX, a 30B-class MoE at 32 GB+), CPU-only (none; use shared nodes). Each
  class is verified by hand on real hardware before it is listed.
- FR-D4. **Startup robustness.** The daemon retries registration with backoff for 60 s before
  giving up (a hub that is still starting is not a failure); a 410 means removed and it exits 0.
- FR-D5. **Ownership now.** Every node row carries `owner` (the enrolling user; the admin for
  nodes registered with `DAEMON_TOKEN`). Projects carry `owner`. Single-user until F, but the
  fields exist and are set.
- FR-D6. **OpenAI-compatible door.** `POST /v1/chat/completions` (streaming) on the hub,
  authenticated by a user token, routed by the gateway with the user's grants and priority tier
  (D3); `GET /v1/models` lists what that user may use. This is how JD instances and external
  harnesses reach "my nodes or the ones shared with me".
- FR-D7. **Priority tiers** (D3) are computed by the gateway per request from (node owner,
  requesting user, assistant-or-agent) and sent as vLLM `priority`; llama.cpp ignores it.
- FR-D8. **Browser pool.** A browser node advertises `slots`; the lease manager hands out
  (node, slot) pairs; a project holds at most one at a time by default; the Computer page lists
  every live session as a thumbnail with *Watch* / *Take control*; recordings per session.

**E — Media**

- FR-E1. Job types `image-gen` (new) and `video-gen` on a node with ComfyUI (`video.comfyUrl`);
  workflow templates in `deploy/amd/` for Qwen-Image and Wan 2.2 / LTX-2; parameters: prompt,
  negative prompt, size, seed, and for video: seconds and fps.
- FR-E2. Results are committed to the project bundle under `media/` with a sidecar JSON of the
  parameters; a *Media* panel lists them; the owner can generate from a prompt box.
- FR-E3. Employees with the `designer` role get `generate_image` / `generate_video` tools; the
  manager may ask for an app icon, a hero image, a demo clip.
- FR-E4. JD: "make me an image of …" / "a 6-second clip of …" → a job → the file as a Telegram
  photo or video, or in the web page. Reported once, when it lands.

**G — Harnesses**

- FR-G1. A `Harness` interface: run one employee task in a workspace with a model, stream
  events, return a report and the files written. Implementations: `pi` (default), `claude-code`,
  `builtin`.
- FR-G2. **pi** runs on the workspace host in its non-interactive/programmatic mode with the model
  pointed at the hub's OpenAI-compatible door (FR-D6) or the node's endpoint; its events map to
  turn events (tool calls with results, text, files written); the employee's standing
  instructions and the task are its prompt; its session transcript is stored like the built-in
  loop's. Exact CLI flags are a spike (see Risks).
- FR-G3. **claude-code** runs `claude -p … --output-format stream-json` on the workspace host
  with the CLI signed in there; nothing in the hub touches credentials.
- FR-G4. Chosen per employee (`TeamMember.harness`) with a project default in the header;
  the Activity feed looks the same regardless of harness. The reviewer runs on `builtin` with
  read-only tools until a harness can be restricted to read-only tools.
- FR-G5. The manager keeps the built-in loop (bundle tools, verification, briefings).

**F — Accounts and sharing**

- FR-F1. `users` (username, password hash, role admin|member); invite links (one-time, 7 days);
  the existing `HUB_PASSWORD` becomes the admin's initial password; login throttling stays.
- FR-F2. Sessions carry the user; every route checks ownership or grant; the project list shows
  mine + shared with me; nodes show mine + granted.
- FR-F3. *Share node* → pick a member → a grant with the tier from D3; revocable; the gateway
  filters eligible nodes per user.
- FR-F4. Per-member: own Fireworks key (stored encrypted at rest), optional lend of the hub's key
  under a daily cap; per-member turn cap; usage (tokens, turns, cloud calls) attributed and shown.
- FR-F5. **Their JD** (D4): a node may host a member's assistant (`assistant { url, owner }`
  capability); the hub proxies that member's web chat to it at `/api/jd/*`; the installer offers
  to install it; JD's repo gets a tagged release the installer fetches; memory never leaves the
  member's machine.
- FR-F6. The public site (`hub.rosenroot.com`) uses real logins; terminals and previews are
  scoped per member and per owned node.

**H — Guide**

- FR-H1. `docs/guide.md` is updated in the same change as every feature above; the Help page
  renders it; acceptance of each phase includes "the guide covers it".

## UX & UI

- **Project page** (exists): header with Order / Models / Auto-run / Run turn; big buttons grow
  from four to eight: PRD · Roadmap · Docs · Activity · **Preview · Terminal · Code · Browser**
  (the last four dimmed until the project has a preview command / workspace / browser session).
- **Employee drawer** (exists): Model select (A1) and a **Harness** select (G4) above the Now
  section (A2) and the chat.
- **Code sheet**: three columns — file tree, viewer, Guide chat; a *Map* tab and a *Tour* mode
  with Next/Back and "Ask about this".
- **Preview sheet**: iframe, restart/stop, log tail, open in tab. **Terminal sheet**: full-height
  xterm. **Browser sheet**: the project's live session with Take control.
- **Cluster page** (exists): Add node (token + command), per-node Drain/Remove, owner column
  (F), recipe/hardware column, browser slots.
- **Media panel**: grid of assets with parameters, a prompt box, download.
- **JD page**: chat with inline buttons, voice record/play, the quick keys; per member in F.
- **Admin page** (F): users, invites, grants, per-member caps and usage.
- **Installer output**: plain text, one line per step, ending with the node's `/api/nodes` line.

## Data model

- `User { id, username, passwordHash, role, createdAt }`; `Invite { token, createdBy, expiresAt }`.
- `Node { id, name, arch, owner, tokenHash, enrolledAt, status, draining, endpoints[], jobTypes,
  browser { url, slots }, assistant { url, owner }, video, hardware { class, gpu, memoryGb } }`.
- `EnrollmentToken { token, user, expiresAt, usedAt }`. `Grant { nodeId, userId, grantedBy, at }`.
- `Project.manifest` gains `owner`, `preview { cmd, port, path? }`, `harness` (project default).
- `TeamMember` gains `model` (done), `harness`.
- `MediaAsset { id, project, kind, path, params, createdBy, at }` (files under `media/`).
- `Recipe { class, model, stack, memoryGb, tokS, verifiedOn }` (a checked-in table, not a DB row).
- `BrowserSession { node, slot, holder, since, recording }`.
- `Usage { user, day, turns, tokensIn, tokensOut, cloudCalls, cloudUsd? }`.
- Existing: turns/sessions/transcripts keyed by project and member; bundles as git repos.

## Architecture

- **Hub** (Fastify, SQLite, one process on the Spark): API, UI, WebSocket, gateway, queue,
  lease manager, project service. New: preview supervisor + HTTP/WS proxy (`@fastify/http-proxy`),
  pty server for terminals, the OpenAI-compatible door, enrollment, grants, usage accounting.
- **Node daemon** (Node 22, per machine): serving supervisor (spawn or attach), job runner
  (shell, image-gen, video-gen), browser driver (Playwright, N contexts), **harness runner**
  (pi / claude-code processes in the workspace), assistant hosting (a member's JD), per-node token.
- **Workspace host**: the machine that holds a project's workspace and runs its shell, preview,
  terminal and harnesses — the Spark for now (`workspaceNode` field reserved; not switchable in v2).
- **Installer**: a POSIX shell script served by the hub at `/install.sh`, pinned to the hub's
  release tag; talks only to the hub and to package sources (NodeSource/Homebrew, model downloads).
- **pi**: installed on the workspace host by the installer when the harness is enabled; driven as
  a subprocess; model access through the door.
- **JD** (`telegramManager`, Python): a client of the hub's API and door; hosted on the Spark for
  the owner, on members' nodes for them.
- **ComfyUI** on the AMD node; the daemon submits workflow JSON and polls, as `video-gen` already
  does.
- **Edge**: DigitalOcean droplet, Caddy, Tailscale to the Spark; TLS at the edge; the hub never
  listens publicly itself.

## Security & privacy

- Authn: session cookie (HMAC) per user; per-node bearer tokens (hashed at rest); enrollment
  tokens one-time and expiring; login throttling; passkeys later.
- Authz: every project, node, browser session, preview, terminal and media asset has an owner;
  members act only on what they own or are granted; the admin can act on everything. The
  OpenAI door routes only to nodes the user may use.
- Terminals and previews are shells and servers on real machines: owner-only until F; in F,
  only on nodes the member owns, never on granted nodes; a granted node lends *model
  capacity*, not shell access.
- Secrets: per-member cloud keys encrypted at rest with a hub key from the environment; never
  sent to the UI; never logged. The installer never sees the hub's secrets, only its own token.
- Content from agents, nodes, comments and rendered previews is data, never instructions to the
  hub; the markdown renderer stays escape-first; previews render in a sandboxed iframe.
- Threats handled: a leaked node token (revoke = Remove); a stolen invite (single use, expiry);
  a malicious dev server in a preview (same-origin isolation, no hub cookies reach it — the proxy
  strips them); a member exhausting shared capacity (caps and priority tiers); an agent writing
  outside its workspace (existing containment stays).

## Scalability & performance

- One hub, tens of projects, a handful of nodes, a few users. SQLite is fine at this scale.
- The Spark's KV cache (~1M tokens) is the shared limit: worker stream caps per node, priority
  tiers, and the AMD node taking the worker tier are the levers.
- Latency budget: an employee tool call ≤ 15 s on the cloud flash model, ≤ 45 s on the local
  worker without thinking; a milestone of the pomodoro size ≤ 10 min end to end once the AMD
  node serves workers.
- Previews: one process per project, started on demand, stopped after 30 min idle.
- Media: one render at a time per GPU node; the queue serializes.

## Reliability & operations

- Everything under systemd (Spark, PC) or launchd (Macs); the installer owns those units.
- A hub restart cuts running turns (they are labelled); v2 adds *turn resume*: a turn cut short
  restarts from its last briefing on the next Run turn — already true in practice, now stated.
- Backups: `DATA_ROOT` is the state; nightly `VACUUM INTO` snapshot plus the git bundles; the
  control-node switch remains the migration path.
- Monitoring: the Cluster page, `/api/health`, JD's "node offline" message; usage per user.
- Updates: `git pull && build && restart` on the hub; nodes update by re-running the installer.
- Failure modes: model server down → cloud fallback (visible, capped) or a refused turn under
  Local only; preview crash → its log in the sheet; pi/claude-code missing on the host → the
  employee falls back to `builtin` with a toast and a log line.

## Testing & acceptance

- Unit and integration tests per package as today (vitest); every FR lands with tests; the strict
  OpenAI mock stays the gate for wire shapes.
- Phase acceptance, run on real hardware:
  - **D-installer:** the PC and the Mac mini join with the one-liner; `/api/nodes` shows them
    within a minute with the right hardware class; Remove stops the daemon; re-running updates.
  - **B:** `pomodoro-cli` runs in the Terminal; a Vite project shows in Preview and hot-reloads
    after Ada edits; the Code map links resolve; the Tour explains `lib/cli.js` step by step
    citing the decision log; the Guide answers a "why" question.
  - **G:** the same milestone built by Ada on pi and on claude-code, both visible in Activity in
    the same shape, both reviewed by Vex.
  - **C:** "JD, start a project: …" from Telegram creates it; "run a turn" reports once when it
    lands; the same conversation continues at `hub.rosenroot.com`.
  - **E:** a designer employee produces an app icon into `media/`; JD returns a 6-second clip.
  - **D-browser:** two projects browse at once on the Mac mini.
  - **F:** a test member accepts an invite, installs a node, gets a JD, runs a turn on the
    owner's Spark under a grant while the owner is chatting with his JD — unnoticed.
- Done for v2: every acceptance above passes; the guide covers every screen; the pomodoro project
  is finished by agents end to end using pi.

## Risks & open questions

- **pi's programmatic mode.** The default harness depends on driving pi as a subprocess with a
  custom OpenAI-compatible endpoint, a structured event stream, and a way to limit tools for the
  reviewer. Spike first (one day); if pi cannot be restricted, the reviewer stays on `builtin`.
- **Claude Code under a subscription in unattended runs** is subject to Anthropic's usage
  policy; treat it as an option the owner enables knowingly.
- **ROCm.** Every AMD step (llama.cpp HIP, ComfyUI, Qwen-Image, Wan) is verified by hand before
  the hub depends on it. H3 stays out for its license regardless of the noise bug.
- **Workspace host.** Previews, terminals and harnesses run where the workspace is — the Spark.
  If that gets crowded, `workspaceNode` becomes real (a project's workspace on the PC) — designed
  for, not built, in v2.
- **Public multi-user is an attack surface.** F does not start until D's tokens and ownership are
  in and exercised single-user for a while; invite-only, no open signup.
- **Local model behaviour.** The Spark's Qwen is a good planner and a slow, sometimes self-doubting
  worker; DeepSeek flash on Fireworks was decisively better as the coder. The default employee
  model on the Spark is a knob, not a promise, until the AMD worker exists.
- **Open:** whether the manager should also run on pi eventually (needs bundle tools as pi
  extensions); whether recordings of browser sessions are kept per member (privacy); how JD's
  repo is published for the installer (tag on a private repo with a deploy key vs. a public
  release); the exact Mac recipe for the friend's machine (chip and RAM unknown).
