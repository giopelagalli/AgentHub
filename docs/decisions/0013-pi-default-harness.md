# 0013 — pi is the default employee harness; Claude Code optional; the built-in loop stays for the manager
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The v2 plan recommended keeping the built-in tool loop as the default harness with Claude Code as the first external option. The owner wants an open-source default.

## Options
- A — built-in default, Claude Code first external (my recommendation): closed option first; why not.
- B — Claude Code default: subscription-bound, closed; why not.
- C (chosen) — pi (pi.dev) default for employees, Claude Code an option, built-in kept as fallback and as the manager's runtime (bundle tools, verification, briefings).

## Decision
PRD D6 / FR-G1–G5; a `Harness` interface; pi driven as a subprocess against the hub's OpenAI-compatible door; a spike verifies pi's programmatic mode first.

## Consequences
Owner override. The reviewer stays on the built-in loop until a harness can be restricted to read-only tools.
