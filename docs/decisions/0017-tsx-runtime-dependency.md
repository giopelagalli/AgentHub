# 0017 — `tsx` is a runtime dependency so nodes install with `--omit=dev`
Date: 2026-09-23
Decided by: orchestrator
Status: accepted

## Context
The daemon (and the hub's own service units) run TypeScript source through `tsx`, which was declared as a root devDependency, so `npm ci --omit=dev` produced a node that could not start; the installer had to pull the whole dev tree.

## Options
- A — full `npm ci` on every node: ~60 extra packages (vitest, vite, typescript) per node; why not.
- B — ship compiled JavaScript: a build step and artifacts we don't have yet; a later option.
- C (chosen) — move `tsx` to `dependencies`; the installer uses `--omit=dev`.

## Decision
Root `package.json` and lockfile updated; the installer fails loudly if `tsx` is missing after install.

## Consequences
Nodes install 118 packages instead of ~180. Shipping compiled output remains open.
