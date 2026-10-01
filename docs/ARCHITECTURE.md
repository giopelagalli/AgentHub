# AgentHub — architecture map

One paragraph per module: what it is for, its interface, and why it has this shape. A map, not a
manual; the code's own comments carry the detail. Decisions that shaped a module are cited by
number (`docs/decisions/`).

## Packages

**`packages/shared`** — the types every package agrees on (`ServingEndpoint`, `NodeInfo`,
`ProjectManifest`, `TeamMember`, `Milestone`, `TurnEvent`, `WsMessage`, `PRD_SECTIONS`) and the
one runtime helper that both the hub and the daemon need, `shell-task` (`runShellTask` with
workspace containment). Types live here so the wire format is checked at compile time on both
ends; nothing here does I/O except the shell helper.

**`packages/mocks`** — a strict OpenAI-compatible mock server (validates tool and `tool_calls`
wire shapes, scripts replies — a fixed `script`, or a per-request `respond` hook — records
requests), a ComfyUI mock, and a daemon-config writer for
tests. Strictness is the point: a lenient mock once hid a broken wire format behind 650 green
tests.

**`packages/hub`** — the one long-running process. Fastify + SQLite. Owns the API, the UI
bundle, the WebSocket, the queue, the gateway, the projects, the assistant, Telegram, and now
enrollment and usage. Everything else talks to it; it talks to nodes only through what they
register (0003).

**`packages/hub/sim`** — the simulation behind `npm run sim` / `sim:ui` (0051): `startSim()` runs
the hub in-process with auth on, the strict OpenAI mock answering through `agent-script.ts` (a
stateless responder that reads each request's system prompt and history to play the manager,
coder, reviewer, PRD and roadmap leads and the chats), a mock node plus one left to go stale, and
seeds three projects through the hub's own routes (`seed.ts`, data in `content.ts`). Dev tooling,
not product: nothing in `src/` imports it. It lives in the hub package because it needs `createHub`
and the mocks, and the hub already depends on both.

**`packages/node-daemon`** — one process per machine. Registers what the machine can do
(serving entries spawned or attached, 0005; shell jobs; a browser; a profile set; the hub itself
on a control node), heartbeats, claims jobs, runs them. Retries registration at startup;
exits on a 410. Authenticates with a per-node token or the admin's `DAEMON_TOKEN` (0016).
`video-gen.ts` is its ComfyUI client for both media job types: fill a template's `{{…}}`
placeholders, `/prompt`, poll `/history`, download from `/view`, upload to the hub. Templates come
per job type from `video.workflows.{image,video}` (`workflowPaths`; the legacy single
`video.workflow` still serves video; no image template configured means `image-gen` is not
offered — `offeredJobTypes`), placeholders in `deploy/amd/comfy/` until exported from the
real ComfyUI.

**`packages/ui`** — Vite + vanilla TypeScript, no framework (redesign: 0048, 0053). A store fed by
`/api/state` and the socket, and a window of three places: a navigation-only sidebar (`rail.ts`:
projects with status dots, `+`, Machines and Help), and a page per place, each with its own toolbar
(`toolbar.ts`: title, centred segmented control, actions). The **project page**
(`pages/projects.ts`) holds five tabs — Overview (`pages/project/overview.ts`), Plan (the PRD and
roadmap views), Docs (Pages · Media), Code (Files · Terminal · Preview · Browser) and Activity — mounted into its body; a
document's chat opens in a pane beside it, a team member's drawer (`panels/chat.ts`) floats over
it, and the project's levers live in a settings sheet (`pages/project/settings.ts`, controls in
`pages/project/controls.ts`). **Machines** (`pages/machines.ts`) is Nodes, Browser, Queue and
Access over the old `cluster`/`computer`/`allocation` mounts, which keep their page ids so the
store and the browser subscription are unchanged. The socket asks for the `browser` topic while
the computer page or a project's Browser view (`views/browser.ts`, the project's slot; 0063) is on
screen — `wantsCast` in the store — and the frames are dropped when neither is. Styles are a token file (`styles/tokens.css`,
light and dark, `data-theme` override) and one stylesheet per area in `styles/`, over `app.css`
— the component styles that predate the redesign, written against token aliases. Icons are an
inline SVG set (`icons.ts`); the floating parts are shared: `menu.ts` (the `⋯` and status
menus), `panels/modal.ts` (the dialog the settings and New project sheets fill) and `toast.ts`. Pure model functions (`turns.ts`, `models.ts`, `org.ts`, `rail.ts`,
`overview.ts`, `autorun.ts`, `code/model.ts`, and the terminal's frame helpers) are separated
from DOM code and tested in node; the docs shell is the one DOM-tested part (happy-dom, 0052).
CodeMirror is the Code tab's and is loaded only when Files opens (0043); its chrome uses the
tokens and its syntax palette follows the scheme. `@xterm/xterm` and `@xterm/addon-fit` are the
terminal's and load only when the Terminal opens, with their CSS (0041). Bundle: 200 kB JS (72 kB
gzip) and 79 kB CSS (15 kB gzip), plus the 565 kB editor chunk and the 336 kB terminal chunk.

**`packages/ui/src/panels/docshell.ts`** — the docs shell (0047): one three-column documentation
layout (grouped, filterable page rail; breadcrumb, title and pager; *On this page*), used by the
Docs tab, the PRD in Plan, and the Help page. `mountDocShell(host, options)` returns a
`DocShellHandle` (`root`, `update`, `navigate`, `destroy`). In `page` mode the pages are separate
documents and the rail swaps between them (Docs, the PRD read section by section); in `scroll`
mode they are the `##` sections of one document on screen at once, and the rail scrolls to them
(Help). Its parsing helpers (`parseFrontMatter`, `groupPages`, `splitSections`, `docToc`) are pure;
the shell itself is tested in happy-dom (0052). `renderDocMarkdown` (callouts:
`:::info|tip|note|warning|danger`) sits beside `renderMarkdown` in `markdown.ts`.

## Hub modules (`packages/hub/src`)

**`auth.ts`** — session cookies (HMAC), the daemon bearer(s), and `routeAccess`: every route is
`open`, `daemon`, `door`, `assistant` or `owner` by an explicit table; unknown routes deny.
`assistant` is an allow-list of project routes (`ASSISTANT_ROUTES`: state, briefings, projects,
turns, create, PRD draft, roadmap, turn, pause/resume, priority) that take the owner session or an
`assistant`-kind user API token, verified in `server.ts`'s hook through the door's `TokenGate`; an
`agent` token gets 403 there, and the token's label reaches the handlers as `requestedBy` (0065,
0067). `sameOriginWrite` is
the CSRF guard: a cookie-authenticated write must carry `Sec-Fetch-Site: same-origin` or the hub's
own `Origin`, because the preview listener is a different port on the same *site* and a
`SameSite=Lax` cookie would otherwise ride along (0040). Daemon routes declare the node they are
about so a node token cannot act for another node (0016). Login throttling per IP.

**`door.ts`** — the OpenAI-compatible door (FR-D6) and the user API tokens that open it. `ApiTokens`
stores only sha256 of a token, handing the plaintext back once at mint; `POST /api/tokens` (owner)
mints, `GET` lists, `DELETE` revokes. `TokenGate` pairs the store with one bad-bearer lockout and is
shared with the assistant scope (0065), so `/v1` and `/api` guesses count together. `GET /v1/models` names the two tiers (`agenthub/orchestrator`,
`agenthub/worker`; each also takes a route suffix, `@local`/`@cloud`/`@<provider>`, 0050) and
`POST /v1/chat/completions` turns the OpenAI wire shape into
`ChatMessage[]`/`ToolDef[]`, hands it to the gateway, and turns the `ChatResult` back — streaming
(SSE, with usage in the final chunk on request) or not. The token's `kind` picks the vLLM priority
(0020, 0035) and its label becomes the ledger's subject, so an outside client costs and caps like a
project turn (0034); a pi run's token (label prefix `pi:`, reserved) books to its project and member
instead, and any left live is revoked at startup (0050). Bad bearers meet login's throttle. It is registered in `server.ts` with one
line and is the only route family outside `/api/` that is guarded.

**`gateway.ts`** — picks an endpoint for a tier under a project's route (`local` / `cloud` /
`auto`, provider and model overrides), streams OpenAI-compatible or Anthropic chat, fails over,
marks unhealthy endpoints, sends per-endpoint `priority` — or a caller's per-request
`priorityOverride` (0035) — and `requestExtras` (0006, 0008),
refuses switched-off models and cloud past the spend cap (0002, 0019, 0024), and skips drained
and models-paused nodes (0054). It is the only place
a model is ever called, and it prices each request as it finishes.

**`providers/`** — `anthropic.ts` (SDK streaming) and `fireworks.ts` (base URL, the curated
model list with `hard` flags and prices, the key env). No I/O beyond what the gateway asks.

**`node-registry.ts`** / **`db.ts`** / **`queue.ts`** — nodes (with owner, token hash,
draining, models-paused, hardware), the SQLite schema with `ensureColumn` migrations, and the priority job queue
with fencing and requeue-on-offline. SQLite because one hub, tens of projects, a few users.

**`enrollment.ts`** — one-time enrollment tokens, hashing, the install command; the hub serves
`/install.sh` and a `git archive` of its own source so nodes never need repo access (0016).

**`usage.ts`** — the cost ledger. `UsageStore` holds one row per model request the gateway
served: when, for which project and session, by which roster member, on which provider, node and
model, and its prompt, cached and completion tokens with the dollars they came to. The gateway
prices each request as it finishes (`priceFor`/`costUsd` in `providers/fireworks.ts`, the only
price table the hub has, 0026) and returns it as `ChatResult.usage`; `AgentLoop` attributes it and
records it, which is what makes the ledger complete — every model call in the hub runs through
that loop (0022). `usd` is NULL for a model without a price, so tokens are never lost to a missing
price; local serving records $0. Two things read the ledger: `GET /api/usage/summary` (totals by
model and by subject for the UI) and `cloudUsdSince`, which the daily cap
(`MAX_CLOUD_USD_PER_DAY`) compares against to decide whether cloud endpoints are offered at all
(0024). A turn's own cost is the sum of the `usage` events in its feed, exact while it runs (0023).

**`agents/`** — `loop.ts` (the tool-use loop: transcripts, budgets, the briefing nudge),
`tools.ts` (workspace tools with paging, bundle tools, `spawn_subagent`, shell containment),
`verify.ts` (`complete_milestone`: tests, then a read-only reviewer; done needs a positive signal
and no negative one), `budgets.ts`, `transcript.ts`. The built-in loop is the manager's runtime
and the fallback harness (0013).

**`agents/harness/`** — where an employee's task actually runs. `Harness.run(task, ctx)` takes one
assignment (workspace, task, role, instructions, route, tool policy, budget, signal) and returns
a report, the files written and an outcome, emitting the run's `TurnEvent`s through `ctx.onEvent` —
so the Activity feed and the employee drawer look the same whichever runtime produced them (FR-G1).
`builtin.ts` is the existing `loop.run` path, unchanged and the default. `pi.ts` spawns the pi CLI
(pi.dev) in the workspace with `-p --mode json`, maps its JSON Lines events onto ours, collects the
files its `write`/`edit` calls named, enforces the tool-call budget pi has no limit of its own for,
and kills the process group on abort (0049). pi reaches models only through the hub's own door
(`door.ts`): its per-run `models.json` points at `<selfBase>/v1` with an `agent` API token minted at
run start and revoked in `finally`, asking for a model that carries the run's route
(`doorModel`), so failover, the ledger, the cloud cap and `maxStreams` apply (0050). `select.ts` picks the harness — the member's, else the project's, else `builtin` — given a
`HarnessDoor` (the hub's listen base and its `ApiTokens`) plumbed from `createHub` through
`ProjectService` and the orchestrator; every reason a choice cannot be honoured falls back to
`builtin` with the reason in the run's session events. `sandbox.ts` is the containment pi runs in
(0055): `sandboxedCommand(platform, opts)` wraps an argv in `sandbox-exec` with a deny-default
Seatbelt profile on macOS or in `bwrap` on Linux — reads everywhere but the hub's secrets and
other projects (`hiddenPaths(hostSecrets(), workspace)`), writes to the workspace (unless the
policy is read-only) and the run's temp dir only, network to a loopback door only (on Linux
through a per-run unix-socket bridge, `serveDoorSocket`, since the sandbox has its own loopback) —
and `sandboxStatus({ doorBase })` probes it by running it, caching a success. `detect.ts` is "is the CLI on PATH *and* can this host sandbox it", which `routes.ts`
serves as `GET /api/harnesses` (with the reason when not); pi is never run unconfined. The
project's default is set by `POST /api/projects/:slug/harness` in `server.ts`, with the member
route's refusals plus claude-code on a Local-only project (0068). The reviewer
stays on `builtin` (FR-G4) unless `HARNESS_REVIEWER_PI=1`, which runs it on pi with read-only tools.
`claude-code.ts` runs the `claude` CLI (`-p --output-format stream-json`) on the hub host's own
signed-in subscription — no key in the hub, Anthropic/Claude env vars stripped, HOME kept — in the
same sandbox with its second network mode, `{ https: true, keychain: true }` (outbound 443 + DNS,
the macOS keychain; no door); files written are its Write/Edit paths plus a scan for files modified
during the run, and its usage goes to the ledger through `AgentLoop.recordUsage` as
`anthropic-subscription` rows with `usd: null`, outside the cloud cap (0064). `detect.ts` offers it
when `claude auth status` says a subscription login and the https sandbox probes OK; the reviewer
never runs on it. `process.ts` is the subprocess handling both CLI adapters share: process group,
abort, wall clock, budget stop, JSON Lines.

**`projects/`** — `bundle.ts` (a git repo per project: manifest, PRD, roadmap, docs, decisions,
team, briefings, workspace), `prd.ts` (twelve fixed sections, the audit score, the drafter and
roadmap generator), `roadmap.ts`, `digest.ts` (a bounded workspace digest for turn continuity),
`chat.ts` (document-editor personas and one-on-one chats), `orchestrator.ts` (one turn),
`prompts.ts` (all agent prompts; the verify-first rules, 0010), `service.ts` (turn serialization,
time limit 0009, auto-run scheduling and caps 0001), `master.ts`.

**`projects/github.ts`** — the third way to start a project: import one that already exists. The
only module that ever sees a GitHub token, which is the point of it being one module. `Github`
clones a repository into a project's `workspace/`, pushes `agenthub/<slug>` after a verified
milestone, and opens the pull request the owner merges; `assertPushable` refuses, in code, to push
anything to the repository's own branch (0030). The token comes from a `GithubCredentials`
(`tokenFor(owner, repo)`) — one personal access token today, an App installation's short-lived
token next — and reaches git as a per-invocation `http.<host>.extraHeader` through `GIT_CONFIG_*`,
never in a remote URL and never in argv, with the whole inherited git environment stripped first,
system and global config switched off, and hooks disabled, because the clone is a directory agents
write (0028). Pushes name the computed URL rather than `origin` for the same reason. The token is
also kept out of every child the hub spawns: `secretsStripped()` in `@agenthub/shared/shell` is what
`run_shell`, the verify command and the daemon's shell-task runner hand `runShellTask`.
`ProjectService.create` drives the clone on the request's own path and removes the half-made bundle
if it fails; `PrdDrafter` reads the clone so the PRD describes the product that exists (0029);
`GET /api/github/status` answers `{ configured, method, connected }` and never the token. The
workspace is a real checkout, so the bundle ignores all of `workspace/` and a milestone's changed
files are read from that checkout's own index.

**`projects/github-app.ts`, `projects/github-installations.ts`** — the GitHub App half, so
connecting GitHub is a button rather than a token a member has to mint: `GET /api/github/connect`
sends the browser to GitHub's own "choose repositories" screen with a signed `state` (a nonce, the
member and an expiry — nothing is stored, 0032), and `GET /api/github/callback` exchanges the
`code` for a *user* token used once, to ask GitHub which installations that user has, and then
dropped (0031). GitHub's `installation_id` is never trusted; only an id in `GET /user/installations`
is stored, in `github_installations` (installation id, user, account — no token). `AppCredentials`
is a second `GithubCredentials` beside `PatCredentials`: it finds the installation covering a
repository by that installation's own repository listing (cached 5 minutes; the account name is the
fallback only when a listing cannot be read, so a repository an installation was not given falls
through to the token rather than stopping the chain) and mints a per-installation token, cached
until five minutes before GitHub expires it, with the app's
own RS256 JWT signed by `node:crypto`. `ChainedCredentials` is the precedence — the App, then the
personal access token (0033). `GET /api/github/repos` is what the New-project dialog's picker
shows; `DELETE /api/github/installations/:id` forgets one, the grant itself being the member's to
revoke on GitHub.

**`projects/terminal.ts`** — FR-B2, the Terminal: one Fastify plugin, registered with a single
line in `server.ts`, that owns `GET /api/projects/:slug/terminal` as a WebSocket upgrade. It spawns
the owner's shell (`$SHELL`, else `/bin/sh`) through node-pty in the project's `workspace/` and
joins pty and socket as binary frames both ways; the only text frames are `{type:'resize'}` up and a
one-line notice down. The route is `owner` by `routeAccess`'s default, so the daemon bearer and
per-node tokens cannot reach it, and the shell is handed `secretsStripped(process.env)` plus `TERM`
and `AGENTHUB_PROJECT` — a terminal is not a way to read the hub's credentials out of its own
process (0041). One socket is one shell: the process *group* is killed on close, so a backgrounded
grandchild goes with it. Four sessions per hub, a 30-second sweep that closes an idle session at the
hour and ends one whose peer stopped answering keepalive pings, and a start/end log line that is a
slug and a duration, never a transcript. Output is paused when a slow socket has a megabyte still
to write, so a `cat` of something enormous cannot be buffered into the hub's memory at pty speed;
at shutdown the groups are killed outright, since the hub will not be there to run an escalation.
It is registered only when the hub has a password, and refuses an upgrade whose `Origin` names any
host:port but its own — a WebSocket handshake is not same-origin-policed and carries cookies. The socket is paused until the pty and its
listeners are wired, because the handshake completes before the handler runs and xterm's first frame
is already on its way. The browser end is `packages/ui/src/views/terminal.ts` (the frame helpers and
a lazy `mountTerminal`) and `terminal-mount.ts` (xterm.js, the fit addon, reconnect with a banner —
a reconnect is a *new* shell and says so), the only module that imports xterm.

**`projects/preview.ts`** — the preview (FR-B1). `PreviewSupervisor` runs at most one dev server
per project, spawned detached in `workspace/` with `secretsStripped()` plus `PORT` and
`AGENTHUB_PREVIEW_BASE`, killed by process group, holding a 200-line log ring, joining concurrent
starts on one promise, and stopping itself after 30 minutes with no proxied traffic (0039).
`PreviewServer` is a **second HTTP listener on its own port** (`PREVIEW_PORT`, default the hub's
plus ten) that serves previews and nothing else: a preview document is project code, so it must not
share an origin with the hub's API (0040). Access is a per-project capability in the path,
`/p/<slug>/<cap>/…`, compared in constant time; the path is forwarded verbatim (0037), requests are
piped with `stream.pipeline` and upgrades are spliced at the TCP level (0038). The `previewRoutes`
plugin carries the owner's routes on the hub — `GET/PUT/DELETE /api/projects/:slug/preview`,
`POST …/preview/start|stop|restart|rotate` — and answers with the preview's absolute URL. The
manager sets a project's preview with the `set_preview` tool.

**`projects/media.ts`** + **`projects/media-routes.ts`** — project media (FR-E1–E3, 0060–0062).
`landMedia` turns a media job's uploaded bytes into `media/<kind>-<jobId>.<ext>` plus a sidecar
`.json` (prompt, params, job, node, duration) in the bundle root and commits; the artifact route
calls it for any `image-gen` / `video-gen` job whose project is a bundle (others keep the
memory-root path). `MediaDesk` is the one place a `MediaRequest` becomes a queued job — validation,
a hub-picked seed, a refusal when no registered node offers the kind — used by the owner's routes
(`GET/POST /api/projects/:slug/media`, `GET …/media/:file` served only from inside `media/`, real
path checked) and by `agents/media-tools.ts`, the `generate_image` / `generate_video` tools a
`designer` employee gets through `spawn_subagent`; they wait for the file, bounded by the turn's
signal. Both media job types take the node's one GPU slot (`isMediaJob`, 0061).

**`projects/code.ts`** — the Code screen's hub half (FR-B3–B5), registered into the server with one
line. Five owner-only routes under `/api/projects/:slug/code`: the tree (the workspace as one flat
sorted list, `.git`/`node_modules`/`dist`/… never descended into because `digest.ts` already decided
what is not the project's own code, binary and >2 MB files listed but marked unopenable, 5,000
entries then it says it stopped), one file read (UTF-8 only, decoded strictly so a mislabelled
binary is a 415 rather than a lossy round trip), one file written, and *Refresh map*. It shares the
agents' containment check rather than keeping a second one — `realWorkspacePath` in
`agents/tools.ts`, which is the tools' own lexical check with `realpath` on both sides so a symlink
inside the workspace cannot point out of it: a path an agent may not reach is a path the owner's
editor may not write either. A save commits where the workspace actually lives, the clone for an
imported project and the bundle otherwise, and reports `committed: 'none'` for the files it holds
out of history on purpose — credentials by convention, and whatever the repository ignores (0044).
*Refresh map* runs one manager-shaped task whose only writing tool is `write_code_map`, which is
`docs/code-map.md` and nothing more exotic (0046); it is one run per project at a time, aborts with
the request, and reports whether the page was actually rewritten. The guide it sits beside is a
persona in `chat.ts`, read-only by construction (0045).

**`projects/tour.ts`** — the tour over the code map (FR-B6), registered beside `codeRoutes`. One
owner-only route, `GET /api/projects/:slug/tour/:index` → `{ index, total, step, snippet,
explanation, cached }`. Steps and snippets come from `@agenthub/shared/tour` — `tourSteps(map)` (the
map's `path:line` spans in order) and `tourSnippet(text, line)` (the line to the end of its block by
indentation, at most 60 lines; 0056) — the same functions the UI draws the step with, so what is
tinted is what was explained. An explanation is the guide's prompt and read-only belt on the worker
tier, six tool calls, serialised per project and aborted with the request; it is kept as a committed
page `docs/tour/NN-<title>.md` whose key line (path, line, range, snippet hash) must match for the
page to be served again (0057). The UI half is `views/tour.ts`, a third tab beside Files and Map
(0058).

**`browser/`** — the browser pool (FR-D8, 0059). `lease.ts` is the `LeaseManager`: it reads the pool
(every slot of every registered browser node; a draining or offline node's slots marked) through a
provider, grants `(node, slot)` with a priority FIFO when full, one slot per project, lets the owner
preempt a named slot, and owes a reset when a slot passes to a different project. `proxy.ts`
forwards a live lease's actions to its node's browser server with `?slot=N` (resetting the slot
first when owed), records a frame per action under the lease, and casts a frame per held slot to
the `browser` WS topic. `routes.ts` is the `/api/browser/*` plugin; `recorder.ts` the timelines. On the
daemon, `node-daemon/src/browser/` is one Playwright browser with a context per slot behind a small
HTTP server.

**`assistant/`, `telegram/`, `external/`, `resources.ts`, `control-switch.ts`** — the built-in
assistant with its markdown memory, the grammY bot with a confirmation gate, external tools
(Grok, Gemini, search), the Spark video-slot exclusivity manager, and the control-node switch
(snapshot, data stamp, daemon rediscovery).

## Deployment

**`deploy/install.sh`** — the one-command node installer: detect hardware, install Node,
fetch the daemon from the hub, attach to an existing model server or register compute-only,
enroll, install a launchd agent or systemd user unit (0016, 0017). **`deploy/spark/`** — the
hub's and daemon's systemd user units and the box playbook. **`deploy/do/`** — the DigitalOcean
Caddy edge, its offline page for upstream failures (`handle_errors`, 503), and the `hub-watch`
timer/script that polls the hub and alerts Telegram on down/up transitions, keeping its own state
file and an optional bot token. **`configs/`** — daemon configs; `spark.yaml` is the live one
(attach mode, priority, thinking off for workers).
