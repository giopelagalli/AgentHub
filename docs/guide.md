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
   - **Pause / Resume**, **Run turn** (shows `Running · m:ss` while one runs), **Add employee**.
2. **Four big buttons.** PRD, Roadmap, Docs, Activity. Each opens a full-screen sheet
   (`Esc` closes it). The PRD, Roadmap and Docs sheets have a chat docked on the side: talk to
   the document's editor ("move milestone 4 before 2", "add a section on backups") and it
   changes the document in place.
3. **The org chart.** You → Assistant / Master → the project's Manager → its employees. Click any
   card to open that person: what they are doing, their history, and a chat.

## Starting a project

**New project** asks for a name and a slug, then one of two things:

- **Start from an idea** — a paragraph. The PRD drafter (orchestrator tier) writes a full PRD
  from it, streaming, in about two minutes on the Spark.
- **Paste a PRD** — your own document. It is filed as-is and scored.

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
20 minutes. Expect one milestone per turn; a big milestone can take two.

**Activity** is the live feed of all of this: who is acting, each tool call folded with its
result and timing, employees' work nested under their task, the verification result, the
briefing. Reloading mid-turn recovers the feed. Rows in red are errors.

When a turn's summary says it **was cut short**, the hub stopped (a restart) or the 20-minute
limit hit — the model did not fail. **Hit its tool-call budget** means the manager ran out of
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

## Nodes

**Cluster** lists nodes with status, the model per tier, active streams, and the job queue.

The Spark is configured in `configs/spark.yaml` in *attach mode*: the daemon does not start a
model server, it attaches to the vLLM that `sparkmodel.service` already runs on `:8888`, checks
it answers, and registers both tiers with `priority: 10` and small stream caps (2 orchestrator,
3 worker) because the KV cache is shared with JD.

Adding a node today: install Node 22, clone the repo, write a config from the examples in
`configs/` (`amd.yaml` for the 7900 XTX, `macbook.yaml`, `macmini.yaml` for the browser node),
set `DAEMON_TOKEN` to the hub's, run `npx tsx packages/node-daemon/src/main.ts <config>` under a
service. The per-machine playbooks are in `deploy/`. A one-command installer is still on the
roadmap (`docs/plan-agenthub-v2.md`, Phase D).

Cluster's **Drain** button stops new jobs, turns and browser leases from landing on a node while
whatever it's already running finishes, and **Undrain** reverses it. **Remove** forgets the node
outright — its daemon exits once the hub tells it so — so getting it back means re-running its
service or install.

A node is *offline* when its heartbeats stop; the hub requeues its jobs and routes around it.

## The shared browser (Computer)

One browser session lives on the browser node (the Mac mini). Agents *lease* it for a task and
release it; the **Computer** page shows who holds it, the queue, and lets you **Take control**
(you drive, agents wait) and **Release**. Recordings of agent sessions are kept under the data
root. Multiple simultaneous sessions are planned (Phase D).

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
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | The hub's own Telegram alerts (optional; JD is separate) |

Backups: `DATA_ROOT` is the whole state. Every project folder is a git repo, so `git log` inside
`projects/<slug>` is the full history of that project.

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
| Briefing: "cut short" | Hub restarted or 20-minute limit | Run the turn again; it resumes from the last briefing |
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
    docs/                   the team's pages
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
