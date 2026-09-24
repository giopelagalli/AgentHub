# 0037 — The preview proxy forwards the path unchanged; the dev server owns the base
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
FR-B1 serves a project's dev server through the hub (0021, and 0040 for the origin it is served
from). Something has to reconcile the two path spaces: the browser asks for
`/p/<slug>/<cap>/src/main.ts`, and the dev server has its own idea of where its assets live. A
proxy can strip the prefix before forwarding, or pass it through and make the dev server answer on
it.

## Options
- A — strip the prefix and forward `/src/main.ts`: works for a server with no base path, but every
  absolute URL the app emits (`/@vite/client`, `/_next/...`) then escapes the prefix and misses the
  capability check. Rewriting HTML and JS to fix that is a content-rewriting proxy, which we are
  not building; why not.
- B — a subdomain per project: 0021 already rejected it (DNS and TLS per project); why not.
- C (chosen) — forward the path verbatim and require the dev server to be built with the hub's base
  path (Vite `base`, Next `basePath`).

## Decision
The proxy rewrites nothing: method, path, query, body and response are passed through, minus the
credentials in either direction. The base path is the dev server's job, and the hub gives it to the
child as `AGENTHUB_PREVIEW_BASE`. The planner's rules and the guide both say to *read that variable*
rather than hard-code a path, because the capability is part of the base and resetting the link
changes it.

## Consequences
A preview whose server cannot run under a base path does not work through the hub — the subdomain
option in 0021 is what that would need. A hard-coded base breaks on the next link reset, which the
prompt and the guide warn about. In exchange the proxy is a pipe with no knowledge of the content
it carries, and hot reload, source maps and asset URLs are correct by construction.
