# 0032 — The preview proxy is hand-rolled; `ws` is the only new dependency
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
The preview needs an HTTP proxy with WebSocket upgrade support under `/preview/:slug/*`, where the
upstream port is per project and changes at runtime. `@fastify/http-proxy` is the obvious
candidate.

## Options
- A — `@fastify/http-proxy` with `websocket: true`: its WebSocket support keys on a *literal*
  prefix (`fastify.prefix` is pushed into the shared upgrade listener's prefix list), so a
  parametric `/preview/:slug` prefix never matches and the upgrade falls through. Worse, it adds a
  second `server.on('upgrade')` listener beside `@fastify/websocket`'s, which dispatches *every*
  upgrade through the router unconditionally — the same request would be routed twice. Why not.
- B — raw TCP splicing of the upgrade: the most transparent, but `@fastify/websocket` has already
  taken the socket behind a private symbol by the time a route handler runs; reaching it means
  reading another package's internals. Why not.
- C (chosen) — one route with a `wsHandler`, bridged frame by frame to a `ws` client, and
  `node:http` piping for ordinary requests.

## Decision
`packages/hub/src/projects/preview.ts` owns the proxy: `reply.hijack()` plus `http.request` for
HTTP (status, headers and body written to the socket verbatim), and `@fastify/websocket`'s own
`wsHandler` bridged to a `ws` client upstream. `ws` is added to the hub's dependencies — it was
already in the tree under `@fastify/websocket`, and `@types/ws` was already a devDependency.
`@fastify/http-proxy` is not added.

One wrinkle is recorded in the code: the subprotocol is forwarded as a raw header rather than as a
requested subprotocol, because Vite routes its HMR upgrade on `sec-websocket-protocol: vite-hmr`
but never echoes it back, and a `ws` client that *asked* for a subprotocol treats an answer without
one as a failed handshake.

## Consequences
We own the proxy's edge cases (trailers, `Expect: 100-continue`, and anything else a dev server
might use) instead of a maintained package owning them. In exchange the upstream is resolved per
request from the supervisor's live map, the hub's cookie is stripped in one obvious place, and
there is exactly one `upgrade` listener on the server.
