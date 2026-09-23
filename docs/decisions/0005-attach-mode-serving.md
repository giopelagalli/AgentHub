# 0005 — A serving entry without `cmd` attaches to a server the daemon did not start
Date: 2026-09-21
Decided by: orchestrator
Status: accepted

## Context
The Spark runs one vLLM (`sparkmodel.service`) shared with JD; there is no memory for a second. The daemon required a launch `cmd` per serving entry and would have tried to supervise a server it must not touch.

## Options
- A — a no-op `cmd` (`sleep infinity`): lies to the supervisor, kills nothing useful on stop; why not.
- B — a separate `attach:` list in the config: two shapes for one concept; why not.
- C (chosen) — `cmd` optional; absent means health-check the port, register, never start or stop.

## Decision
`ServingConfig.cmd?`; the supervisor tracks attached entries without a child; `configs/spark.yaml` attaches both tiers to `:8888` with `priority: 10` and small stream caps; no `advertiseHost` because the vLLM is bound to localhost and the hub is on the box.

## Consequences
No runtime watch of an attached server (the gateway marks it unhealthy if it dies). Two entries on one port are distinct by `tier:port`.
