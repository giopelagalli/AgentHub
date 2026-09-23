# 0004 — Claude on the Spark is deferred, and would be the Code subscription, never the API
Date: 2026-09-21
Decided by: owner
Status: accepted

## Context
The JD plan proposed Claude via the Anthropic SDK as the orchestrator brain. The owner does not want per-token API spend and has a Claude Code subscription.

## Options
- A — `CLOUD_ANTHROPIC=1` with an API key (my recommendation at the time): pay per token; the key had no credit; why not.
- B — Claude Code CLI signed in on the Spark, driven as a harness: no API key, subscription terms apply; chosen for later.
- C (chosen now) — both tiers on the local Qwen, Fireworks flash as the only cloud fallback; Claude joins later as a harness (0013).

## Decision
No Anthropic provider in use on the Spark. The hub's SDK provider stays in the code, unused.

## Consequences
Owner override of the plan's recommendation. Harness work (0013) is where Claude re-enters.
