# 0008 — Per-endpoint request extras; thinking off for the Spark's worker tier
Date: 2026-09-22
Decided by: orchestrator
Status: accepted

## Context
Local tool calls took 30–90 s each while the cloud took ~9 s: the model was thinking on every call. vLLM's Qwen template switches thinking per request via `chat_template_kwargs`.

## Options
- A — hard-code `enable_thinking: false` in the gateway: wrong for other servers and for the manager; why not.
- B — a boolean `thinking` on the endpoint: only covers one knob; why not.
- C (chosen) — generic `requestExtras` merged into the request body per endpoint, reserved keys always winning; the Spark's worker entry sets `chat_template_kwargs: { enable_thinking: false }`.

## Decision
Employees and the reviewer answer without a thinking pass; the manager (orchestrator tier) keeps it.

## Consequences
Any server-specific field can be set per node without a hub change. Planning quality stays; worker latency drops.
