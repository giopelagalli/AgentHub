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
