# 0027 — The droplet answers when the hub is down
Date: 2026-09-24
Decided by: orchestrator
Status: accepted

## Context
`rosenroot.com` is Caddy on the droplet, reverse-proxying over Tailscale to the hub on the Spark
(0025). When the Spark is off, Caddy answers a bare 502 and nobody is told. The owner wants a
clear offline page for visitors and a Telegram alert on down/up transitions.

## Options
- A — JD alerting: JD runs on the Spark, so it is off exactly when the outage it would report is
  happening; why not.
- B — an external uptime service (Pingdom, UptimeRobot, …): another account and credential to
  manage, and it has no tailnet reach to distinguish "hub down" from "Spark down" — why not, and
  unnecessary when the droplet is already sitting in the request path.
- C (chosen) — the droplet, being the only always-public machine, serves the offline page itself
  (Caddy `handle_errors`) and runs its own down/up watchdog (a systemd timer polling
  `/api/health`, alerting over the same Telegram bot pattern as the hub's own assistant).

## Decision
`deploy/do/Caddyfile` serves `/etc/caddy/site/offline.html` with status 503 on 502/503/504 from
the upstream. `hub-watch.timer` (every minute) plus `hub-watch.sh` track up/down in
`/var/lib/agenthub-watch/state` and message Telegram only on a transition, using
`/etc/agenthub-watch.env` for `HUB_UPSTREAM`, `HUB_DOMAIN`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID` — missing Telegram credentials degrade to check-and-log, not a hard failure.

## Consequences
The droplet remains stateless in the sense that matters (no project data, no API keys) but now
holds one small piece of state (`agenthub-watch/state`) and one more secret (a Telegram bot
token) — acceptable, since both are cheap to lose or rotate and neither has tailnet reach beyond
the one health-check GET the ACL (0025) already allows. The alert and the hub's own Telegram
assistant use two different bots/tokens by design: the droplet's watchdog must keep working when
the Spark, and everything on it, is unreachable.
