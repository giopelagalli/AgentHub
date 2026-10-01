# 0054 — Pause models is its own node flag, not a mode of drain
Date: 2026-10-01
Decided by: orchestrator
Status: accepted

## Context
The owner wants to stop generating on the local model for now and use Fireworks, without taking the
machine offline. Today the only per-node lever is Drain, which stops *all* new work: model calls,
jobs, browser leases. The machine should keep claiming jobs and heartbeating.

## Options
- A — overload `draining` with a second state ("drain models only"): one column, but every drain
  check (claim, browser lease, gateway) would have to say which kind it means; why not.
- B — remove the node's endpoints while paused: loses the registration the daemon owns, and the
  next register would put them back; why not.
- Silent fallback for Local projects when every local model is paused: rejected — Local is a spending
  promise, and falling through would bill the owner for a project they pinned to their own hardware.
- C (chosen) — a separate `models_paused` flag, checked only in the gateway's `eligible()`.

## Decision
`nodes.models_paused` is set by `POST /api/nodes/:name/models { paused }` (owner-only, 409 for the
synthetic cloud nodes) and skipped in `ModelGateway.eligible()` next to the `draining` skip. Job
claiming ignores it. When every local endpoint of a tier is paused, a `local` route gets no
candidates (the error and the door's refusal say "local models paused"); `auto` falls through to cloud. Registration does not touch it, same as `draining`: the upsert's `SET` list
omits the column, so it survives a daemon restart; only `remove` clears it.

## Consequences
Two independent flags to reason about; a node can be both drained and paused. With every local
model paused, Auto routes fall through to cloud endpoints, bounded by `MAX_CLOUD_USD_PER_DAY`;
Local routes fail until the owner resumes. If no cloud endpoint is registered, nothing has capacity.
