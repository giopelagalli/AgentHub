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

## UI tower

The hub has a browser UI: a pixel-art top-down office tower with six floors
(B1 server room, 1F lobby, 2F general staff, 3F sample project, 4F vacant,
PH penthouse) joined by an elevator, showing live nodes, agents and the job
queue, with streaming chat when you walk up to an agent.

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
    TELEGRAM_OWNER_CHAT_ID  the only chat id the bot will act on; see deploy/telegram.md
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
    /video, /controlnode         coming in Phase 6

Anything else is sent to the assistant, which can read/search memory, edit
the planner, and manage projects. An outward-facing action (nothing built in
yet; Phase 6 adds X posting) never runs on its own — the assistant replies
with inline `[Confirm] [Cancel]` buttons and only Confirm from the owner's
own chat executes it.

Voice notes are not built: `TelegramPort`'s `OutgoingMessage.voice` field and
a future `VoiceAdapter` interface are where a Kokoro TTS hookup would plug in
(text in, spoken `Buffer` out, sent instead of/alongside the text reply) —
see `deploy/telegram.md`.

## Cluster (real nodes)

Beyond `npm run dev:node`'s mock daemon, real nodes each run the node
daemon against their own config over Tailscale (see deploy/tailscale.md):
deploy/spark/README.md, deploy/amd/README.md, deploy/macbook/README.md,
deploy/macmini/README.md (control node — runs the hub, no LLM serving).

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
