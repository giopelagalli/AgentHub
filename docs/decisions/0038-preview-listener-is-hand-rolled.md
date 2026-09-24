# 0038 — The preview listener is a plain `node:http` server; the upgrade is spliced
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
0040 puts previews on their own port. That listener has to proxy HTTP and WebSocket upgrades to a
per-project loopback port and serve nothing else. `@fastify/http-proxy` on a second Fastify
instance is the obvious candidate.

## Options
- A — `@fastify/http-proxy`: its WebSocket support keys on a *literal* prefix (`fastify.prefix` is
  pushed into a shared upgrade-listener prefix list), so a parametric `/p/:slug/:cap` prefix never
  matches; and it adds its own `server.on('upgrade')` listener, which on the hub's instance would
  sit beside `@fastify/websocket`'s and route the same request twice. On a second instance the
  clash goes away but the parametric prefix does not. Why not.
- B — a second Fastify instance with a hand-written handler: Fastify's own body parsing and routing
  are exactly what a proxy has to be talked out of, and every route added there is a route that
  could accidentally serve something. Why not.
- C (chosen) — `http.createServer` with one request handler and one `upgrade` handler.

## Decision
`PreviewServer` in `packages/hub/src/projects/preview.ts` is a plain `node:http` server. Requests
are piped with `stream.pipeline` (a dev server that dies mid-response must not take the hub with
it); upgrades are **spliced at the TCP level** — the browser's socket is paused, a `net` socket is
opened to the dev server, the raw request line and headers are replayed from `rawHeaders`, and the
two sockets are piped into each other. There is no framing layer, so subprotocols, extensions,
binary frames and close codes with their reasons cross untouched, and there is no user-space buffer
to bound. `ws` is a devDependency, for the tests only; no proxy dependency is added.

## Consequences
We own the proxy's edge cases (trailers, `Expect: 100-continue`) instead of a maintained package
owning them. In exchange the listener is small enough to read end to end, the capability check is
the first thing every request meets, and nothing but a preview can ever be served there.
