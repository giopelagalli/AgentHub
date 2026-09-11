# AgentHub

Local multi-node AI agent hub. See docs/superpowers/specs/2026-09-01-agenthub-prd-design.md.

## Dev quickstart

    npm install
    npm test                  # full suite (mock cluster, no network)
    npm run dev:hub           # hub on :4000
    npm run dev:node          # dev node daemon + two mock model servers

    # talk to an agent
    curl -s -X POST localhost:4000/api/agents -H 'content-type: application/json' \
      -d '{"name":"helper","tier":"worker","systemPrompt":"You help."}'
    curl -N -X POST localhost:4000/api/agents/1/messages \
      -H 'content-type: application/json' -d '{"text":"hello"}'

## UI

The hub has a browser UI: a flat management app over the hub WebSocket,
four pages down a left nav.

**Projects** — the project list on the left (searchable, ←/→ to move), and
the selected project's org chart on the right: you, then the assistant and
the master, then that project's manager, then its employees, each a card
with an avatar, a role and who they report to. Clicking a manager or an
employee opens a one-on-one chat drawer that streams the reply in; the
assistant card opens the assistant's chat with its confirmation gate, and
the master card shows the briefings every project has published. The header
sets priority, pauses or resumes, runs a turn, and hires — name, role,
avatar, standing instructions — with an × on a card to let someone go.

**Computer** — the cluster's shared browser (the Mac mini's Chromium,
deploy/macmini/README.md) as a live JPEG screencast; the hub polls the
browser node only while somebody is on this page. Beside it, the lease
desk: who holds it, who is queued behind them. One holder at a time,
priority owner > orchestrator > subagent, renewed by every action and
expiring after 120s of silence so a dead agent can't wedge it; [Take
control] preempts the holder (whose next action comes back `lease lost`)
and releasing hands the browser to the next in the queue. Everything an
agent does is recorded frame by frame under `data/media/browser/<leaseId>/`.

**Cluster** — the nodes table (status, what each serves, active streams per
tier, browser/video/control capability) and the job queue, both live off
the hub state broadcast.

**Allocation** — what runs first: every unfinished project ordered by
priority then last touched, with the priority lever on each row. The master
reorders these during its briefings; your setting wins until it changes it
again.

Dev (three terminals, hot reload):

    npm run dev:hub           # hub on :4000
    npm run dev:node          # dev node daemon + mock model servers
    npm run dev:ui            # vite on :5173, proxying /api and /ws to :4000

Then open http://localhost:5173.

Prod (hub serves the built app itself):

    npm run build:ui          # writes packages/ui/dist
    npm run dev:hub           # then open http://localhost:4000

Real-node setup: deploy/spark/README.md, configs/README.md.

## Orchestration

A project is a portable knowledge bundle — a git repo under
`data/projects/<slug>/` (`manifest.yaml`, `project.md`, `decisions.log.md`,
`tasks.yaml`, `briefings/`, `skills/`, `workspace/`). One long-lived
`ProjectOrchestrator` per active project runs bounded *turns*: it rebuilds its
context from the bundle on disk (never from memory), plans and delegates
concrete work to ephemeral subagents, keeps `tasks.yaml` and
`decisions.log.md` current, and ends by publishing a structured briefing —
every write is a git commit (`agent: <summary>`). Because a turn's whole state
lives in the bundle, a project can be paused, the hub restarted, and the
project rehydrates from disk into a coherent next turn.

The `MasterOrchestrator` supervises the fleet of projects but never reads
their raw context — only the `briefings/latest.json` each one publishes — and
answers owner commands (pause, resume, reprioritize, run a turn now) by
calling into the relevant project.

By default a scheduler runs one turn per active project every 15 minutes
(highest priority first); `POST .../turn` runs one immediately.

API cheatsheet:

    POST /api/projects                        {slug, title, intent, priority?} → create
    GET  /api/projects/:slug                   → {manifest, briefing, tasks}
    POST /api/projects/:slug/turn              {instruction?} → Briefing
    POST /api/projects/:slug/pause             POST /api/projects/:slug/resume
    GET  /api/projects/:slug/transcript        → this project's agent sessions
    GET  /api/briefings                        → latest briefing per project
    POST /api/master/brief                     → the owner's daily briefing

Set `PROJECTS_ROOT` to change where project bundles live (default
`data/projects`).

Each bundle's git history is its version log: nested checkouts under
`workspace/` and their `node_modules` are excluded via the scaffolded
`.gitignore`, and `manifest.yaml`'s `index` lists only knowledge files
(`manifest.yaml`, `project.md`, `decisions.log.md`, `tasks.yaml`, plus
`skills/` and `briefings/`), not the workspace.

## Assistant & Telegram

The hub runs a personal assistant agent with a git-versioned markdown memory
(`MEMORY.md` index + one-fact-per-file notes under `notes/`, plus
`planner/{goals,todo,backlog}.md`) and, when configured, control from
Telegram: commands, free-form chat, a daily briefing, check-ins, and alerts
(node offline, project blocked). None of this loads a `.env` file — set the
variables below in the environment the hub process actually runs under (see
`deploy/macmini/README.md` for the launchd unit).

Env vars (see `.env.example`):

    MEMORY_ROOT             where the memory bundle lives (default data/memory)
    TELEGRAM_BOT_TOKEN      from @BotFather; see deploy/telegram.md
    TELEGRAM_OWNER_CHAT_ID  your own Telegram user id (@userinfobot), the only sender
                            the bot acts on; see deploy/telegram.md
    BRIEFING_TIME           local HH:MM for the daily briefing (default 08:00)
    CHECKIN_TIMES           comma-separated local HH:MM list (default 13:00,18:00)

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` are both required for the
bot to start; with either missing the hub logs one line and runs the
assistant over HTTP only (`/api/assistant/messages` etc., used by the UI's
reception desk chat).

Commands:

    /help                        this list
    /brief                       the daily briefing across every project
    /projects                    project status, with pause/resume/run-turn buttons
    /goals, /todo, /backlog      view a planner list
      ... add <text>             append an item
      ... done <n>                tick off item n
    /new <title>: <intent>       start a new project; replies again once its first turn lands
    /nodes                       cluster health
    /video <prompt>              queue a clip; it arrives as a video message when it renders
    /controlnode [name]          list control-node candidates, or move the hub to one
                                 (Confirm/Cancel — it stops the hub on this machine)

Anything else is sent to the assistant, which can read/search memory, edit
the planner, and manage projects. An outward-facing action (posting to X) never
runs on its own — the assistant replies with inline `[Confirm] [Cancel]`
buttons and only Confirm from the owner's own chat executes it.

Voice notes are not built: `TelegramPort`'s `OutgoingMessage.voice` field and
a future `VoiceAdapter` interface are where a Kokoro TTS hookup would plug in
(text in, spoken `Buffer` out, sent instead of/alongside the text reply) —
see `deploy/telegram.md`.

## External APIs & outbound policy

Agents have **no generic fetch tool**. Four named tools across three services
are the only HTTP calls an agent's belt can make: no agent tool makes an
unaudited HTTP call, enforced by construction rather than by a filter.

    grok_query(prompt)              POST api.x.ai/v1/chat/completions
    post_to_x(text)                 POST api.x.com/2/tweets       (owner-confirmed)
    youtube_understand(url, q?)     POST generativelanguage.googleapis.com/.../generateContent
    web_search(query, n?)           api.search.brave.com or api.tavily.com

`post_to_x` is outward: it proposes through the confirmation gate and returns
`pending confirmation <id>`; nothing is posted until the owner confirms
(`POST /api/assistant/pending/:id/confirm`, or the Telegram Confirm button).
Posting also needs an X *user-context* token — a hand-pasted OAuth2 one expires
in ~2h; see `deploy/external-apis.md`.

Two belts sit outside that ledger and are the residual holes:

- `run_shell` runs commands in a project workspace, and a command can open its
  own socket where the audit log can't see it.
- `browser_navigate` / `browser_type` (and the rest of `BROWSER_OPS`) drive the
  shared browser at a real site of the agent's choosing. Those actions are
  **frame-recorded, not audited**: the screenshot timeline under
  `<DATA_ROOT>/media/browser/<leaseId>/` shows what happened, but no
  `tool_audit` row is written and the destination is not constrained to an
  allowlist.

Neither is closable in the tool belt. Sandbox `run_shell` at the OS/network
level if that matters, and treat the browser node's own egress as the boundary
for the browser ops (`deploy/macmini/README.md`).

The hub's own non-agent outbound traffic is Telegram (bot API, owner chat
only); everything else it talks to — node daemons, ComfyUI, the served models
— is on the tailnet.

Every external call writes one `tool_audit` row: timestamp, session, tool,
purpose, request and response byte counts, and whether it succeeded (failures
and timeouts included). Read it as the owner with `GET /api/audit?limit=`.

Keys (hub process on the control node only — daemons never get them):

    XAI_API_KEY             grok_query, and post_to_x's fallback credential
    X_API_KEY               X API v2 token with tweet.write, for post_to_x
    GEMINI_API_KEY          youtube_understand
    SEARCH_PROVIDER         brave | tavily
    SEARCH_API_KEY          that provider's key
    XAI_MODEL, GEMINI_MODEL optional overrides (grok-4, gemini-2.5-flash)

A missing key disables its tool with one log line at startup — the hub still
starts. Endpoints, payload shapes and where to get each key:
`deploy/external-apis.md`.

## Cluster (real nodes)

Beyond `npm run dev:node`'s mock daemon, real nodes each run the node
daemon against their own config over Tailscale (see deploy/tailscale.md):
deploy/spark/README.md, deploy/amd/README.md, deploy/macbook/README.md,
deploy/macmini/README.md (control node — runs the hub and the shared
browser, no LLM serving by default).

**Bring a node up:** start its serving process(es), then the daemon:

    npx tsx packages/node-daemon/src/main.ts configs/<node>.yaml

The daemon starts its `serving` processes, registers the node with the hub,
heartbeats every `heartbeatMs` (default 5s), and — if the config has
`jobTypes` — starts claiming jobs of those types from the hub's queue. On
real nodes this normally runs under systemd (Linux) or launchd (macOS); see
each node's playbook for a unit/plist sketch.

**Take a node down:** `SIGINT`/`SIGTERM` the daemon (`systemctl stop`,
`launchctl unload`, or Ctrl-C) — it stops the job runner and its serving
processes, but doesn't tell the hub it's gone. The hub notices only via
missed heartbeats: after three misses it marks the node offline and
re-queues any jobs still assigned to it, so they go to another node with
the required capability, or wait in the queue if none is free. A job
already claimed and running when its node disappears is not resumed
in-place — it's requeued and re-run from scratch on whichever node picks
it up next.

## Running without GPUs (cloud tier)

`CLOUD_ANTHROPIC=1` gives the hub a synthetic, always-online node called
`cloud-anthropic`: the orchestrator and worker tiers are served by Claude
through the official Anthropic SDK instead of by a local endpoint, so the
whole system runs with no GPU node registered at all. Credentials come from
the SDK's own resolution — `ANTHROPIC_API_KEY`, or an `ant auth login`
profile — and the models default to `claude-opus-4-8` (orchestrator) and
`claude-sonnet-5` (worker); `CLOUD_ORCHESTRATOR_MODEL` and
`CLOUD_WORKER_MODEL` override them.

    CLOUD_ANTHROPIC=1 npm run dev:hub
    # [hub] cloud tier: anthropic (opus-4-8 / sonnet-5)

The node is the hub's own bookkeeping, not a machine: it has no daemon (the
hub refreshes its heartbeat on every sweep, so it is never swept offline),
claims no jobs, and can serve no browser, video or control-node capability —
none of those are reachable through an API key. Local nodes stay preferred:
`ModelGateway.pick()` sorts local endpoints ahead of cloud ones for the same
tier, so the cloud is used only when nothing local has capacity for it.

## Security

The hub holds the owner's memory, projects, API keys and a shared browser, so
past Phase 6 it is expected to run *authenticated*, and the only thing that
should be able to reach port 4000 is the tailnet (plus the DO droplet's Caddy,
`deploy/do/README.md`).

    HUB_PASSWORD        the owner's password. Unset, auth is disabled entirely
                        and every route is open — dev-only.
    HUB_SESSION_SECRET  HMAC key for session cookies. Unset, a random key is
                        generated and every restart logs the owner out.
    DAEMON_TOKEN        shared bearer every node daemon sends. Unset, no daemon
                        can register or claim jobs.
    TRUST_PROXY         set only when the hub sits behind the DO proxy: `1` to
                        trust any proxy, or the proxy's tailnet IP/CIDR (safer).

Browsers authenticate with an HttpOnly, SameSite=Lax, HMAC-signed `hub_session`
cookie from `POST /api/login` (30 days); daemons send
`Authorization: Bearer $DAEMON_TOKEN` and may only reach the registration, claim
and job-report routes — a leaked daemon token cannot drive the owner's browser
or read memory. Everything under `/api/` and the `/ws` upgrade is guarded except
`POST /api/login` and `GET /api/health`, classified on the *matched route* so a
percent-encoded path cannot slip past. Five failed logins lock a client out for
15 minutes.

`TRUST_PROXY` matters more than it looks: behind Caddy every request arrives
from the proxy's address, so without it the login throttle counts all attempts
as one client and one attacker's five failures lock the owner out. With it,
`X-Forwarded-For` names the real client and `X-Forwarded-Proto` marks the
session cookie `Secure`. Do not set it on a hub anything else can reach
directly — those headers are then attacker-controlled.

## Deploying

The whole system, from the outside in:

1. **Control node** — the machine running the hub (`packages/hub`), normally
   the Mac mini under launchd: it owns `data/` (SQLite, memory bundle, project
   bundles, media) and every API key. `deploy/macmini/README.md`. Moving it to
   the Strix Halo is one `/controlnode` away: `deploy/controlnode.md`.
2. **Nodes** — every other machine runs the node daemon against its own config
   over Tailscale (`deploy/tailscale.md`, `configs/README.md`): the Spark serves
   models and renders video through ComfyUI (`deploy/spark/README.md`), the Mac
   mini hosts the shared browser, the AMD box and MacBook add capacity
   (`deploy/amd/README.md`, `deploy/macbook/README.md`). Each daemon registers
   with the hub, heartbeats, and claims jobs it has the capability for.
3. **Telegram** — the phone-side control surface: `deploy/telegram.md`. It is
   the only thing that needs to work when you are away from the hub UI.
4. **DO proxy** — a $6 droplet on the tailnet running Caddy, which is the only
   machine with a public listener: it terminates TLS for your domain, gates
   everything behind HTTP basic auth as a second factor, and reverse-proxies to
   the control node's `:4000` over the tailnet. `deploy/do/README.md`.

External API keys: `deploy/external-apis.md`. Nothing here needs a router port
forward or a public IP on any machine but the droplet.

## Status

| Phase | Delivered |
| --- | --- |
| 1 | Monorepo skeleton: hub (node registry, SQLite job queue, model gateway, agent runtime, REST/SSE) + node daemon (process supervisor, register/heartbeat), two concurrent streaming sessions against a mock model. |
| 2 | Elastic multi-node cluster: nodes advertise job types and run `shell-task`s; a node dying mid-job requeues it onto another capable node; per-node deployment playbooks. |
| 3 | Orchestration: portable project bundles, one long-lived orchestrator per project delegating to ephemeral subagents, master orchestrator, briefings, rehydration after a restart. Plus the management UI over the hub WebSocket. |
| 4 | Telegram control and the personal assistant: git-versioned markdown memory + planner, commands and free-form chat, daily briefing, check-ins, alerts, and the confirmation gate for outward actions. |
| 5b | The Mac mini's headed Chromium as a shared cluster resource: leases with owner preemption, a browser tool set for agents, frame-by-frame recording, and the Computer page (shared browser). |
| 6 | Owner login + daemon tokens, video generation on the Spark with the LLM/video exclusivity swap and `/video`, the four sanctioned external tools with an audit trail, the control-node switch and `/controlnode`, and the DigitalOcean proxy. |

Not built, deliberately: Kokoro voice notes (the `OutgoingMessage.voice` seam
exists), MLX serving on the MacBook, and video on the 7900XTX (blocked
upstream — ROCm has no working MiniMax-H3 path).
