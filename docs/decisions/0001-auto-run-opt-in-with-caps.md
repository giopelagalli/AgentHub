# 0001 — Auto-run turns are opt-in per project, with hub-wide caps
Date: 2026-09-19
Decided by: orchestrator
Status: accepted

## Context
The Phase 3 scheduler ran a full orchestrator turn on every active project every 15 minutes, unattended. Against mocks that was free; with a paid Fireworks key it ran ~250 turns in two days and hit the account's spending limit.

## Options
- A — keep the scheduler on by default with a lower interval: still unbounded spend while the owner sleeps; why not.
- B — remove scheduling entirely: loses unattended progress, which the product wants; why not.
- C (chosen) — off by default, opt-in per project with an interval and a daily cap, plus hub-wide caps.

## Decision
Per-project `autoRun {enabled, everyMinutes, maxTurnsPerDay}` off by default; hub-wide `MAX_TURNS_PER_DAY` (24) and `AUTO_TURNS=0`; scaffold-PRD projects are never auto-run; three consecutive same-class errors suspend auto-run with a Telegram alert.

## Consequences
Unattended progress is a deliberate choice per project. The cost of a runaway is bounded in turns; a bound in dollars comes with cost accounting (0019).
