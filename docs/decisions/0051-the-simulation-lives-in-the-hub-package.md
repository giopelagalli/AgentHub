# 0051 — The simulation lives in the hub package and scripts agents from their own prompts
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

(Numbered as the next free one on main at the time; may be renumbered at merge.)

## Context
Verifying the UI needed the owner's hub on the Spark (password, live models) or a hand-assembled
hub. Work should continue without the owner: one command that starts a complete, realistic
AgentHub locally — seeded projects, nodes, mock models — from any checkout or worktree. Two
choices shape it: where the code lives, and how a mock that has no model in it produces turns
that look like work.

## Options
Where:
- A — `scripts/sim.ts` at the root. Outside every package's tsconfig, so `npm run typecheck`
  would never see it, and it would reach into `packages/hub/src` by relative path anyway.
- B — `packages/mocks/src/sim.ts`. The sim needs `createHub`; mocks depending on the hub would
  close a cycle (the hub already dev-depends on mocks).
- C (chosen) — `packages/hub/sim/`, beside `src/` and `test/`, in the hub's tsconfig.

How the mock plays agents:
- A — the mock's existing sequential `script`. One global step counter: a turn, its subagents and
  a chat running together would consume each other's steps.
- B — a stateful sim-side planner tracking each conversation. Needs conversation identity the wire
  format does not carry.
- C (chosen) — a stateless `respond(body)` hook on the mock: the sim's responder reads which agent
  is asking from the system prompt's opening line, and how far in it is from the count of
  assistant messages. Concurrent conversations cannot interfere because none share state.

## Decision
`packages/hub/sim/` holds `sim.ts` (`startSim`), `agent-script.ts` (the responder), `seed.ts` and
`content.ts`; `main.ts` is the CLI behind `npm run sim` / `sim:ui`. The mock gained only a generic
`respond` hook and `setTokenDelay` (seeding runs at 0 ms, live turns at 30 ms).

Seeding goes through the hub's own HTTP routes, logged in like the UI; only what no route writes —
docs pages and m1's recorded verification — goes through `ProjectBundle`. Two of pomodoro-cli's
past turns are real turns against the scripted mock, so their events, briefings and usage rows are
the hub's own output, not fixtures.

The mock node's endpoints declare `provider: 'fireworks'` with GLM 5.3 model ids, so the gateway
prices its requests and every cost surface shows dollars. It is still the local mock and needs no
key; the hub's cloud tier stays off.

## Consequences
The responder is keyed on the opening lines of the hub's prompts; rewording one makes that agent
fall back to a plain reply (visible, not a crash) until `agent-script.ts` is updated. Turns in the
sim are plausible, not meaningful: the coder writes a small module and a passing test per
milestone. Pricing the mock as Fireworks makes the sim's cloud-spend figures non-zero, which is the
point; a reader of the Cluster page sees Fireworks model names on `sim-spark`.
