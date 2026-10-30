# Projects

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
