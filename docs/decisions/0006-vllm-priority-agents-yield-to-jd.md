# 0006 — Agents send vLLM request priority 10; JD sends none
Date: 2026-09-22
Decided by: orchestrator
Status: accepted

## Context
JD and AgentHub share one vLLM. The owner's assistant must stay responsive while agents run. vLLM's `--scheduling-policy priority` orders by a per-request number.

## Options
- A — separate model servers: no memory; why not.
- B — rate-limit agents in the hub: crude, still lets a long agent prefill delay JD; why not.
- C (chosen) — per-endpoint `priority` sent with every request; JD sends none (0); the gateway drops the field and retries once if the server refuses it.

## Decision
`ServingEndpoint.priority`, `configs/spark.yaml` sets 10; the gateway remembers an endpoint that answered 'Priority scheduling is not enabled' and stops sending the field to it. Verified 2026-09-23: JD answered in ~5 s during a turn.

## Consequences
Requires the flag on the server; without it agents run at equal footing but turns still work. llama.cpp ignores the field.
