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

The **rail** on the left: Computer (the shared browser), Cluster (nodes and jobs), Allocation
(what runs first), Help, then **New project**, a search box, and the project list. Press `[` to
collapse or expand it. Arrow keys move between projects.

A **project page** has, top to bottom:

1. **Header.** Title, the status pill (`active` / `paused`), the model pill. Then the controls:
   - **Order** — `Runs first` / `Normal` / `When idle`. See *Order* below.
   - **Models** — which model this project uses. See *Models*.
   - **Auto-run** — off by default. Click to schedule turns. See *Auto-run*.
   - *hub N/24 turns left today* — the hub-wide daily budget.
   - **Chat** — one-on-one with the project's Manager (`c`). The same drawer the Manager card in
     the org chart opens, and it works while a turn is running.
   - **Pause / Resume**, **Run turn** (shows `Running · m:ss` while one runs), **Add employee**.
2. **The big buttons.** PRD, Roadmap, Docs, Activity, Code, Terminal, Preview. Each opens a
   full-screen sheet (`Esc` closes it). The PRD, Roadmap and Docs sheets have a chat docked on the side: talk to
   the document's editor ("move milestone 4 before 2", "add a section on backups") and it
   changes the document in place. Code docks the Guide the same way — see *Code* below.
3. **The org chart.** You → Assistant / Master → the project's Manager → its employees. Click any
   card to open that person: what they are doing, their history, and a chat.

## Starting a project

**New project** asks for a name and a slug, then one of three things:

- **Start from an idea** — a paragraph. The PRD drafter (orchestrator tier) writes a full PRD
  from it, streaming, in about two minutes on the Spark.
- **Paste a PRD** — your own document. It is filed as-is and scored.
- **Import a repo** — a repository you already have. See below.

The PRD has twelve fixed sections (overview, goals and non-goals, users, functional requirements,
UI, data, security, scalability, operations, acceptance criteria, risks and open questions,
glossary). The **score** on the PRD button is how many sections are actually filled; the manager
refuses to build on an empty scaffold, and auto-run skips such projects.

Then open **Roadmap → Generate roadmap**. The planner reads the PRD and proposes milestones in
build order with estimates. Reorder them with the arrows, change a status with its select, or
tell the roadmap chat what to change. `m1` is the first milestone; ids are positional.

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
planned milestone is the first new thing. The project header shows `owner/repo @ branch` under the
intent, linking to GitHub.

**Connect GitHub.** Public repositories clone without anything. For a private one — and for
pushing anything back — the hub needs to reach GitHub as you. If the hub has the AgentHub GitHub
App set up (the owner does that once; see *Operating the hub*), the Import a repo tab shows a
**Connect GitHub** button. Press it and you are on GitHub's own screen, signed in as yourself,
choosing **which repositories AgentHub may use** — all of them, or a list you pick. Approve, and
you land back on the hub with "GitHub connected".

There is no token to make and nothing to paste. After that, the Repository field is a **picker** of
the repositories you chose, newest first, with the branch shown; the text box stays beside it if
you would rather type `owner/repo`. The picker lists up to 500 repositories per connection — past
that, type the name instead; importing it still works.

**Changing your mind.** The repositories are yours to change at any time: **GitHub → Settings →
Applications → Installed GitHub Apps → AgentHub → Configure**, or the **Manage on GitHub** link on
the Cluster page. **Disconnect**, on that same line, makes the hub forget the connection; the app
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
to the repository line: it opens a pull request from `agenthub/<slug>` into the branch you
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
   committed under `briefings/` and shown on the Activity button.

Limits that shape a turn: the manager has 40 tool calls, an employee 25; a turn is cut off at
45 minutes (`TURN_TIMEOUT_MINUTES`). Expect one milestone per turn; a big milestone can take two.

**Activity** is the live feed of all of this: who is acting, each tool call folded with its
result and timing, employees' work nested under their task, the verification result, the
briefing. Reloading mid-turn recovers the feed. Rows in red are errors.

When a turn's summary says it **was cut short**, the hub stopped (a restart) or the 45-minute
(`TURN_TIMEOUT_MINUTES`) limit hit — the model did not fail. **Hit its tool-call budget** means the manager ran out of
calls before reporting; the next turn starts from the last briefing and the workspace digest, so
nothing is lost, but that milestone probably needs a tighter spec or a split.

**Pause** stops new turns (manual and scheduled); running ones finish. **Resume** re-enables.

## Auto-run

Off by default. Turn it on per project: **Run turns on a schedule — every 15m / 30m / 1h / 2h /
4h, at most N turns a day** (default 6). The hub also enforces:

- a hub-wide cap of **24 turns a day** across all projects (`MAX_TURNS_PER_DAY` in `hub.env`),
  shown as *hub N/24 turns left today*; a manual Run turn past the cap is refused with a reason;
- **no auto-run on a project whose PRD is still a scaffold**;
- **suspension after three consecutive same-class errors** (say the model server is down) with a
  Telegram alert if the bot is configured; resume by clicking Auto-run again;
- `AUTO_TURNS=0` in `hub.env` disables scheduling on the whole hub.

Why the caps: unattended turns on a paid model are the one way this system can spend money
while you sleep. The caps make the worst day boring.

## Order (what runs first)

The **Order** select on the project header (and the Allocation page) is the hub's queue class for
that project's work: `Runs first`, `Normal`, `When idle`. When two projects want the same node —
a model slot, the shared browser, a shell job — the higher class goes first; within a class it's
first come, first served. It is *not* how fast a single turn runs; with one project it changes
nothing.

Not to be confused with the model server's own request priority on the Spark: every AgentHub
request carries `priority: 10` and JD's carry none (0), so JD's messages are scheduled ahead of
agent traffic on the shared vLLM. That is a node setting (`configs/spark.yaml`), not a project one.

## Models

The **Models** select on each project:

- **Auto (local first)** — the default. Local nodes serve everything; if the tier's local nodes
  are all busy the request waits for a slot; if none is *available* (offline, erroring) the
  request goes to a configured cloud provider, and comes back to local as soon as it is up.
- **Local only** — never spend; if local is unavailable the turn fails and says so.
- **Any cloud** / **Fireworks (default models)** / **Fireworks: <model>** — cloud first, local
  as the fallback. Picking a concrete model sets it for both tiers; a **Worker model** select
  appears to change the employees' model separately.
- **(off)** entries — the expensive tier (`glm-5p3`, `kimi-k3`). Greyed out until
  `FIREWORKS_HARD_MODELS=1` is set in `hub.env` and the hub restarted; a project that had one
  saved falls back to the provider's default while the switch is off.

The Cluster page shows every node's tiers and live stream counts, so you can see where a turn is
actually running.

## Harnesses

A *harness* is the program that actually does an employee's task. The model decides what to do;
the harness is what reads files, edits them and runs commands.

- **Built-in loop** — the hub's own. Nothing to install, tools scoped to the project workspace,
  and the only runtime the manager and the milestone reviewer ever use. This is the default.
- **pi** — [pi.dev](https://pi.dev), an open-source coding agent. The hub runs it as a program in
  the project's workspace, pointed at the same model the employee would have used anyway, and
  shows its work in the Activity feed exactly like a built-in run: the same tool calls, the same
  report, the same "files written" line.

**Installing pi on the hub host.** The hub only offers a harness it can actually start, so pi has
to be on the hub machine's `PATH` — installing it in your laptop's terminal does nothing. On the
Spark:

```
npm install -g @mariozechner/pi-coding-agent
pi --version
```

Then restart nothing: the hub checks for it per request. (The installer will do this step for you
once harnesses are part of it; for now it is one command.)

**Choosing it.** Open an employee's drawer — click their card in the org chart — and use the
**Harness** select under Model. The field only appears when there is more than one harness to pick
from, and **Built-in loop (project default)** puts them back on whatever the project uses. Nothing
else changes: their model override, their standing instructions and their history all stay.

**What to know before you switch someone:**

- pi runs commands in the workspace with the hub's own permissions, and unlike the built-in tools
  it does not check the paths it is given — a task that asks it to touch something outside the
  project can. Give pi to employees doing ordinary workspace work, not to one following
  instructions from somewhere you don't control.
- The reviewer always runs on the built-in loop, whatever you set. It judges a milestone with
  read-only tools, and that guarantee is worth more than the choice.
- Spend on a pi run shows in the turn's cost line but not yet on the usage page.
- If pi isn't installed, or the model endpoint isn't one it can speak to, the employee quietly
  runs on the built-in loop instead and the job log says why — the work still gets done.

## Nodes

**Cluster** lists nodes with status, the model per tier, active streams, and the job queue.

The Spark is configured in `configs/spark.yaml` in *attach mode*: the daemon does not start a
model server, it attaches to the vLLM that `sparkmodel.service` already runs on `:8888`, checks
it answers, and registers both tiers with `priority: 10` and small stream caps (2 orchestrator,
3 worker) because the KV cache is shared with JD.

**Adding a node.** Press **Add node** above the table. The hub mints a one-time token — good for
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

Cluster's **Drain** button stops new jobs, turns and browser leases from landing on a node while
whatever it's already running finishes, and **Undrain** reverses it. **Remove** forgets the node
outright — its daemon exits once the hub tells it so — so getting it back means re-running its
service or install.

A node is *offline* when its heartbeats stop; the hub requeues its jobs and routes around it.

The one-command installer is `curl -fsSL <hub>/install.sh | sh -s -- --hub <hub> --token <token>`,
with the token minted by *Add node* on the Cluster page. It detects the machine, installs Node 22
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
spend cap, and one line per request in the same cost ledger the Cluster page shows.

**A token.** Cluster → **API tokens** → a label and a kind → **Create token**. The token
(`ah_…`) is shown once and never again; the hub keeps only a hash. Revoke it from the same table
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

Streaming and non-streaming both work, as do `tools` and `tool_calls`; ask for
`stream_options: {"include_usage": true}` and the last chunk carries the token counts. Fields the
hub has no use for (`temperature`, `max_tokens`, …) are accepted and ignored. Spend through the
door counts against `MAX_CLOUD_USD_PER_DAY` like everything else, and shows on the Cluster page's
cloud-spend line.

## Preview (seeing the app)

A **Preview** button sits with the PRD, Roadmap, Docs and Activity buttons on the project page. It
opens a sheet with the project's own app running inside it, plus **Start**, **Stop**, **Restart**,
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

## The shared browser (Computer)

One browser session lives on the browser node (the Mac mini). Agents *lease* it for a task and
release it; the **Computer** page shows who holds it, the queue, and lets you **Take control**
(you drive, agents wait) and **Release**. Recordings of agent sessions are kept under the data
root. Multiple simultaneous sessions are planned (Phase D).

## The terminal

The **Terminal** button on a project page opens a real shell in that project's `workspace/`, on the
machine the hub runs on. `Esc` closes the sheet; the button underneath reads *open* or *closed*.

- It is a proper terminal, not a command box: `vim`, `top`, an interactive rebase, tab completion
  and colours all work, because a pseudo-terminal is what is on the other end.
- **One sheet is one shell.** Close the sheet, or lose the connection, and the shell is killed —
  along with anything it started in the background. Reconnecting gives you a *new* shell, which the
  banner says; **New session** does the same on purpose.
- Four terminals at a time across the whole hub, and one that sits untouched for an hour closes
  itself. A tab that went away without saying so — a closed laptop, a dropped tunnel — is noticed
  within a minute and its shell ended, so it cannot sit on one of the four.
- When the hub says why a session ended (the hour, the shell exiting, all four in use), the sheet
  stops there and waits: **New session** is how you start another. Only an unexplained drop
  reconnects on its own, and a reconnect is always a new shell.
- The hub logs that a session happened — which project, how long — and never what you typed.

**No password, no terminal.** A hub started without `HUB_PASSWORD` has no terminal route at all —
the sheet opens and reports that it cannot connect — because owner-only means nothing on a hub
where there is no owner to be. A browser page on another site cannot open one either, even in a
browser you are logged in on: the hub checks where the request came from before it upgrades.

**It is your shell, with your reach.** It is scoped to the workspace only in the sense that it
*starts* there: everything the user running the hub can do, this can do. It is owner-only for that
reason — the daemon token and a node's own token are refused at the door — and it stays owner-only
until per-member access arrives, when a terminal will only ever open on a node you own. The one
thing it cannot see is the hub's own secrets: model keys, the session secret and the GitHub token
are stripped out of its environment, the same way they are for anything an agent runs.

## Code

The **Code** button opens the project's workspace: the file tree on the left, the file you picked
in the middle, and the **Guide** docked on the right. The button's line says how many files the
workspace has and how long ago the map was refreshed.

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

## Chatting with the team

Click an employee or the Manager. The drawer shows their status, their sessions, and a chat that
is just for the two of you — separate from turns. Use it to ask what they did and why, or to
brief them ("for the next task, keep functions under 40 lines"). Standing instructions per
employee live in their card (**instructions**, up to 2000 characters) and are appended to their
role prompt on every task.

**Add employee** creates one with a name, avatar, role, and instructions. Removing one does not
delete their history.

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

**Restarting the hub cuts any running turn short.** Check the project header for
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
| Auto-run suspended | Three consecutive errors | Find the error in Activity, fix it, click Auto-run to re-enable |

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
    briefings/              one per turn
    workspace/              the code — its own git repo when the team inits one
  memory/                   the built-in assistant's notes
```

## Glossary

- **Turn** — one manager sitting; usually one milestone.
- **Briefing** — the manager's report at the end of a turn.
- **Tier** — a model's job: orchestrator or worker.
- **Attach mode** — a node config entry without a `cmd`: the daemon registers a server it did not start.
- **Order** — a project's queue class (`Runs first` / `Normal` / `When idle`).
- **Lease** — an agent's temporary hold on the shared browser.
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
- **Project header** — a chip with what this project has cost in the last 24 hours, beside the
  turns left; `—` when it has cost nothing.
- **Activity** — each turn row carries what that turn cost, when it cost anything.
- **Employee drawer** — the Now line says what that employee's own model calls cost in the turn.
- **Cluster** — `Cloud spend: $1.20 in the last 24 h`, with the cap beside it when one is set.

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
