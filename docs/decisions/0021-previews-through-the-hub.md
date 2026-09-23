# 0021 — Previews and terminals are proxied through the hub, never raw ports
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
A live preview of the app under construction needs a dev server reachable from the browser. Raw ports on the tailnet would bypass the hub's login and break on the public site.

## Options
- A — raw ports per project: no auth, no public site; why not.
- B — a wildcard subdomain per project: DNS and TLS per project; heavier than needed now; why not.
- C (chosen) — `/preview/<slug>/` and `/term/<slug>` proxied (HTTP + WebSocket) under the hub's session; the manager configures the dev server's base path; a project may also hold a live browser session from the pool.

## Decision
PRD D7 / FR-B1–B2, FR-B7.

## Consequences
Dev servers that cannot run under a base path need the subdomain option later.
