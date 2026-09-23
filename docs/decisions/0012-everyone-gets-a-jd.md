# 0012 — Every member gets their own JD instance on a node they own
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The v2 plan proposed the hub's built-in assistant for other members and kept JD personal. The owner wants JD to be the product's assistant for everyone.

## Options
- A — hub-hosted assistant per member (my recommendation): all memories on the owner's Spark, JD's features to port; why not.
- B — one JD instance for all users: shared memory, no privacy; why not.
- C (chosen) — a JD instance per member on a node they own (installer sets it up, model fitted to the hardware) or on shared nodes at guest priority; memory stays on their machine; renameable; Telegram optional.

## Decision
PRD D4 / FR-F5; a node may host an `assistant` capability; the installer offers it; JD's repo gets an installable release.

## Consequences
Owner override of the recommendation. Adds the recipe catalog and the hub's OpenAI-compatible door as prerequisites (PRD FR-D3, FR-D6).
