# 0075 — rosenroot.com reaches the hub through a droplet, not a Cloudflare Tunnel
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The hub lives on the Spark at home; rosenroot.com has to reach it without exposing the house.
After asking "why do we need a droplet here?", the owner was offered three shapes and chose the
recommended one. 0025 and 0027 record how the site works; this records the choice of edge.

## Options
- A — Cloudflare Tunnel: free, no droplet, Cloudflare Access login; but the nameservers move to
  Cloudflare and Cloudflare decrypts all traffic in the middle.
- B — no public site, Tailscale on every device: no edge at all, but a friend without Tailscale
  can't use it.
- C (chosen, recommended) — a $6/month DigitalOcean droplet (the old JD droplet) running Caddy,
  joined to the tailnet and proxying to the Spark.

## Decision
The droplet: TLS ends on a machine the owner controls, the Spark and the home network stay
unreachable from the internet, and DNS stays at Porkbun.

## Consequences
- One more machine to keep alive (Caddy, Tailscale, the offline page and watchdog).
- The droplet is stateless and rebuildable from `deploy/do/README.md`; projects live on the Spark.
