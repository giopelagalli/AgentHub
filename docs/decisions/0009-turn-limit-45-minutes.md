# 0009 — The turn time limit is 45 minutes and configurable
Date: 2026-09-22
Decided by: orchestrator
Status: accepted

## Context
A real turn on the Spark was cut at the 20-minute limit during verification, after the code was done and tests passed.

## Options
- A — keep 20 and shrink milestones: fights the local model's pace; why not.
- B — no limit: a stuck turn runs forever; why not.
- C (chosen) — default 45 minutes, `TURN_TIMEOUT_MINUTES` in `hub.env`.

## Decision
`DEFAULT_TURN_TIMEOUT_MS = 45 min`; a cut-short turn or employee says so instead of 'ended without a report from the model'.

## Consequences
Longer worst case per turn; the daily caps still bound total work.
