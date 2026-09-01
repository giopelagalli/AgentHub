# AgentHub UI — Corporate Tower Design (Phase 5, pulled forward)

**Date:** 2026-09-01
**Status:** Approved (design review with owner, 2026-09-01)
**Parent spec:** 2026-09-01-agenthub-prd-design.md §9 (this document supersedes §9's
"pixel town" concept with the approved corporate-tower concept)

## 1. Concept

The hub is visualized as a **corporate tower**, rendered as top-down pixel-art
floors in the style of Gen-1 Pokemon's Silph Co. building. One floor is on
screen at a time; an elevator (Pokemon-style floor menu + door transition)
moves between floors. Floors map to the system: basement = compute, lobby =
reception/queue, staff floors = agents, project floors = future project
orchestrators, penthouse = master orchestrator. The tower is **always
working**: ambient animations run constantly, and agent busy-states are driven
by real hub activity over a WebSocket.

Navigation is point-and-click (no walkable player character). Interactions
open Pokemon-style dialog boxes and DOM side panels.

## 2. Scope

In scope (this phase): the four spec views recast as tower floors, real data
where the Phase-1 API provides it, stubs clearly labeled where it does not;
hub additions limited to WebSocket state broadcast, per-tier activeStreams in
state, per-agent busy events, and static serving of the built UI.

Out of scope: walkable character, real project floors (Phase 3), assistant NPC
behavior (Phase 4), browser-room live screen (Phase 5 proper), auth (Phase 6),
sound.

## 3. Floors (v1)

| Floor | Name | Contents | Data |
|---|---|---|---|
| B1 | Server Room | Node racks (one per registered node) with health LEDs (online = blinking green, offline = solid red), endpoint labels, per-tier stream gauges | Real: `/api/state` nodes + `activeStreams` |
| 1F | Lobby | Reception desk with "Assistant — arriving Phase 4" placard, job board kiosk (click → queue panel), floor directory board (click → jump to floor) | Real: jobs from state |
| 2F | General Staff | One desk per API agent, robot sprite per agent (palette hashed from name), click → dialog box + chat panel (SSE streaming). Busy agents type; idle agents lean back | Real: agents, chat, busy events |
| 3F | Sample Project | Furnished project floor: orchestrator office, 4 subagent cubicles, wall task board. Signboard: "SAMPLE — project floors arrive in Phase 3". Hardcoded demo data, ambient animations only | Stub |
| 4F | Vacant | Bare floor, "FOR LEASE" sign, a single blinking ceiling light | Stub |
| PH | Penthouse | Master orchestrator office: big desk, window skyline, briefing board "first briefing: Phase 3" | Stub |

Floor list is data-driven (an ordered array), so Phase 3 can insert real
project floors without touching scenes.

## 4. Architecture

New package `packages/ui` — Vite + TypeScript SPA, no runtime framework, no
game engine.

- **Canvas layer**: one `<canvas>`, fixed internal resolution 320×288 (Game
  Boy proportions, 2× GB) scaled up integer-multiple to fit the window
  (nearest-neighbor). Renders tiles, sprites, animations at 60fps rAF with a
  logical 8fps animation tick for authentic choppiness.
- **DOM layer**: overlays for text-heavy UI — chat panel, queue panel,
  elevator menu, dialog boxes (dialog boxes styled as GB text boxes but DOM
  for accessibility/copyability).
- **Art**: procedural pixel art only — sprites and tiles defined as string
  matrices with palette lookup in `src/art/` modules; no image assets. Base
  palette: Game Boy Color-inspired soft greens/creams, 4-shade ramps per
  material, defined once in `src/art/palette.ts`.
- **State**: a single UI store (plain TS, pub/sub) fed by (a) initial
  `GET /api/state`, (b) `/ws` WebSocket messages, (c) poll fallback every 5s
  when the socket is down. Scene stack: `tower` scenes keyed by floor id,
  panel overlays pushed/popped on top.

### Hub additions (packages/hub)

1. `GET /api/state` gains `streams: Record<Tier, number>` from
   `gateway.activeStreams(tier)`.
2. `/ws` WebSocket (`@fastify/websocket`): on connect sends
   `{type:'state', state}`; re-broadcasts the same on every mutating route
   (register, heartbeat status change, agent create), every sweep tick, and
   on agent busy transitions: `{type:'agent-busy', agentId, busy}` emitted
   when `runtime.send` starts/finishes.
3. Static serving: hub serves `packages/ui/dist` at `/` via `@fastify/static`
   when the directory exists (dev uses Vite's proxy instead).

## 5. Interaction model

- Click hotspots (elevator, agents, job board, directory, racks) — cursor
  changes and hotspot highlights on hover.
- Elevator: click → GB-style floor menu → doors-close animation → floor swap
  → doors-open.
- Agent click: dialog box ("SCOUT is hard at work!" flavored by busy state) →
  "Talk" opens the chat panel (DOM, right side), streaming tokens via the
  existing SSE endpoint; Esc closes.
- Job board / racks: informational panels (queue table, node detail).
- Keyboard: Esc = close panel / back; number keys = floor shortcuts.

## 6. Always-working ambience

Ambient animation is a first-class requirement, not polish:

- Agents: 2-frame typing loop when busy (real busy state), lean-back idle
  sway when not; occasional 8-tile coffee walk on a timer for idle agents.
- Monitors flicker; rack LEDs blink per online node; elevator indicator
  cycles; vacant-floor light flickers; penthouse window skyline twinkles.
- All ambience runs on the 8fps animation tick and must not require data.

## 7. Testing

- vitest (same repo conventions): UI store reducer (state/ws messages/busy
  transitions), scene registry/floor data, elevator state machine, palette/
  sprite matrix validation (every sprite row same width, colors in palette),
  hub WS broadcast + streams field (integration tests in packages/hub).
- Rendering verified by driving the real app (hub + UI) in a browser at the
  end of each layer; final acceptance is a scripted browser walkthrough of
  all six floors with real agents chatting.

## 8. Build layers

1. Hub: WS broadcast + streams in state + busy events + static serving (tests).
2. UI skeleton: Vite package, canvas engine (loop, scaler, input, scene
   stack), palette + tile renderer; lobby floor rendered statically.
3. Elevator + all six floors' layouts render with ambient animations.
4. Live data: store + WS client; server room, staff floor, job board driven
   by real state; busy animations wired.
5. Chat: dialog boxes + chat panel streaming SSE; agent hotspots.
6. Polish + acceptance walkthrough; hub serves built UI.
