# 0057 — Tour explanations are cached as committed docs pages, keyed by the snippet
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
Each tour step is explained by the guide on first view (FR-B6), which is a model run of a few tool
calls. The PRD asks for the second reader (or JD) to get it instantly. Where the explanation is
kept decides whether it survives a restart, travels with the project, and notices that the code
under it changed.

## Options
- A — a table in `hub.db`. Fast, but invisible to every agent and to anyone reading the bundle, and
  it does not move with the project when the bundle is cloned elsewhere.
- B — in-memory. Lost on restart; the second reader after a deploy pays again.
- C (chosen) — a markdown page per step under `docs/tour/` in the bundle, committed.

## Decision
`docs/tour/NN-<title-slug>.md`, one per step position: `# Step N — <title>`, then a key line
`` `path:line` · lines A–B · snippet <sha256[0:12]> ``, then the explanation. The route reads the page
for the step's position and serves it (`cached: true`, no model call) only when that key line
matches what the step resolves to now — so a re-pointed map, a block that grew, or one edited
character in it regenerates the page rather than describing code that is no longer there. Writing a
step's page removes any other page holding the same position, and commits as
`owner: tour step N explained` (the owner's viewing drove it).

The explanation runs on the guide's own system prompt and read-only belt (0045), on the worker tier
with a 6-call budget (`TOUR_TOOL_CALLS`), under the `chat` session kind so its spend lands in the
ledger like the guide's. Generations are serialised per project — queued, not refused: Next twice
wants both answers, and the second often finds the first cached by the time its turn comes — and a
client that disconnects aborts its run.

## Consequences
The cache is ordinary project knowledge: `read_bundle("docs/tour/03-….md")` reads it, the next turn
can cite it, a clone carries it. The pages live in a sub-directory, so they are not listed in
`docs/index.md` or the Docs sheet — they are the tour's, not reading for their own sake. Pages are
addressed by position, so reordering the map regenerates even steps whose code did not change; a
page for a step that no longer exists is left behind until its position is reused.
