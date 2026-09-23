# 0023 — A turn's cost is summed from its own usage events

Date: 2026-09-23
Decided by: senior-coder
Status: accepted

## Context

A turn's cost is the manager's spend plus every subagent it delegated to. Sessions do not record
which turn they belong to, so there is no key to group the ledger by, and the UI needs the figure
live — while the turn is still running — as well as after the fact.

## Options

- **A — sum ledger rows in a time window** between `turn-start` and `turn-end` for the project.
  Rejected: it silently absorbs anything else spent on that project during the window (a chat with
  the manager, a PRD redraft), and it cannot answer for a turn still in flight.
- **B — add a `turn_session_id` column** to the ledger and group by it. Correct, but it threads the
  orchestrator's session id down through `runSubagent` into every nested run, and still needs a
  second query per turn to draw the UI.
- **C (chosen) — emit a `usage` turn event per model call** and sum it. The orchestrator already
  receives every event of its turn, its subagents' forwarded ones included.

## Decision

`AgentLoop` emits `{ kind: 'usage', who, usd, tokens }` after each model turn. The orchestrator
accumulates them and puts the total on `turn-end`. **Cost is the sum of a turn's `usage` events** —
one rule, applied identically by the hub (`TurnRecord.cost`) and the UI (`turnCost`), so a turn
watched live and the same turn refetched never disagree.

## Consequences

The per-call event also gives the employee drawer a real per-member figure (`memberCostUsd`) rather
than a total split by guesswork, and the cost streams to the UI with the rest of the turn feed. The
events land in the transcript alongside the others, which lengthens the persisted event list and
shifts the positions any test asserting exact feed order expects. They carry no dollars of their
own for an unpriced model (`usd: null`), so a turn's tokens can be non-zero while its dollars are 0.
