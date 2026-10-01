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
- The **simulation** (`npm run sim` / `sim:ui`, password `sim`): a local hub with scripted mock
  models, two nodes and three seeded projects, so the UI can be seen and driven with no Spark,
  login or keys (0051).

- The pi spike and the `Harness` interface: pi verified drivable headlessly against a custom
  OpenAI endpoint, `agents/harness/` with `builtin` (unchanged) and `pi`, a **Harness** select per
  employee offered only when the CLI is on the host, `GET /api/harnesses`; pi calls models through
  the hub's own door with a per-run token, so its spend is in the ledger (FR-G1, G2, G4; 0049,
  0050).

- The UI redesign (0048, 0053; brief in `docs/design/redesign-2026-10.md`): light and dark
  themes from one token set, a navigation-only sidebar, a toolbar per page with one primary,
  five project tabs (Overview · Plan · Docs · Code · Activity), a settings sheet for the project's
  levers, Machines (Nodes · Browser · Queue · Access) in place of Cluster/Computer/Allocation, a
  three-choice New project sheet, and the docs shell (0047, 0052) for the PRD, Docs and Help.
- The two API pieces the redesign wanted (0053): each project's `lastTurn` outcome in
  `/api/state` (so the sidebar dot is red after a failure without the browser holding the turns),
  and `POST /roadmap/move` accepting `{ id, to }` so a drag is one request.

- The Code Tour: steps from the Code map, explanations cached as docs pages (0056–0058).

## In progress

- Dogfooding `pomodoro-cli` (m1–m3 done, m4 next); the PC joining via the installer when it is on.
- The public site on the droplet (`rosenroot.com`, 0025): the owner's droplet, DNS and Caddy steps.

## Next (in order)

1. Recipe catalog entries verified on real hardware (Spark attach, AMD llama.cpp HIP, Apple
   Silicon 48 GB).
2. Workbench: a per-project live browser view on the Code tab (FR-B7).
3. Harnesses, the rest: workspace containment so pi can become the default and the reviewer can
   leave `builtin` (0049), a project-level Harness select in the header, `claude-code` (FR-G3),
   and the installer putting pi on a node.
4. JD drives the hub; the web door (FR-C1–C5).
5. Media on the 7900 XTX (FR-E1–E4).
6. Browser pool (FR-D8).
7. Accounts, grants, per-member JD, the public site (FR-F1–F6).
