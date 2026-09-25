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
wire shapes, scripts replies, records requests), a ComfyUI mock, and a daemon-config writer for
tests. Strictness is the point: a lenient mock once hid a broken wire format behind 650 green
tests.

**`packages/hub`** — the one long-running process. Fastify + SQLite. Owns the API, the UI
bundle, the WebSocket, the queue, the gateway, the projects, the assistant, Telegram, and now
enrollment and usage. Everything else talks to it; it talks to nodes only through what they
register (0003).

**`packages/node-daemon`** — one process per machine. Registers what the machine can do
(serving entries spawned or attached, 0005; shell jobs; a browser; a profile set; the hub itself
on a control node), heartbeats, claims jobs, runs them. Retries registration at startup;
exits on a 410. Authenticates with a per-node token or the admin's `DAEMON_TOKEN` (0016).

**`packages/ui`** — Vite + vanilla TypeScript, no framework. A store fed by `/api/state` and
the socket; pages (projects, computer, cluster, allocation, help); sheets for the PRD, roadmap,
docs, activity, code, the terminal and the preview; a drawer per agent with a live *Now* feed and a
chat. Pure model functions (`turns.ts`, `models.ts`, `org.ts`, `rail.ts`, `code/model.ts`, and the
terminal's frame helpers) are separated from DOM code so they are testable without a browser — the
UI's tests run in node, and nothing that needs a DOM is tested at all. No framework, but no longer
no runtime dependencies: CodeMirror is the Code sheet's and is loaded only when that sheet opens
(0043); `@xterm/xterm` and `@xterm/addon-fit` are the terminal's, and they are imported eagerly,
which is what makes the bundle 460 kB rather than 123 kB (0041, and the lazy-load follow-up on
ROADMAP).

## Hub modules (`packages/hub/src`)

**`auth.ts`** — session cookies (HMAC), the daemon bearer(s), and `routeAccess`: every route is
`open`, `daemon`, `door` or `owner` by an explicit table; unknown routes deny. `sameOriginWrite` is
the CSRF guard: a cookie-authenticated write must carry `Sec-Fetch-Site: same-origin` or the hub's
own `Origin`, because the preview listener is a different port on the same *site* and a
`SameSite=Lax` cookie would otherwise ride along (0040). Daemon routes declare the node they are
about so a node token cannot act for another node (0016). Login throttling per IP.

**`door.ts`** — the OpenAI-compatible door (FR-D6) and the user API tokens that open it. `ApiTokens`
stores only sha256 of a token, handing the plaintext back once at mint; `POST /api/tokens` (owner)
mints, `GET` lists, `DELETE` revokes. `GET /v1/models` names the two tiers (`agenthub/orchestrator`,
`agenthub/worker`) and `POST /v1/chat/completions` turns the OpenAI wire shape into
`ChatMessage[]`/`ToolDef[]`, hands it to the gateway, and turns the `ChatResult` back — streaming
(SSE, with usage in the final chunk on request) or not. The token's `kind` picks the vLLM priority
(0020, 0035) and its label becomes the ledger's subject, so an outside client costs and caps like a
project turn (0034). Bad bearers meet login's throttle. It is registered in `server.ts` with one
line and is the only route family outside `/api/` that is guarded.

**`gateway.ts`** — picks an endpoint for a tier under a project's route (`local` / `cloud` /
`auto`, provider and model overrides), streams OpenAI-compatible or Anthropic chat, fails over,
marks unhealthy endpoints, sends per-endpoint `priority` — or a caller's per-request
`priorityOverride` (0035) — and `requestExtras` (0006, 0008),
refuses switched-off models and cloud past the spend cap (0002, 0019, 0024). It is the only place
a model is ever called, and it prices each request as it finishes.

**`providers/`** — `anthropic.ts` (SDK streaming) and `fireworks.ts` (base URL, the curated
model list with `hard` flags and prices, the key env). No I/O beyond what the gateway asks.

**`node-registry.ts`** / **`db.ts`** / **`queue.ts`** — nodes (with owner, token hash,
draining, hardware), the SQLite schema with `ensureColumn` migrations, and the priority job queue
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
is already on its way. The browser end is `packages/ui/src/views/terminal.ts` (xterm.js, the fit
addon, reconnect with a banner — a reconnect is a *new* shell and says so).

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

**`browser/`** — the shared-browser lease, proxy and recorder; one session today, a pool later.

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
