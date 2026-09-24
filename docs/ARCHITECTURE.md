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
docs and activity; a drawer per agent with a live *Now* feed and a chat. Pure model functions
(`turns.ts`, `models.ts`, `org.ts`, `rail.ts`) are separated from DOM code so they are testable
without a browser.

## Hub modules (`packages/hub/src`)

**`auth.ts`** — session cookies (HMAC), the daemon bearer(s), and `routeAccess`: every route is
`open`, `daemon` or `owner` by an explicit table; unknown routes deny. Daemon routes declare the
node they are about so a node token cannot act for another node (0016). Login throttling per IP.

**`gateway.ts`** — picks an endpoint for a tier under a project's route (`local` / `cloud` /
`auto`, provider and model overrides), streams OpenAI-compatible or Anthropic chat, fails over,
marks unhealthy endpoints, sends per-endpoint `priority` and `requestExtras` (0006, 0008),
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

**`agents/harness/`** — where an employee's task actually runs. `Harness.run(task, ctx)` takes one
assignment (workspace, task, role, instructions, endpoint, tool policy, budget, signal) and returns
a report, the files written and an outcome, emitting the run's `TurnEvent`s through `ctx.onEvent` —
so the Activity feed and the employee drawer look the same whichever runtime produced them (FR-G1).
`builtin.ts` is the existing `loop.run` path, unchanged and the default. `pi.ts` spawns the pi CLI
(pi.dev) in the workspace with `-p --mode json`, maps its JSON Lines events onto ours, collects the
files its `write`/`edit` calls named, enforces the tool-call budget pi has no limit of its own for,
and kills the process group on abort (0031). `select.ts` picks the harness — the member's, else the
project's, else `builtin` — and resolves the model endpoint a subprocess needs (0032); every reason
a choice cannot be honoured falls back to `builtin` with a line in the job log. `detect.ts` is
"is the CLI on PATH", which `routes.ts` serves as `GET /api/harnesses`. The reviewer stays on
`builtin` (FR-G4).

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
`GET /api/github/status` answers `{ configured, method }` and never the token. The workspace is a
real checkout, so the bundle ignores all of `workspace/` and a milestone's changed files are read
from that checkout's own index.

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
