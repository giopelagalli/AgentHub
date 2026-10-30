# Harnesses

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
