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
- **Connect GitHub** for a non-technical member: a button, GitHub's own "choose repositories"
  screen, a repository picker in the import tab, and Manage/Disconnect on the Cluster page. The
  hub keeps no GitHub credential — only an installation id — and mints a short-lived token per
  repository; `GITHUB_TOKEN` stays as the fallback (0031–0034).

- The OpenAI-compatible door (FR-D6/FR-D7): user API tokens minted from the Cluster page,
  `/v1/chat/completions` and `/v1/models` streaming through the gateway with the token's priority
  tier, every request in the cost ledger (0034, 0035).

- Workbench, **Terminal** (FR-B2): a *Terminal* big button opens a real shell in the project's
  `workspace/` on the hub host — node-pty over the hub's own WebSocket into xterm.js, owner-only,
  four at a time, an hour's idle timeout (0041, 0042).

- Workbench, first piece: **Preview** (FR-B1) — a project declares `preview { cmd, port, path? }`,
  the hub supervises it in the workspace and serves it (HTTP + WebSocket) from a second listener on
  its own origin, behind a per-project capability, with a sheet holding the iframe,
  start/stop/restart, settings, reset-link and a log tail (0037–0040). Same-origin CSRF guard on the
  hub's own writes came with it.

- The **Code** screen (FR-B3–B5): the workspace as a tree, a CodeMirror viewer/editor whose saves
  commit as `Owner edit: <path>`, the read-only **Guide** docked beside it, and `docs/code-map.md`
  with `path:line` links that open a file at that line (0043–0046).

## In progress

- Dogfooding `pomodoro-cli` (m1–m3 done, m4 next); the PC joining via the installer when it is on.
- The public site on the droplet (`rosenroot.com`, 0025): the owner's droplet, DNS and Caddy steps.

## Next (in order)

1. Load xterm lazily: a dynamic `import()` in `mountTerminal` so the Terminal's 337 kB leaves the
   main bundle (123.50 → 460.53 kB today, 0041). Settle the lazy-mount shape once — Preview and
   Code want it too.
2. Recipe catalog entries verified on real hardware (Spark attach, AMD llama.cpp HIP, Apple
   Silicon 48 GB).
3. Workbench: the Tour over the Code map (FR-B6, FR-B7).
4. Harnesses: the pi spike, then `pi` as the default employee harness and `claude-code` as an
   option (0013).
5. JD drives the hub; the web door (FR-C1–C5).
6. Media on the 7900 XTX (FR-E1–E4).
7. Browser pool (FR-D8).
8. Accounts, grants, per-member JD, the public site (FR-F1–F6).
