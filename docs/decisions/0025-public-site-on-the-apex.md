# 0025 — The public site is rosenroot.com, with basic auth on the UI paths only
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The JD plan reserved the apex for the learning app and put the hub at `hub.rosenroot.com`. The
owner now runs the learning app at `rosenroot.ai` and wants `rosenroot.com` to be AgentHub. The
existing edge playbook put Caddy basic auth on every path, which would block the node installer,
remote nodes' daemons and JD's web door.

## Options
- A — `hub.rosenroot.com` as planned: a subdomain for the product the owner considers the main one; why not.
- B — basic auth on everything and hand machine clients the basic-auth credentials: secrets in install commands and daemon configs; why not.
- C (chosen) — the apex, `www` redirecting; basic auth only on the UI paths; `/api/*`, `/install*`, `/v1/*` pass through to the hub's own bearer/cookie auth; the source tarball gated by an enrollment token or a node token.

## Decision
`rosenroot.com` → the droplet → Caddy → `spark-f9a9.tail7ac2e2.ts.net:4000`; `TRUST_PROXY` set to the droplet's tailnet IP on the Spark; `rosenroot.ai` untouched.

## Consequences
Browsers face two logins; machines face bearer tokens and the hub's throttle. The login route is reachable without basic auth, so `TRUST_PROXY` is mandatory for per-client throttling. Owner decision on the domain; the edge shape follows from the installer and per-node tokens (0016).
