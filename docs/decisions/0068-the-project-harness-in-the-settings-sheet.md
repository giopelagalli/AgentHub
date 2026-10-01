# 0068 — The project's harness: a route like `/model`, a row in the settings sheet
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
`select.ts` already falls back from the member's harness to `manifest.harness`, but nothing set
the project's value except hand-editing `manifest.yaml`. The owner needs it in the UI, owner-only,
with the same refusals the employee's choice has, and the drawer's "Built-in loop (project
default)" stops being true once a project can default to something else.

## Options
- A — a field on a general project PATCH. There is none: each project lever is its own route
  (`/priority`, `/model`, `/autorun`), so this would be the first.
- B — a `GET`+`PUT /api/projects/:slug/harness` pair. The value is already on the wire in the
  manifest (`GET /api/projects/:slug`, `HubState`); a second read path adds nothing.
- C (chosen) — `POST /api/projects/:slug/harness { harness }`, shaped like `/model`, returning the
  manifest; read from the manifest as everything else is.

## Decision
C. `builtin` clears `manifest.harness` (absent already means `builtin`). Refusals, in order: not a
`HarnessKind` → 400 `invalid harness`; unknown project → 404; `claude-code` on a project whose
`modelPolicy.prefer` is `local` → 400 with `CLAUDE_CODE_LOCAL_ONLY_REASON`, the text `select.ts`
logs (now one constant in `@agenthub/shared`, shared by the route, the fallback and the sheet);
a kind this host cannot run → 400 `<kind> is not installed on this hub`, exactly the member
route's rule. Not on the assistant allow-list, so cookie + `sameOriginWrite` only.

The sheet puts **Harness** in the Models group (what the project runs on; its footnote already says
an employee can be given their own), listing every kind with the unrunnable ones — and claude-code
on a Local-only project — disabled and their reasons as hints. Hidden by the drawer's rule (fewer
than two kinds runnable here). The drawer's first option now reads "Project default (<kind>)", and
the built-in loop is listed explicitly after it, since "project default" no longer implies it.

## Consequences
The drawer can now pin an employee to `builtin` under a pi or claude-code project. Switching a
project to Local-only does not clear a `claude-code` default already set — the run still falls back
with the reason, as for a hand-edited manifest. The member route still accepts `claude-code` on a
Local-only project (unchanged; the run falls back). The run-time check looks at the route a run actually uses, so on a
Local-only project an employee with their own cloud model override can still run claude-code from a
project default — their work already goes to the cloud. If the project default is a harness this
host later cannot run, the sheet's row may hide; each run falls back and says why. The drawer's old
"pi is not confined to the workspace" hint is gone: since 0055 pi only runs sandboxed.
