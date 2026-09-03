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
