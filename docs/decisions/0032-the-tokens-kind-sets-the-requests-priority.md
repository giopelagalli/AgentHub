# 0032 — A token's kind sets the request's priority, through a per-request override on the gateway
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
Decision 0020 gives a shared node one model and sorts callers by vLLM priority: the owner's
assistant 0, the owner's agents 10. Until now priority was a property of the *endpoint*
(`ServingEndpoint.priority`, set in `configs/spark.yaml`), which cannot express this: the same
Spark endpoint serves both, and only the caller knows which it is.

## Options
- A — two endpoints per node, one per priority: doubles every node's config and its capacity
  accounting for a field that costs nothing to vary per request; why not.
- B — put it on `Route`: `Route` is a project's *model* preference (prefer/provider/model) and is
  built by `routeFor` from a `ModelPolicy`; priority is about who is asking, not what they want;
  why not.
- C (chosen) — `priorityOverride?: number | null` on `ChatOptions`, the per-request options bag.
  Absent leaves the endpoint's own value alone; `null` sends no `priority` field at all.

## Decision
The door maps kind to 0020's tiers (`KIND_PRIORITY`: assistant 0, agent 10) and passes the result
as the override, so a door request never inherits `configs/spark.yaml`'s 10. 0 is vLLM's own
default, so it is sent as no field rather than `priority: 0` — that is also what the owner's
Telegram assistant has always done, and it keeps the request valid on a server started without
`--scheduling-policy priority`.

## Consequences
Three lines in `gateway.ts`, and every existing caller behaves exactly as before. The guest tiers
(15 / 20) are a lookup on the token's `user` once accounts land — no further gateway change. A
`null` override is meaningful, so callers must pass it deliberately; `?? endpoint.priority` would
have been wrong and the code checks `undefined` explicitly.
