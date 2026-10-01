# 0067 — Who asked: `requestedBy` on the turn, "(by <label>)" on the commit
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
FR-C3: JD reports a turn *it* triggered once, when it lands, so it has to tell its turns from the
owner's and the scheduler's; and every write an API token makes should say who made it.

## Options
- A — a new `GET /api/events?since=` feed. A second event surface to keep in step with the
  transcript, for one consumer.
- B — requester state in hub memory. Lost on restart, invisible in history.
- C (chosen) — the token's label rides the turn's own `turn-start` transcript event as
  `requestedBy`; the turn record surfaces it; `GET /api/projects/:slug/turns?since=<ms>` keeps the
  turns that ended at or after `since`.

## Decision
C. `ProjectService.runTurn(slug, instruction, { signal, requestedBy })` → the orchestrator emits
`{ kind: 'turn-start', who: 'manager', requestedBy }` → `TurnRecord.requestedBy`. Commits made on
a token's behalf append ` (by <label>)` (`byline()` in `bundle.ts`, whitespace collapsed so the
subject stays one line): scaffold, priority, pause/resume, PRD draft, roadmap, and both of a
turn's briefing commits — the synthesized one and `publish_briefing`'s, which learns the label
from the tool context (`ToolContext.requestedBy`). `since` filters on
`endedAt`, because JD polls for turns that *landed*; one still running is in `running`.

## Consequences
Persisted with the transcript, so it survives restarts and shows in history. Other commits a
token's turn makes along the way (task board, docs, code) are not signed — the turn's
`turn-start` is the record of who asked. `/turns` still returns at most the last 20 turns, so a client polling less
often than that could miss one.
