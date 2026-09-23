# 0002 — Fireworks offers a curated two-tier model list, hard models behind a switch
Date: 2026-09-19
Decided by: owner
Status: accepted

## Context
The hub fetched Fireworks' live catalog (100+ ids) and offered all of them. The owner wants only cheap flash models usable now, with expensive ones available later without a code change.

## Options
- A — keep the live catalog and warn on price: every expensive model is one click away; why not.
- B — allow-list via env only: invisible in the UI, easy to misconfigure; why not.
- C (chosen) — a checked-in curated list with a `hard` flag; hard models refused (400, greyed out, gateway fallback) unless `FIREWORKS_HARD_MODELS=1`.

## Decision
Cheap: `glm-5p3-flash` (default for both tiers), `deepseek-v4p1-flash`. Hard: `glm-5p3`, `kimi-k3`. Three enforcement points: the policy route, the picker, the gateway's `modelAllowed`.

## Consequences
Adding a model is a code change (by design). A policy saved with a hard model falls back to the endpoint default while the switch is off. Recommendation and decision matched; the owner set the default to cheap-only.
