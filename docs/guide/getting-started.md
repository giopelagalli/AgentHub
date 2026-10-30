# Getting started

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
- **Docs** (*Pages · Media · How the code works*), **Code** (*Files · Terminal · Preview · Browser*) and
  **Activity** — each has its own page in this guide. The toolbar's chat button is the Manager, except on Code,
  where it is the Guide.

**Settings** (from **⋯**) is a sheet grouped like macOS Settings: **Models**, **Schedule**,
**Priority**, **Team** (add or remove employees) and **Pause**. Everything applies as you change it.

## Glossary

- **Turn** — one manager sitting; usually one milestone.
- **Briefing** — the manager's report at the end of a turn.
- **Tier** — a model's job: orchestrator or worker.
- **Attach mode** — a node config entry without a `cmd`: the daemon registers a server it did not start.
- **Priority** — a project's queue class (`Runs first` / `Normal` / `When idle`).
- **Lease** — an agent's temporary hold on one slot of the browser pool.
- **Verification** — tests plus a read-only review before a milestone counts as done.
