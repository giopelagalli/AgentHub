# AgentHub — roadmap

Updated at the end of every session. The *what* is `docs/prd-agenthub-v2.md`; the phases and
estimates are `docs/plan-agenthub-v2.md`; the *why* is `docs/decisions/`.

## Done

- v1: hub, nodes, queue, gateway with failover, projects as git bundles, PRD → roadmap → turns
  with a manager and employees, verification (tests + read-only reviewer), Telegram, shared
  browser, control-node switch, auth. Dogfooded on `cli-todo` and `pomodoro-cli`.
- Auto-run opt-in with hub caps (0001); curated Fireworks tiers (0002).
- Phase 0 on the Spark: attach mode (0005), priority scheduling (0006), the hub and daemon under
  systemd, JD verified responsive during turns (2026-09-23).
- Phase A: per-employee models (0007), live per-agent view, node drain/remove, the Help page and
  user guide, honest "cut short" labels, Order/auto-run wording.
- Turn quality on real hardware: thinking off for workers (0008), 45-minute limit (0009),
  verify-first manager (0010), paged reads (0011), briefing reserve, daemon startup retry.
  Result on 2026-09-23: m1 and m2 of `pomodoro-cli` verified end to end.
- Node network, first half: enrollment tokens, per-node bearers, owner on every node, the hub
  serving its installer and source, the installer itself — verified on the owner's MacBook
  (0016, 0017); the source tarball gated by an enrollment or node token; enrollment cannot
  seize an existing node (review 2026-09-23).
- Cost accounting and the daily dollar cap: priced usage per request, cost in the picker, header,
  per turn and per employee, `MAX_CLOUD_USD_PER_DAY` (0019, 0022–0024, 0026).
- The v2 PRD and plan with the owner's decisions (0012–0015, 0018, 0020, 0021).
- A **Chat** button in the project header, opening the Manager's drawer (`c`, pressed while it is
  up) — the org chart is no longer the only way to talk to a project.

- Import a repo as a third way to start a project: clone into `workspace/`, a PRD drafted from the
  code, a roadmap that leads with what already works, `agenthub/<slug>` pushed after each verified
  milestone and a pull request the owner opens (0028–0030).

- Workbench, first piece: **Preview** (FR-B1) — a project declares `preview { cmd, port, path? }`,
  the hub supervises it in the workspace and proxies it at `/preview/<slug>/` (HTTP + WebSocket)
  behind the session, with a sheet holding the iframe, start/stop/restart, settings and a log tail
  (0031–0033).

## In progress

- Dogfooding `pomodoro-cli` (m1–m3 done, m4 next); the PC joining via the installer when it is on.
- The public site on the droplet (`rosenroot.com`, 0025): the owner's droplet, DNS and Caddy steps.

## Next (in order)

1. Recipe catalog entries verified on real hardware (Spark attach, AMD llama.cpp HIP, Apple
   Silicon 48 GB); the hub's OpenAI-compatible door (FR-D6).
2. Workbench: terminal, Code screen with the Guide chat, Code map and Tour (FR-B2–B7); the
   preview proxy (FR-B1) is done.
3. Harnesses: the pi spike, then `pi` as the default employee harness and `claude-code` as an
   option (0013).
4. JD drives the hub; the web door (FR-C1–C5).
5. Media on the 7900 XTX (FR-E1–E4).
6. Browser pool (FR-D8).
7. Accounts, grants, per-member JD, the public site (FR-F1–F6).
