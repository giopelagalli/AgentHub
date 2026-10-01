# AgentHub — the user guide

AgentHub is your own software team on your own machines. You describe an app; the hub turns that
into a PRD and a roadmap; a manager agent runs *turns* in which employees (coder, researcher,
reviewer) build one milestone at a time on a local model; you watch, steer, and chat with any of
them. Everything runs on hardware you own — the Spark, the PC, the Mac mini — with a cloud model
only as a fallback you can see and cap.

This guide is the reference for the app as it is today. It is rendered inside the app under
**Help** and lives in the repo at `docs/guide.md`.

## The pieces

- **Hub.** One process (on the Spark, port 4000) that holds the projects, the queue, the web app
  and the API. Everything else talks to it.
- **Nodes.** Machines that offer compute. Each runs a small *node daemon* that registers with the
  hub, says what it can serve (a model for the orchestrator tier, one for the worker tier, a
  browser, shell jobs) and heartbeats. The Spark is a node too. There are also two synthetic
  nodes, `cloud-fireworks` and `cloud-anthropic`, which stand for the cloud providers you have
  configured; they are always "online" and never swept.
- **Projects.** Each project is a folder that is also a git repository: its PRD, roadmap, docs,
  decisions, team, briefings and the `workspace/` where the actual code lives. Every change an
  agent makes is a commit, so nothing is ever lost or invisible.
- **Employees.** The agents of a project. The **Manager** plans and delegates; **employees**
  (roles: coder, researcher, reviewer, browser-operator) do the work. You can add, remove, and
  instruct them, and chat with each one on one.
- **Models.** A *tier* is a job for a model: *orchestrator* (the manager, planning, the PRD
  drafter) and *worker* (employees). Each node says which model it serves per tier. The hub
  picks local first and the cloud only when local is unavailable, unless a project says
  otherwise.
- **JD.** Your Telegram assistant is a separate program on the Spark that shares the same model
  server. Today it does not talk to the hub; that integration is the next plan
  (`docs/plan-jd-web-agenthub.md`).

## The screen

The **sidebar** on the left is only navigation: your projects (each with a status dot — green
working, grey idle, amber needs you, red last turn failed, a ring while paused), a search box, **+**
for a new project, and at the bottom **Machines** and **Help**. Press `[` (or the sidebar button in
the toolbar) to hide or show it; on a phone it opens as a drawer. Left and right arrows move
between projects.

A **project** has a toolbar along the top: its name and status dot, five sections — **Overview ·
Plan · Docs · Code · Activity** — then a **Chat** button (the Manager, also `c`), the one primary
button, **Run turn** (it reads `Running · m:ss` while a turn runs, with a thin line under the
toolbar that lights on every event), and **⋯** (Settings, Add employee, Pause/Resume, and the
repository links of an imported project).

- **Overview** — where the project is: the current milestone, how much of the roadmap is done, the
  latest briefing in two lines and the next step. Before there is anything to show it leads with
  one invitation instead — *Draft the PRD*, *Generate the roadmap*, *Run the first turn*. Under it,
  the **team** as faces (click one to open that person), the last three turns, and *In this
  project* — a line each for the requirements, roadmap, docs, code and preview.
- **Plan** — the PRD (*Requirements*) and the **Roadmap**, side by side under a small switch. Each
  has an **Ask the …** button that opens a chat beside the document with the agent that edits it
  ("move milestone 4 before 2", "add a section on backups"); it changes the document in place.
- **Docs**, **Code** (*Files · Terminal · Preview · Browser*) and **Activity** — see their sections below.

**Settings** (from **⋯**) is a sheet grouped like macOS Settings: **Models**, **Schedule**,
**Priority**, **Team** (add or remove employees) and **Pause**. Everything applies as you change it.

## Starting a project

**New project** (the **+** in the sidebar) asks how you want to start:

- **Describe an idea** — a paragraph. The PRD drafter (orchestrator tier) writes a full PRD
  from it, streaming, in about two minutes on the Spark.
- **Paste a PRD** — your own document. It is filed as-is and scored.
- **Import from GitHub** — a repository you already have. See below.

Then it asks one thing at a time: the name (and the short name used for its folder and address),
then the paragraph, the document or the repository. **Create project** creates it and streams the
draft into the same sheet; when it is done the PRD opens in **Plan** with the drafter's open
questions above it.

The PRD has twelve fixed sections (overview, goals and non-goals, users, functional requirements,
UI, data, security, scalability, operations, acceptance criteria, risks and open questions,
glossary). The **score** beside the PRD's title is how many sections are actually filled; the manager
refuses to build on an empty scaffold, and the schedule skips such projects.

Then **Generate the roadmap** (on the Overview, or **Plan → Roadmap**). The planner reads the PRD
and proposes milestones in build order with estimates. It is a checklist — ✓ done, ● in progress,
○ planned: drag a milestone, use its arrows (or Option-↑/↓), press its circle to change its
status, or tell the planner what to change. `m1` is the first milestone; ids are positional.

**Docs** starts with two pages — the index and the decision log — and grows as the team writes.
The decision log is the *why*: every notable choice an agent makes lands there with the PRD
requirement it serves.

Then **Run turn**.

## Import a repo

Give it the repository (`owner/repo`, or its github.com URL — the SSH form works too) and,
optionally, a branch; leave the branch blank for the repository's default. The paragraph box asks
**what do you want done?** — that is your instruction, not a description of the product.

Continue clones the repository into the project's `workspace/` (full history) and *then* drafts the
PRD, so the document describes the product you actually have with your request layered on top. The
roadmap starts with what the code already delivers, listed as **done** milestones; the first
planned milestone is the first new thing. The Overview shows `owner/repo @ branch` under the
intent, linking to GitHub.

**Connect GitHub.** Public repositories clone without anything. For a private one — and for
pushing anything back — the hub needs to reach GitHub as you. If the hub has the AgentHub GitHub
App set up (the owner does that once; see *Operating the hub*), **Import from GitHub** shows a
**Connect GitHub** button. Press it and you are on GitHub's own screen, signed in as yourself,
choosing **which repositories AgentHub may use** — all of them, or a list you pick. Approve, and
you land back on the hub with "GitHub connected".

There is no token to make and nothing to paste. After that, the Repository field is a **picker** of
the repositories you chose, newest first, with the branch shown; the text box stays beside it if
you would rather type `owner/repo`. The picker lists up to 500 repositories per connection — past
that, type the name instead; importing it still works.

**Changing your mind.** The repositories are yours to change at any time: **GitHub → Settings →
Applications → Installed GitHub Apps → AgentHub → Configure**, or the **Manage on GitHub** link in
**Machines → Access**. **Disconnect**, on that same line, makes the hub forget the connection; the app
stays installed on GitHub until you remove it there, under the same Configure screen
(*Uninstall*).

**The token (the other way).** A hub with no GitHub App uses one token instead, for everybody. Make
it at **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**:
*Only select repositories*, and under Repository permissions set **Contents: Read and write** (and
**Pull requests: Read and write** if you want the button below to work). Put it in `hub.env` as
`GITHUB_TOKEN` and restart the hub. Either way the credential is never logged, never written into
the clone, and never sent to the browser — the line under the Repository field says only *how* the
hub reaches GitHub, never with what.

**Getting work back.** Agents never push to your branch. After each *verified* milestone the hub
commits what the milestone produced in `workspace/` and pushes it to **`agenthub/<slug>`** — one
commit per milestone. Once something has been pushed, an **Open pull request** button appears next
to the repository line on the Overview: it opens a pull request from `agenthub/<slug>` into the branch you
imported, and then links to it. Pressing it again after a later milestone finds the same pull
request rather than opening a second one. Merging is yours.

The commit leaves out `.env*`, `*.pem` and `*.key` wherever they are in the workspace — agents
write those while wiring things up and they are not yours to publish. That is a rule of thumb, not
a guarantee: read the pull request. It also means a `.env.example` or a test fixture named `*.key`
stays behind, and you commit it yourself if you want it.

A push that fails (no token, network, permissions, or somebody rewrote `agenthub/<slug>`) never
un-does the milestone: it is recorded in the decision log and in the turn's Activity feed, and the
next verified milestone tries again.

## Turns

A **turn** is one sitting of the manager: it reads the roadmap, the last briefing and a digest of
the workspace, picks the current milestone, and delegates. Concretely:

1. The manager (orchestrator tier) orients itself — lists the workspace, reads the roadmap,
   checks the toolchain.
2. It writes a spec and calls `spawn_subagent`. An employee (worker tier) runs its own loop of
   tool calls: read and write files in `workspace/`, run shell commands there, and report back
   with `Files written:`.
3. The manager may spawn more employees, then asks for the milestone to be marked complete.
4. **Verification.** `complete_milestone` runs the project's tests (`verifyCmd` from the
   manifest, else `npm test`, else `node --test`), then spawns the reviewer with read-only tools
   and the list of changed files. The milestone is *done* only with at least one passing signal
   and no failing one. A milestone that fails stays in progress with the findings in the log.
5. The manager publishes a **briefing** — what happened, what's next, what's blocked. It is
   committed under `briefings/` and shown on the Overview.

Limits that shape a turn: the manager has 40 tool calls, an employee 25; a turn is cut off at
45 minutes (`TURN_TIMEOUT_MINUTES`). Expect one milestone per turn; a big milestone can take two.

**Activity** is the live feed of all of this: who is acting, each tool call folded with its
result and timing, employees' work nested under their task, the verification result, the
briefing. Reloading mid-turn recovers the feed. Rows in red are errors.

When a turn's summary says it **was cut short**, the hub stopped (a restart) or the 45-minute
(`TURN_TIMEOUT_MINUTES`) limit hit — the model did not fail. **Hit its tool-call budget** means the manager ran out of
calls before reporting; the next turn starts from the last briefing and the workspace digest, so
nothing is lost, but that milestone probably needs a tighter spec or a split.

**Pause** (in **⋯**, or Settings → Pause) stops new turns (manual and scheduled); running ones
finish. **Resume** re-enables.

## Schedule (turns on their own)

Off by default. Turn it on per project in **Settings → Schedule → Run on its own**: every 15
minutes, 30 minutes, 1, 2 or 4 hours, at most N turns a day (default 6). The hub also enforces:

- a hub-wide cap of **24 turns a day** across all projects (`MAX_TURNS_PER_DAY` in `hub.env`),
  shown under the schedule as *N of 24 left across the hub*; a manual Run turn past the cap is
  refused with a reason;
- **no scheduled turns on a project whose PRD is still a scaffold**;
- **suspension after three consecutive same-class errors** (say the model server is down) with a
  Telegram alert if the bot is configured; resume by switching *Run on its own* back on;
- `AUTO_TURNS=0` in `hub.env` disables scheduling on the whole hub.

Why the caps: unattended turns on a paid model are the one way this system can spend money
while you sleep. The caps make the worst day boring.

## Priority (what runs first)

**Settings → Priority** (and every row of **Machines → Queue**) is the hub's queue class for that
project's work: `Runs first`, `Normal`, `When idle`. When two projects want the same node —
a model slot, the shared browser, a shell job — the higher class goes first; within a class it's
first come, first served. It is *not* how fast a single turn runs; with one project it changes
nothing.

Not to be confused with the model server's own request priority on the Spark: every AgentHub
request carries `priority: 10` and JD's carry none (0), so JD's messages are scheduled ahead of
agent traffic on the shared vLLM. That is a node setting (`configs/spark.yaml`), not a project one.

## Models

**Settings → Models** on each project:

- **Auto (local first)** — the default. Local nodes serve everything; if the tier's local nodes
  are all busy the request waits for a slot; if none is *available* (offline, erroring) the
  request goes to a configured cloud provider, and comes back to local as soon as it is up.
- **Local only** — never spend; if local is unavailable the turn fails and says so.
- **Any cloud** / **Fireworks (default models)** / **Fireworks: <model>** — cloud first, local
  as the fallback. Picking a concrete model sets it for both tiers; an **Employees use** select
  appears to change the employees' model separately.
- **(off)** entries — the expensive tier (`glm-5p3`, `kimi-k3`). Greyed out until
  `FIREWORKS_HARD_MODELS=1` is set in `hub.env` and the hub restarted; a project that had one
  saved falls back to the provider's default while the switch is off.

**Machines → Nodes** shows every node's tiers and live stream counts, so you can see where a turn
is actually running.

## Harnesses

A *harness* is the program that actually does an employee's task. The model decides what to do;
the harness is what reads files, edits them and runs commands.

- **Built-in loop** — the hub's own. Nothing to install, tools scoped to the project workspace,
  and the only runtime the manager and the milestone reviewer ever use. This is the default.
- **pi** — [pi.dev](https://pi.dev), an open-source coding agent. The hub runs it as a program in
  the project's workspace and shows its work in the Activity feed exactly like a built-in run: the
  same tool calls, the same report, the same "files written" line. pi never gets a provider key: it
  calls models through the hub's own door (`/v1`), with a token made for that one run and revoked
  when it ends, so it is served by the same models — and the same failover — as everything else.
- **Claude Code** — Anthropic's `claude` CLI, on *your Claude subscription* (Pro/Max), signed in
  on the hub host. The hub never holds an API key for it and never uses the API: it runs the CLI
  you logged in, which uses your plan's limits rather than a bill.

**Installing pi on the hub host.** The hub only offers a harness it can actually start, so pi has
to be on the hub machine's `PATH` — installing it in your laptop's terminal does nothing. On the
Spark:

```
npm install -g @mariozechner/pi-coding-agent
pi --version
```

Then restart nothing: the hub checks for it per request. (The installer will do this step for you
once harnesses are part of it; for now it is one command.)

**The sandbox.** pi only ever runs inside an OS sandbox, and the hub only offers pi on a host that
can make one. Inside it pi can read the disk (so node, npm and your toolchains work) except the
hub's data directory (its database and every other project), `configs/`, the GitHub App key and
`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.docker`; it can write only the project's
workspace and its own scratch directory; and its only network is the hub's door —
no `npm install`, no fetching from a remote, nothing else on the internet or on your LAN. Install a
project's dependencies before giving its work to pi.

- **macOS**: works out of the box (Seatbelt, `/usr/bin/sandbox-exec`).
- **Linux** (the Spark): needs bubblewrap — `sudo apt install bubblewrap`. Ubuntu 24.04 and later
  may refuse it the user namespaces it needs through AppArmor; if so the Harness list says
  "pi cannot be sandboxed on this host" with bubblewrap's own error.
- A hub bound to one address (`HUB_HOST=100.x…`) cannot run pi: the sandbox only reaches
  loopback. Leave `HUB_HOST` unset (all interfaces) to use pi.

**Signing Claude Code in on the hub host.** Install the CLI on the hub machine (see
claude.com/claude-code) and, in a terminal *on that machine, as the user the hub runs as*, run
`claude` once and log in with your Claude account. That's all — the hub checks
`claude auth status` per request and offers **Claude Code** in the Harness list once it says you
are signed in with a subscription. If the list says "claude is not signed in on this host", do the
login again there; an API-key login is refused on purpose.

Claude Code runs in the same sandbox as pi with one difference: it talks to Anthropic itself, so
its network is any HTTPS host rather than the hub's door. It can read your Claude login (it needs
to), and anything else it can read it could send out over HTTPS — give it ordinary workspace work,
like pi. Its runs show tokens on the usage page with no dollar figure and never count toward the
daily cloud cap; your subscription's own limits apply instead. Choosing it for an employee means
their tasks go to Anthropic's cloud — except in a **Local-only** project, which never runs Claude
Code: those tasks stay on the built-in loop and the turn log says why. The reviewer never runs on
it.

For now Claude Code runs on a **macOS** hub only. On Linux the sandbox could only give it the
host's whole network, your local services included, so the Harness list says "claude-code's
network sandbox is not yet available on Linux" until that can be narrowed to HTTPS.

**Choosing it.** For the whole project, open **Settings** from the toolbar's **⋯** menu and use
**Harness** under Models: every employee runs on it unless given their own. Harnesses this hub
can't run are greyed out with the reason underneath, and so is Claude Code in a **Local-only**
project. For one employee, open their drawer — click their face on the Overview — and use the
**Harness** select under Model; **Project default (pi)**, or whatever the project uses, puts them
back on the project's choice. Either field only appears when there is more than one harness to
pick from. Nothing else changes: their model override, their standing instructions and their
history all stay.

**What to know before you switch someone:**

- The sandbox hides a fixed list of secrets, not everything: anything else pi can read it could
  copy into the workspace, which an imported project's push carries out. Give
  pi to employees doing ordinary workspace work, not to one following instructions from somewhere
  you don't control.
- The reviewer runs on the built-in loop, whatever you set, unless the hub was started with
  `HARNESS_REVIEWER_PI=1`; then a reviewer set to pi runs on it with read-only tools
  (`read,grep,find,ls`) inside the sandbox, with the workspace read-only as well. It is off by default until it has been tried on the Spark.
- Spend on a pi run lands on the usage page under its project, like any other employee's, and
  counts toward the daily cloud cap. While a run is live its token shows in the API tokens list;
  it disappears when the run ends (or, after a crash, when the hub next starts).
- If pi isn't installed, can't be sandboxed, or the hub's door isn't reachable yet, the employee runs on the built-in
  loop instead and the run's session events say why — the work still gets done. pi's own error
  output lands in the same place.

## Nodes

**Machines → Nodes** lists nodes with status, the model per tier and active streams, with the cloud
spend over them; the job queue is under **Machines → Queue**.

The Spark is configured in `configs/spark.yaml` in *attach mode*: the daemon does not start a
model server, it attaches to the vLLM that `sparkmodel.service` already runs on `:8888`, checks
it answers, and registers both tiers with `priority: 10` and small stream caps (2 orchestrator,
3 worker) because the KV cache is shared with JD.

**Adding a node.** Press **Add machine** above the list. The hub mints a one-time token — good for
24 hours, usable once — and shows the command it belongs to:

```
curl -fsSL http://<hub>/install.sh | sh -s -- --hub http://<hub> --token <token>
```

Copy it, run it on the machine you're adding, and you're done: it installs the node daemon, fetches
the hub's own source (the machine never needs repo access), enrolls the node under your account,
and starts it under systemd or launchd. The node appears in the table within a minute. Re-running
the command on a machine that's already a node updates it in place and rotates its token.

Each node gets its own bearer token, which is why the **Owner** column exists: a node's token works
only for that node — it can register, heartbeat and report on its own jobs, and nothing else. The
hub stores only a hash of it, so the plaintext exists once, in the reply to the installer. **Remove**
deletes the token along with the node, so a removed daemon cannot come back on its own.

The manual way is still there as a fallback: install Node 22, clone the repo, write a config from
the examples in `configs/` (`amd.yaml` for the 7900 XTX, `macbook.yaml`, `macmini.yaml` for the
browser node), set `DAEMON_TOKEN` to the hub's shared token, and run
`npx tsx packages/node-daemon/src/main.ts <config>` under a service; the per-machine playbooks are
in `deploy/`. `DAEMON_TOKEN` remains the admin's break-glass and works for every node.

A node's **⋯ → Drain** stops new jobs, turns and browser leases from landing on a node while
whatever it's already running finishes, and **Undrain** reverses it. **Remove** forgets the node
outright — its daemon exits once the hub tells it so — so getting it back means re-running its
service or install.

**⋯ → Pause models** is the narrower lever: the node stays online, keeps heartbeating and keeps
claiming jobs, but the model gateway stops picking its serving endpoints, so chat and agent turns go
elsewhere. **Resume models** puts them back. Use it to stop generating on a local model without
taking the machine offline; use **Drain** when the machine should take no work at all. With every
local model paused, projects set to Auto fall through to the cloud tier, subject to
`MAX_CLOUD_USD_PER_DAY`, while projects set to Local fail with "no capacity … (local models paused)"
rather than spend.

A node is *offline* when its heartbeats stop; the hub requeues its jobs and routes around it.

The one-command installer is `curl -fsSL <hub>/install.sh | sh -s -- --hub <hub> --token <token>`,
with the token minted by *Add machine* in Machines → Nodes. It detects the machine, installs Node 22
if it has to, fetches the daemon from the hub (no clone, no repo access), attaches to an
OpenAI-compatible server that is already listening or picks the recipe for the hardware class —
registering compute-only when no recipe is verified for it yet — writes `~/.agenthub/node.yaml`,
enrolls, and starts the daemon under launchd or systemd. Re-running the same command updates the
node in place; `--uninstall` reverses it. `--dry-run` prints the whole plan without touching the
machine, which is the quickest way to see what a given box would become. The flags, the recipe
table and everything it writes are in `deploy/README-install.md`.

## Using the hub as an API

The hub speaks OpenAI. Anything that can point at an OpenAI-compatible base URL — JD, pi, the
`openai` SDK, plain `curl` — can use your nodes through it, with the hub's routing, the hub's
spend cap, and one line per request in the same cost ledger Machines shows.

**A token.** **Machines → Access → API tokens** → a label and a kind → **Create token**. The token
(`ah_…`) is shown once and never again; the hub keeps only a hash. Revoke it from the same list
and it stops working immediately.

**The two kinds** set the request's priority on a shared server (the Spark runs one model for
everyone):

| Kind | For | vLLM priority |
|---|---|---|
| `assistant` | something you are waiting on — JD, a chat client | 0 (first in line) |
| `agent` | something running by itself — a coding harness, a batch | 10 (yields to the above) |

**The base URL** is the hub's, plus `/v1`: `https://rosenroot.com/v1` from outside,
`http://<hub>:4000/v1` on the tailnet. Bad tokens are locked out per client address after five
tries, so behind the droplet's proxy `TRUST_PROXY` must be set (`configs/hub.env`) or every
outside client counts as one — a valid token is never affected either way.

```sh
curl https://rosenroot.com/v1/chat/completions \
  -H "Authorization: Bearer ah_…" -H "content-type: application/json" \
  -d '{"model":"agenthub/worker","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

**The models.** `GET /v1/models` lists the two that matter:

- `agenthub/orchestrator` — the thinking tier.
- `agenthub/worker` — the working tier.

Both are *tiers*, not models: the hub picks the node, exactly as it does for a project's turns,
and the response's `model` field says what actually served it. A concrete model id that is
serving right now also works — a cloud id routes to that provider, a local id stays local.
A tier name also takes a route suffix: `agenthub/worker@local` (local only — a 503 rather than a
cloud bill when nothing local is serving), `@cloud`, or a provider such as `@fireworks`.

Streaming and non-streaming both work, as do `tools` and `tool_calls`; ask for
`stream_options: {"include_usage": true}` and the last chunk carries the token counts. Fields the
hub has no use for (`temperature`, `max_tokens`, …) are accepted and ignored. Spend through the
door counts against `MAX_CLOUD_USD_PER_DAY` like everything else, and shows on the cloud-spend line
in Machines → Nodes.

### Driving projects with an assistant token

An `assistant` token also opens a short, fixed list of the hub's own `/api` routes, so JD (or a
script of yours) can start and steer projects the way you do from the UI (0065). Nothing else:
tokens, nodes, enrollment, GitHub, the terminal, previews, code edits, media and the browser stay
yours alone. An `agent` token gets **403** on these routes — agents never create projects or start
turns. Bad tokens share the door's lockout (five tries per address, then 429).

| Route | What it does |
|---|---|
| `GET /api/state` | the whole hub: nodes, jobs, projects with their last turn |
| `GET /api/briefings` | every project's latest briefing |
| `GET /api/projects` | every project's manifest |
| `GET /api/projects/:slug/turns?since=<ms>` | recent turns; with `since`, only those that ended at or after it |
| `POST /api/projects` | create — `{slug, title, intent, idea?, priority?}`; importing a repo (`source`) stays yours (403) |
| `POST /api/projects/:slug/prd/draft?wait=1` | draft the PRD from the idea; `wait=1` answers JSON instead of a stream |
| `POST /api/projects/:slug/roadmap/generate?wait=1` | turn the PRD into milestones, same `wait=1` |
| `POST /api/projects/:slug/turn` | run one turn — `{instruction?}`; answers with the briefing when it lands |
| `POST /api/projects/:slug/pause` / `resume` | stop / restart scheduling |
| `POST /api/projects/:slug/priority` | `{priority: "interactive" \| "project" \| "batch"}` |

Whatever a token does is signed with its label: commits say `(by JD)`, and a turn it started
carries `"requestedBy": "JD"` in `/turns`, so it can tell its own turns from yours (0067).

```sh
H='Authorization: Bearer ah_…'; J='content-type: application/json'; HUB=http://<hub>:4000
# create, then draft (a model run: give it minutes, not seconds)
curl -sX POST $HUB/api/projects -H "$H" -H "$J" \
  -d '{"slug":"tide-clock","title":"Tide clock","intent":"a tide clock for the harbour","idea":"…"}'
curl -sX POST "$HUB/api/projects/tide-clock/prd/draft?wait=1" -H "$H" -H "$J" -d '{}'
curl -sX POST "$HUB/api/projects/tide-clock/roadmap/generate?wait=1" -H "$H" -H "$J" -d '{}'
# run a turn; hanging up does not stop it, so fire it and poll
since=$(($(date +%s) * 1000))
curl -sX POST $HUB/api/projects/tide-clock/turn -H "$H" -H "$J" -d '{"instruction":"start on m1"}' --max-time 5
curl -s "$HUB/api/projects/tide-clock/turns?since=$since" -H "$H"   # → turns[0].summary when it lands
```

A hanging-up client does stop a `?wait=1` draft (as a closed stream does), but not a turn; the hub
gives up on a `?wait=1` run itself after 10 minutes (504). On a
hub started without a password (the dev sim) nothing is checked and nothing is signed.

## Preview (seeing the app)

**Code → Preview** shows the project's own app running inside the page, plus **Start**, **Stop**, **Restart**,
**Open in tab**, a **Settings** form and the dev server's last 50 lines of output.

The hub runs the dev server on its own machine, in the project's `workspace/`. It does **not** serve
it on the hub's own address: previews get a second listener on their own port (`PREVIEW_PORT`,
`4010` when the hub is on `4000`), because the app is code the agents wrote and it must not share an
origin with the hub's API. The manager usually sets a preview up itself (the `set_preview` tool)
once a milestone stands a dev server up; you can also set it by hand under **Settings**: the command
(run in the workspace, split on spaces), the port, and optionally the path the preview should open
on.

**The link is the key.** There is no login on the preview port, so each project's address carries a
secret: `http://<host>:4010/p/<slug>/<32 hex>/`. Anyone holding that link can open that app, so
treat it like a password — and if it gets out, **Settings → Reset link** mints a new one and the old
address stops working immediately.

**About base paths.** The hub does not rewrite anything on the way through: your app is served under
`/p/<slug>/<cap>/`, so the dev server has to be told that is where it lives. Read it from the
environment rather than writing it out — the hub puts it in the child's environment as
`AGENTHUB_PREVIEW_BASE`:

    // vite.config.js
    export default { base: process.env.AGENTHUB_PREVIEW_BASE ?? '/' }

A hard-coded path works until the next link reset, and then silently stops. Without a base path at
all, the page loads and every script and stylesheet it asks for 404s.

Two things it does on its own: a preview nobody has looked at for 30 minutes is **stopped** (the log
says so — press Start), and a preview that dies on its own reads **Crashed** with its last lines
still on screen. The dev server never sees your session cookie, and nothing but previews is served
on that port.

Publishing previews through the public site is a second Caddy site and a `preview.` DNS record —
`deploy/do/README.md` §8b.

## Media

**Docs → Media** shows the images and clips made for a project, each with the prompt and settings
that made it, and a box to ask for another: pick **Image** or **Video**, a size (and a length for a
clip), describe it, **Generate** (⌘↩). The job shows under the box while it waits and renders; the
file lands in the project bundle as `media/image-<job>.png` / `media/video-<job>.mp4` beside a
`.json` with the prompt, size, seed, machine and render time, and is committed. An employee with
the **designer** role can do the same from a turn (`generate_image`, `generate_video`) — the
manager asks a designer for an app icon, a hero image or a demo clip.

"No machine can render images yet" means no registered node offers `image-gen`. Rendering runs on
the PC (the 7900 XTX) through ComfyUI (decision 0018: Qwen-Image for stills, Wan 2.2 or LTX-2 for
clips). What the PC needs:

1. **ComfyUI on ROCm**, running locally (`http://127.0.0.1:8188`), with the models downloaded.
2. **The by-hand test first**: render one image and one clip in ComfyUI's own web UI from the
   models' example workflows, and tune them until they look right.
3. **The templates**: `deploy/amd/comfy/qwen-image-t2i.json` and `wan22-t2v.json` are placeholders
   (`TODO-verify` marks every guess). Export the tested workflows from ComfyUI (*Export (API)*)
   over them and put the `{{prompt}}`-style placeholders back — `deploy/amd/comfy/README.md`.
4. **The node config** — the daemon offers both job types and points at the templates:

   ```yaml
   jobTypes: [image-gen, video-gen]
   video:
     comfyUrl: http://127.0.0.1:8188
     workflows:
       image: /opt/agenthub/deploy/amd/comfy/qwen-image-t2i.json
       video: /opt/agenthub/deploy/amd/comfy/wan22-t2v.json
   ```

   An older config with a single `video.workflow` keeps working for clips. Without
   `workflows.image` the node does not offer `image-gen` at all, even if `jobTypes` lists it.

One render at a time per machine: a still or a clip parks the machine's worker model while it runs
and hands it back after (decision 0061). In the simulation, `sim-media` renders against a mock
ComfyUI in a few seconds, and `pomodoro-cli` starts with an app icon.

## The browser pool (Machines → Browser)

A browser node (the Mac mini) runs one browser with several isolated sessions — *slots* — set by
`browser.slots` in its daemon config (default 1, at most 8). Agents *lease* a slot for a task and
release it. A project holds one slot at a time: its manager and employees share it, so several
projects browse at once and nobody in a project waits for a colleague. A slot that passes to a
different project starts over in a fresh, empty session, so nothing of the last project carries
over. When every slot is taken,
requests wait in line (manager before employee) and get the next slot that frees up.

**Machines → Browser** has a tile per slot: the node and slot number, who holds it and for how
long, and a live thumbnail. A free slot stays quiet. **Watch** shows a slot large at the top;
**Take control** takes that slot for you (its holder's next action fails, other slots carry on);
**Release** gives a slot back. **Drain** on a browser node stops it handing out slots — current
holders finish — and **Remove** takes its slots away. A browser node that misses heartbeats keeps
its holders' leases until they run out. Pausing models doesn't affect the browser.
Recordings of each session are kept under the data root, one per lease.

## The terminal

**Code → Terminal** opens a real shell in that project's `workspace/`, on the machine the hub runs
on.

- It is a proper terminal, not a command box: `vim`, `top`, an interactive rebase, tab completion
  and colours all work, because a pseudo-terminal is what is on the other end.
- **One view is one shell.** Leave it, or lose the connection, and the shell is killed —
  along with anything it started in the background. Reconnecting gives you a *new* shell, which the
  banner says; **New session** does the same on purpose.
- Four terminals at a time across the whole hub, and one that sits untouched for an hour closes
  itself. A tab that went away without saying so — a closed laptop, a dropped tunnel — is noticed
  within a minute and its shell ended, so it cannot sit on one of the four.
- When the hub says why a session ended (the hour, the shell exiting, all four in use), the view
  stops there and waits: **New session** is how you start another. Only an unexplained drop
  reconnects on its own, and a reconnect is always a new shell.
- The hub logs that a session happened — which project, how long — and never what you typed.

**No password, no terminal.** A hub started without `HUB_PASSWORD` has no terminal route at all —
the view opens and reports that it cannot connect — because owner-only means nothing on a hub
where there is no owner to be. A browser page on another site cannot open one either, even in a
browser you are logged in on: the hub checks where the request came from before it upgrades.

**It is your shell, with your reach.** It is scoped to the workspace only in the sense that it
*starts* there: everything the user running the hub can do, this can do. It is owner-only for that
reason — the daemon token and a node's own token are refused at the door — and it stays owner-only
until per-member access arrives, when a terminal will only ever open on a node you own. The one
thing it cannot see is the hub's own secrets: model keys, the session secret and the GitHub token
are stripped out of its environment, the same way they are for anything an agent runs.

## Code

**Code → Files** is the project's workspace: the file tree on the left, the file you picked in the
middle, and the **Guide** docked on the right (on a narrow window, **Ask the guide** opens it). *In
this project* on the Overview says how many files the workspace has and how long ago the map was
refreshed.

**Files.** Click a folder to fold it open or shut, a file to read it. Arrow keys walk the tree and
Enter opens what is selected. Binary files and anything over 2 MB are listed but say *not text* —
they are there so you know they exist, not to be opened. Dependencies, build output and `.git` are
never listed at all.

**Editing.** The file is editable as it stands. **Save** (or `Cmd`/`Ctrl`-`S`) writes it and commits
it as `Owner edit: <path>` — to the project's own repository if it was imported from GitHub, to the
bundle otherwise. That commit is the point: the next turn reads the workspace, so an edit nobody
recorded is an edit the agents overwrite. A dot beside the filename means unsaved changes, and
leaving the file asks before discarding them.

Two kinds of file save but are not committed, and the toast says so: a `.env`, `.pem` or `.key`
(never committed, so a secret can't ride a milestone push to your GitHub repository) and anything
the repository's own `.gitignore` excludes. Those edits are on disk but not in history, so a later
turn may overwrite them without knowing.

**The Guide.** A chat with one job: explaining this codebase. Ask it what a file does, how a request
gets from the UI to the database, or why something is the way it is. It answers "why" from what the
project actually recorded — a decision-log entry, a PRD requirement number — and says so plainly
when nothing recorded a reason, rather than making one up. It can read anything and change nothing:
if something needs fixing, it says so and you either fix it yourself here or run a turn. Its replies
cite files as `` `path:line` `` — click one and it opens here, the same as a link in the Map.

**Map.** The second tab is `docs/code-map.md`: chapters from the entry points down, each item a
`` `path:line` `` link. Click one and the file opens at that line. The Manager refreshes the map
when a milestone lands; **Refresh map** does it on demand, which takes a model call or two.

**Tour.** **Start tour** on the Map walks the codebase one map link at a time, in the map's order.
Each step shows the code on the left — the whole file, read-only, with the step's lines tinted — and
the Guide's explanation on the right: what the lines do, a few at a time, and why they were done
that way, citing the decision-log entry or PRD requirement when one says, and *no recorded reason*
when none does. **Back** and **Next** move between steps (*Step 3 of 14*); **Open in editor** takes
you to the file in Files to change it; **Ask about this** opens the Guide with the lines already
named in its message box. The third tab, **Tour**, brings you back to the step you left.

A step's lines run from the linked line to the end of that block, judged by indentation and capped
at 60 lines. The first time anyone opens a step the Guide writes its explanation (a few seconds of
"reading this step…"); it is saved as a page under `docs/tour/` in the project and committed, so
every later reader gets it instantly. Edit those lines and the next visit explains them afresh.

**Browser.** **Code → Browser** is this project's slot of the browser pool (see *The browser pool*),
live: the screencast large, the node and slot (*mini · 1*), and who in the project holds it and since
when. **Take control** takes the slot over and **Release** gives it back — the same as on the
Machines tile; a slot you take from a project, here or on Machines, still counts as that project's,
so it stays on this page with *Held by you*. With no slot it says *No browser in use* — agents open
one when a task needs the web; there is no button to open one yourself, since the hub only resets a
slot into a project's own session for that project's agents. When every slot is busy and the project
is waiting, it says its place in line. While the project holds a slot, *Browser* in the switch
carries a small green dot.

## Chatting with the team

Click an employee or the Manager on the Overview (or **Chat** in the toolbar for the Manager). The
drawer shows their status, their sessions, and a chat that
is just for the two of you — separate from turns. Use it to ask what they did and why, or to
brief them ("for the next task, keep functions under 40 lines"). Standing instructions per
employee (**instructions**, up to 2000 characters, set when you add them) are appended to their
role prompt on every task.

**Add employee** (**⋯**, the **+** in the team, or Settings → Team) creates one with a name, avatar,
role, and instructions. Removing one (Settings → Team) does not delete their history. Your
**assistant** and the **Master** (every project's briefings, and *Daily briefing*) are under the
team on the Overview.

## Talking to JD in the hub

**JD** at the top of the sidebar is your assistant — the same JD as on Telegram — in the hub,
on a laptop or a phone. Type, or tap the mic to record a voice note (tap ↑ to send it, × to
throw it away); JD answers in text, and sometimes out loud with a small player in its bubble.
Buttons under JD's message work like Telegram's, and the chips over the field are JD's quick keys.
What you say here is in JD's memory, but it does not show up in the Telegram chat (a bot cannot
post as you); JD's briefings and check-ins arrive in both places.

To connect it, once, on the Spark:

1. Make a token: `openssl rand -hex 32`.
2. Put the same value in **both** env files as `JD_WEB_TOKEN=<token>` — `~/telegramManager/.env`
   (JD's) and `~/AgentHub/configs/hub.env` (the hub's; it is the file the hub's unit reads).
3. In the hub's `hub.env`, also: `JD_URL=http://127.0.0.1:8891`.
4. Restart both: JD, and the hub (`systemctl --user restart agenthub-hub`).

Until then the JD page shows those two lines and nothing else. Otherwise it tells you what is wrong:

- **Set a hub password first** — `JD_URL` is set but the hub has no `HUB_PASSWORD`; the door to JD
  stays shut on a hub anyone could reach.
- **The token doesn't match** — JD is running but refused the hub's token: the two `JD_WEB_TOKEN`s
  differ.
- **JD isn't answering** — JD is not running or is on another port. In the middle of a
  conversation this shows as "Not answering — retrying…" under JD's name, and it reconnects by
  itself.

Changing the token later is the same two edits and two restarts. Voice notes need the hub over
HTTPS (the public site); over plain HTTP on the tailnet the mic says so instead.

## Operating the hub (on the Spark)

Two systemd *user* units, installed from `deploy/spark/`:

| | |
|---|---|
| Hub | `agenthub-hub.service` — `systemctl --user status agenthub-hub` |
| Node daemon | `agenthub-node.service` |
| Logs | `journalctl --user -u agenthub-hub -f` (and `-u agenthub-node`) |
| Config | `~/AgentHub/configs/hub.env` — never committed |
| Data | `DATA_ROOT` (`~/agenthub-data`): `projects/<slug>/`, the hub database, memory, recordings |
| Update | `cd ~/AgentHub && git pull && npm run build:ui && systemctl --user restart agenthub-hub` |

**The terminal needs node-pty.** It ships prebuilt binaries for macOS and 64-bit Linux (the Spark
included), so a normal `npm ci` is all it takes. Anywhere else it compiles on install and needs
build tools — Xcode command line tools on a Mac (`xcode-select --install`), `build-essential` and
`python3` on Debian or Ubuntu. If `npm ci` fails on node-pty, that is what is missing; the hub does
not start without it.

**Restarting the hub cuts any running turn short.** Check the project toolbar for
`Running · m:ss` first, or expect a "cut short" briefing.

`hub.env` keys that matter:

| Key | What |
|---|---|
| `PORT`, `HUB_HOST` | Where the hub listens; `0.0.0.0` to reach it over Tailscale |
| `DATA_ROOT` | Everything the hub stores |
| `HUB_PASSWORD` | The login. `HUB_SESSION_SECRET` keeps you logged in across restarts |
| `DAEMON_TOKEN` | Shared secret every node daemon presents |
| `FIREWORKS_API_KEY` | Enables the `cloud-fireworks` node; `FIREWORKS_HARD_MODELS=1` unlocks the expensive tier |
| `MAX_TURNS_PER_DAY`, `AUTO_TURNS` | The hub-wide cap (default 24) and the scheduler kill switch (`0`) |
| `TURN_TIMEOUT_MINUTES` | How long a turn may run before it is cut short (default 45) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | The hub's own Telegram alerts (optional; JD is separate) |
| `GITHUB_APP_*` | The GitHub App behind **Connect GitHub** (below); `GITHUB_TOKEN` is the fallback |

**Registering the GitHub App (once).** This is what turns "Connect GitHub" on for everybody who
uses the hub. At **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Callback URL** `https://<your hub>/api/github/callback` — and the same URL as the **Setup URL**.
- Tick **Request user authorization (OAuth) during installation**, **Redirect on update** and
  **Expire user authorization tokens**.
- **Repository permissions**: Contents *Read and write*, Pull requests *Read and write*, Metadata
  *Read-only*. No webhook is needed.
- **Where can this app be installed**: any account, so members can connect their own.
- Generate a private key; a `.pem` downloads. Keep it beside `hub.env`, readable only by the hub's
  user (`chmod 600`).

Then five keys in `hub.env`, and a restart:

| Key | Where it comes from |
|---|---|
| `GITHUB_APP_ID` | the App's *App ID* |
| `GITHUB_APP_CLIENT_ID` | the App's *Client ID* (`Iv…`) |
| `GITHUB_APP_CLIENT_SECRET` | *Generate a client secret* on the App's page |
| `GITHUB_APP_SLUG` | the App's URL name — the last part of `github.com/apps/<slug>` |
| `GITHUB_APP_PRIVATE_KEY` | the **path** to the `.pem`, not its contents |

All five or none: with four of them the hub logs which one is missing and leaves Connect GitHub
off. It reads the `.pem` at startup, so an unreadable key is one clear line in the log rather than
a failure hours later. Nothing about the App is ever logged, and no token it mints reaches the
browser.

Backups: `DATA_ROOT` is the whole state. Every project folder is a git repo, so `git log` inside
`projects/<slug>` is the full history of that project.

When the Spark (and so the hub) is off, `rosenroot.com` does not answer with a bare 502: the
droplet's Caddy serves an offline page instead, with status 503 so monitors still see it as down.
The page polls the hub itself and reloads on its own once it is back.

The droplet also runs its own watchdog, independent of JD (which lives on the Spark and so is
silent for exactly the outage you'd want to hear about): every minute it checks the hub and sends
a Telegram message on the down/up transition only. Setup is `deploy/do/README.md` §8.

## Developing (the simulation)

To see or change the UI without the Spark, a login or any keys, run a whole AgentHub locally from
any checkout or worktree:

```sh
npm run sim       # hub on http://127.0.0.1:4100 (serves packages/ui/dist if it is built)
npm run sim:ui    # the same, plus the Vite dev server on http://localhost:5180 — open this one
```

The password is **`sim`**. The hub runs with auth on, scheduled turns off and no cloud tier; every
model is a scripted mock that answers as the manager, the employees, the PRD and roadmap leads and
the chats, with a small delay per token so a turn visibly streams. *Run turn* on `pomodoro-cli`
delegates the next milestone to Ada, runs the real tests, has Vex review it, and publishes a
briefing — and the mock is priced like Fireworks GLM, so costs show in dollars.

What is seeded, so every empty, partial and full state is on screen:

- **pomodoro-cli** — full PRD, 9 milestones with m1–m3 done and verified, two past turns with
  briefings and costs, five docs pages and a code map, a workspace (Code and Terminal have files),
  and a preview (a tiny static dashboard; press Start in Preview).
- **habit-tracker** — PRD drafted and roadmap generated, nothing built.
- **scratch** — just created; the PRD is the scaffold.
- **Nodes** — `sim-spark` online, serving the mock; `sim-pc` goes offline about 15 s after start.

Flags: `--port` (4100), `--ui-port` (5180), `--data <dir>` to keep the data between runs (seeded
only when empty), `--reset` to wipe it, `--token-delay <ms>` (30). Without `--data` the data lives
in a temp directory that is removed on exit. Ctrl-C stops everything. In the Browser pane, the
`sim` and `sim-ui` entries in `.claude/launch.json` start the same two commands.

## Troubleshooting

| You see | It means | Do |
|---|---|---|
| *Waiting for the hub…* with a grey dot | The browser can't reach the hub | Is the hub running? `systemctl --user status agenthub-hub`; are you on the tailnet? |
| The login box | Session expired or a new browser | `grep HUB_PASSWORD ~/AgentHub/configs/hub.env` on the Spark |
| `listen EADDRINUSE :4000` in the log | Something else holds the port (a hub started by hand) | `ss -ltnp \| grep :4000`, kill it; systemd restarts the service |
| Node shows *offline* | Its daemon stopped heartbeating | On that machine: `systemctl --user status agenthub-node`, `journalctl --user -u agenthub-node -n 50` |
| Turn fails with `endpoint error 400 … Priority scheduling is not enabled` | vLLM lacks `--scheduling-policy priority` | Harmless: the hub drops the field and retries; to fix for real, set `EXTRA_VLLM_ARGS` in the recipe's `.env` and restart `sparkmodel` |
| `endpoint error 401/412` from Fireworks | Bad key / spending limit reached | Fix the key or the limit at app.fireworks.ai; local turns keep working |
| Run turn refused, "cap … reached" | Daily budget spent | Wait for the window, or raise `MAX_TURNS_PER_DAY` and restart |
| Briefing: "cut short" | Hub restarted or 45-minute (`TURN_TIMEOUT_MINUTES`) limit | Run the turn again; it resumes from the last briefing |
| Briefing: "hit its tool-call budget" | The milestone was too big for one turn | Split it in the Roadmap, or run again |
| Schedule suspended | Three consecutive errors | Find the error in Activity, fix it, switch *Run on its own* back on |

## Where things live

```
DATA_ROOT/
  hub.db                    the hub's database (nodes, jobs, transcripts, sessions)
  projects/<slug>/          one git repo per project
    manifest.yaml           title, status, order, model policy, auto-run, verifyCmd
    prd.md  roadmap.yaml    the plan
    project.md  tasks.yaml  the manager's board
    team.yaml               employees
    decisions.log.md        the why
    docs/                   the team's pages (code-map.md is the Code screen's Map tab)
    media/                  rendered images and clips, each with a .json of how it was made
    briefings/              one per turn
    workspace/              the code — its own git repo when the team inits one
  memory/                   the built-in assistant's notes
```

## Glossary

- **Turn** — one manager sitting; usually one milestone.
- **Briefing** — the manager's report at the end of a turn.
- **Tier** — a model's job: orchestrator or worker.
- **Attach mode** — a node config entry without a `cmd`: the daemon registers a server it did not start.
- **Priority** — a project's queue class (`Runs first` / `Normal` / `When idle`).
- **Lease** — an agent's temporary hold on one slot of the browser pool.
- **Verification** — tests plus a read-only review before a milestone counts as done.

## Costs

Every model request the hub serves is priced and recorded — the manager's turns, each employee's
subagent run, the one-on-one chats, the PRD and roadmap drafts, and the owner's own assistant.

**What is counted.** Prompt tokens, the cached part of them, and completion tokens, per request,
with the node and model that served it. Cost is
`(prompt − cached) × input + cached × cachedInput + completion × output`, at the per-million prices
below. **Local serving is $0** — hardware you already paid for bills nothing per token, and its
tokens are still recorded so you can see where the work went. Anthropic requests record their
tokens with **no dollar figure**: the hub has no Anthropic price table, and it will not guess one.

**Prices** (Fireworks, Standard serverless, USD per million tokens, as of **2026-09-23**):

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| `glm-5p3-flash` | $0.15 | $0.03 | $0.50 |
| `deepseek-v4p1-flash` | $0.22 | $0.007 | $0.66 |
| `glm-5p3` | $1.40 | $0.26 | $4.40 |
| `kimi-k3` | $3.00 | $0.30 | $15.00 |

A price that moves is a code change in `packages/hub/src/providers/fireworks.ts`, not a setting. A
model the hub has no price for shows as **price unknown** rather than as free.

**Where it shows.**

- **Model picker** — each model's input and output price, or "price unknown".
- **Overview** — what this project has cost in the last 24 hours, under *In this project*; the
  settings sheet repeats it under the schedule.
- **Activity** — each turn row carries what that turn cost, when it cost anything.
- **Employee drawer** — the Now line says what that employee's own model calls cost in the turn.
- **Machines → Nodes** — `Cloud spend: $1.20 in the last 24 h`, with the cap beside it when one is set.

**The daily cap.** Set `MAX_CLOUD_USD_PER_DAY` (in `hub.env`; decimals allowed, unset means no
cap). Once the trailing 24 hours of cloud spend reaches it, **cloud endpoints go out of rotation**
and local serving carries on as normal; a project that can only run in the cloud fails its turn
with *cloud spend cap reached*. Nothing is reset by hand — the cap lifts itself as the 24-hour
window slides past the spend. The crossing is logged once and, with the Telegram bot configured,
sent to you once.

One gap worth knowing: a call that never finishes — a turn you stopped, a turn that hit its time
limit, a dropped connection — is billed by the provider but recorded by nobody, because the token
counts only arrive with the last chunk. The hub will not guess them, so the figures here can be a
little under what the provider charges.
