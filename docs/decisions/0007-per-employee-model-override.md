# 0007 — An employee may run on a model that differs from the project's policy
Date: 2026-09-22
Decided by: orchestrator
Status: accepted

## Context
On the Spark the local model planned well but coded badly; a cloud flash model coded in two minutes. The model policy was per project, so the manager and the coder had to share a choice.

## Options
- A — a per-tier preference on the project policy (`workerPrefer`): coarse, all employees alike; why not.
- B — per-role defaults in prompts: hidden from the owner; why not.
- C (chosen) — `TeamMember.model?: ModelPolicy` overriding the project's for that employee's tasks, set from the employee's drawer.

## Decision
`PATCH /api/projects/:slug/team/:id { model | null }` validated by the same helper as the project route; `runSubagent` resolves `routeFor(member.model ?? policy, 'worker')`.

## Consequences
The manager keeps the project's orchestrator model. The roster is now where per-agent behaviour lives (harness follows, 0011).
