# AgentHub — changelog

One line per merge, newest first, added by the main session at merge. The *why* behind an entry is
in `docs/decisions/` (the numbers in parentheses).

- 2026-10-30: `ARCHITECTURE.md` is a 939-word map with one diagram; the user guide is one page per
  topic in `docs/guide/`, and the Help page reads them all.
- 2026-10-30: one-command deploy on the Spark (`deploy/spark/deploy.sh`); JD's main now carries the
  AgentHub tools and the web door (off until their tokens are set).
- 2026-10-30: docs are plain markdown — this changelog replaces the roadmap's Done list, and the
  HTML docs site is gone.

## Before 2026-10-30 (moved from the roadmap's Done list, newest first)

- A simpler Code tab (0072, the owner's "too complicated"): one control (Files · Terminal ·
  Preview · Browser); the Map and the Tour moved to **Docs → How the code works**; the toolbar's
  chat is the Guide on Code (no *Ask the guide*, no auto-opened pane); the editor shows no header
  until a file is open and Save only while there are unsaved changes.
- Media as a per-employee ability (0073): `abilities: ['image' | 'video']` on a team member gives
  `generate_image` / `generate_video` to any role (a designer with none set keeps both), set from
  a **Can make** row of switches in the employee drawer via the member PATCH; the roster carries
  `renderers` so the drawer says when nothing can render yet.
- The web door, the hub's side (FR-C4; 0069–0071): `/api/jd/*` proxies JD's web API behind the
  owner's login (named routes, raw bytes, 502/504, audio ranges, the stream bridged), a **JD** page
  at the top of the sidebar (chat, JD's buttons and quick keys, voice notes both ways, typing), and
  a mock JD in the simulation.
- The project's default harness (0068): `POST /api/projects/:slug/harness` (owner-only, the
  member route's refusals plus claude-code on Local-only), a Harness row in the settings sheet,
  and the drawer's "Project default (<kind>)".
- The assistant scope (FR-C1–C3 hub side, 0065–0067): an `assistant` token opens an allow-list
  of project routes (create, draft, roadmap, turn, pause/resume, priority, state, briefings,
  turns); non-streaming `?wait=1` draft/roadmap; turns carry `requestedBy`, `/turns?since=`, and
  token writes are signed `(by <label>)` in commits.
- Media against the ComfyUI mock (FR-E1–E3, 0060–0062): `image-gen` beside `video-gen`, Qwen-Image
  and Wan 2.2 templates (placeholders), renders landing in the bundle's `media/` with a sidecar and
  a commit, the media routes, `generate_image` / `generate_video` for designers, Docs → Media, and
  a sim media node (pomodoro-cli has an app icon).
- Each project's live browser (FR-B7, 0063): Code → Browser shows the project's slot of the pool
  with Take control / Release, its place in the queue when every slot is busy, and a live dot on
  the switch while it holds one.
- `claude-code` harness (FR-G3, 0064): the `claude` CLI on the hub host's signed-in subscription,
  stream-json mapped onto the turn feed, in the same sandbox with outbound HTTPS (verified end to
  end on macOS), usage as `anthropic-subscription` rows with no dollars, offered only when
  `claude auth status` shows a subscription login. macOS only; never for Local-only projects.
- pi in an OS sandbox (0055): Seatbelt on macOS (verified with the real pi), bubblewrap on Linux
  with a unix-socket bridge to the door; writes to the workspace only, network to the door only;
  pi not offered where the sandbox cannot start. The reviewer on pi behind `HARNESS_REVIEWER_PI=1`.
- The Code Tour: steps from the Code map, explanations cached as docs pages (0056–0058).
- Browser pool (FR-D8, 0059): `browser.slots` contexts in one browser per node, leases for
  `(node, slot)` with one slot per project, Take control per slot, and Machines → Browser as a
  tile per slot.
- The two API pieces the redesign wanted (0053): each project's `lastTurn` outcome in
  `/api/state` (so the sidebar dot is red after a failure without the browser holding the turns),
  and `POST /roadmap/move` accepting `{ id, to }` so a drag is one request.
- The UI redesign (0048, 0053; brief in `docs/design/redesign-2026-10.md`): light and dark
  themes from one token set, a navigation-only sidebar, a toolbar per page with one primary,
  five project tabs (Overview · Plan · Docs · Code · Activity), a settings sheet for the project's
  levers, Machines (Nodes · Browser · Queue · Access) in place of Cluster/Computer/Allocation, a
  three-choice New project sheet, and the docs shell (0047, 0052) for the PRD, Docs and Help.
- The pi spike and the `Harness` interface: pi verified drivable headlessly against a custom
  OpenAI endpoint, `agents/harness/` with `builtin` (unchanged) and `pi`, a **Harness** select per
  employee offered only when the CLI is on the host, `GET /api/harnesses`; pi calls models through
  the hub's own door with a per-run token, so its spend is in the ledger (FR-G1, G2, G4; 0049,
  0050).
- The **simulation** (`npm run sim` / `sim:ui`, password `sim`): a local hub with scripted mock
  models, two nodes and three seeded projects, so the UI can be seen and driven with no Spark,
  login or keys (0051).
- The **Code** screen (FR-B3–B5): the workspace as a tree, a CodeMirror viewer/editor whose saves
  commit as `Owner edit: <path>`, the read-only **Guide** docked beside it, and `docs/code-map.md`
  with `path:line` links that open a file at that line (0043–0046).
- Workbench, first piece: **Preview** (FR-B1) — a project declares `preview { cmd, port, path? }`,
  the hub supervises it in the workspace and serves it (HTTP + WebSocket) from a second listener on
  its own origin, behind a per-project capability, with a sheet holding the iframe,
  start/stop/restart, settings, reset-link and a log tail (0037–0040). Same-origin CSRF guard on the
  hub's own writes came with it.
- Workbench, **Terminal** (FR-B2): a *Terminal* big button opens a real shell in the project's
  `workspace/` on the hub host — node-pty over the hub's own WebSocket into xterm.js, owner-only,
  four at a time, an hour's idle timeout (0041, 0042).
- The OpenAI-compatible door (FR-D6/FR-D7): user API tokens minted from the Cluster page,
  `/v1/chat/completions` and `/v1/models` streaming through the gateway with the token's priority
  tier, every request in the cost ledger (0034, 0035).
- **Connect GitHub** for a non-technical member: a button, GitHub's own "choose repositories"
  screen, a repository picker in the import tab, and Manage/Disconnect on the Cluster page. The
  hub keeps no GitHub credential — only an installation id — and mints a short-lived token per
  repository; `GITHUB_TOKEN` stays as the fallback (0031–0034).
- Import a repo as a third way to start a project: clone into `workspace/`, a PRD drafted from the
  code, a roadmap that leads with what already works, `agenthub/<slug>` pushed after each verified
  milestone and a pull request the owner opens (0028–0030).
- A **Chat** button in the project header, opening the Manager's drawer (`c`, pressed while it is
  up) — the org chart is no longer the only way to talk to a project.
- The v2 PRD and plan with the owner's decisions (0012–0015, 0018, 0020, 0021).
- Cost accounting and the daily dollar cap: priced usage per request, cost in the picker, header,
  per turn and per employee, `MAX_CLOUD_USD_PER_DAY` (0019, 0022–0024, 0026).
- Node network, first half: enrollment tokens, per-node bearers, owner on every node, the hub
  serving its installer and source, the installer itself — verified on the owner's MacBook
  (0016, 0017); the source tarball gated by an enrollment or node token; enrollment cannot
  seize an existing node (review 2026-09-23).
- Turn quality on real hardware: thinking off for workers (0008), 45-minute limit (0009),
  verify-first manager (0010), paged reads (0011), briefing reserve, daemon startup retry.
  Result on 2026-09-23: m1 and m2 of `pomodoro-cli` verified end to end.
- Phase A: per-employee models (0007), live per-agent view, node drain/remove, the Help page and
  user guide, honest "cut short" labels, Order/auto-run wording.
- Phase 0 on the Spark: attach mode (0005), priority scheduling (0006), the hub and daemon under
  systemd, JD verified responsive during turns (2026-09-23).
- Auto-run opt-in with hub caps (0001); curated Fireworks tiers (0002).
- v1: hub, nodes, queue, gateway with failover, projects as git bundles, PRD → roadmap → turns
  with a manager and employees, verification (tests + read-only reviewer), Telegram, shared
  browser, control-node switch, auth. Dogfooded on `cli-todo` and `pomodoro-cli`.
