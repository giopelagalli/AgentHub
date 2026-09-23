# 0010 — The manager verifies through `complete_milestone` first and documents after
Date: 2026-09-22
Decided by: orchestrator
Status: accepted

## Context
The manager spent nine minutes re-verifying an employee's work by hand (running tests, throwaway audit scripts, `npm pack`) and writing docs before calling `complete_milestone`, which then re-ran the tests and the reviewer and was cut by the time limit.

## Options
- A — remove the manager's shell tool: it needs it for orientation and fixes; why not.
- B — make verification implicit after every spawn: takes the decision away from the manager on multi-task milestones; why not.
- C (chosen) — prompt policy: call `complete_milestone` next after an employee reports; docs and decisions after it returns; no throwaway acceptance scripts.

## Decision
Planning rules in `prompts.ts`; also: the manager is nudged once when five tool calls remain so it publishes a briefing.

## Consequences
Verification cost is paid once per round. Documentation still happens, after the gate.
