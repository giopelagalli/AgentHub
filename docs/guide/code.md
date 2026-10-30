# Code

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

**Code → Files** is the project's workspace: the file tree on the left and the file you picked
beside it — nothing else. The toolbar's chat button (or `c`) is the **Guide** on the Code tab: it
docks on the right and the button stays lit while it is open; on every other tab the same button is
the Manager. *In this project* on the Overview says how many files the workspace has and how long ago
the map was refreshed. The map and its tour are not here: they are in **Docs → How the code works**
(below).

**Files.** Click a folder to fold it open or shut, a file to read it. Arrow keys walk the tree and
Enter opens what is selected. Binary files and anything over 2 MB are listed but say *not text* —
they are there so you know they exist, not to be opened. Dependencies, build output and `.git` are
never listed at all.

**Editing.** The file is editable as it stands. Until you open one the editor is a single line,
*Choose a file to open it*; once one is open its path sits above it, and **Save** appears beside it
only while there are unsaved changes. **Save** (or `Cmd`/`Ctrl`-`S`) writes it and commits
it as `Owner edit: <path>` — to the project's own repository if it was imported from GitHub, to the
bundle otherwise. That commit is the point: the next turn reads the workspace, so an edit nobody
recorded is an edit the agents overwrite. A dot beside the filename means unsaved changes, and
leaving the file — for another file, another part of Code or another tab — asks before discarding
them.

Two kinds of file save but are not committed, and the toast says so: a `.env`, `.pem` or `.key`
(never committed, so a secret can't ride a milestone push to your GitHub repository) and anything
the repository's own `.gitignore` excludes. Those edits are on disk but not in history, so a later
turn may overwrite them without knowing.

**The Guide.** A chat with one job: explaining this codebase. Ask it what a file does, how a request
gets from the UI to the database, or why something is the way it is. It answers "why" from what the
project actually recorded — a decision-log entry, a PRD requirement number — and says so plainly
when nothing recorded a reason, rather than making one up. It can read anything and change nothing:
if something needs fixing, it says so and you either fix it yourself here or run a turn. Its replies
cite files as `` `path:line` `` — click one and it opens in Files, the same as a link in the Map,
with the Guide still open beside it.

### How the code works (Docs)

**Docs → How the code works** is for *understanding* the code rather than editing it: the Map, then
the Tour. Any file link in either opens the file in **Code → Files** at that line.

**Map.** `docs/code-map.md`: chapters from the entry points down, each item a `` `path:line` ``
link. The Manager refreshes the map when a milestone lands; **Refresh map** does it on demand, which
takes a model call or two. The map lives only here — it is not repeated in the Pages list.

**Tour.** **Start tour** beside the Map walks the codebase one map link at a time, in the map's order.
Each step shows the code on the left — the whole file, read-only, with the step's lines tinted — and
the Guide's explanation on the right: what the lines do, a few at a time, and why they were done
that way, citing the decision-log entry or PRD requirement when one says, and *no recorded reason*
when none does. **Back** and **Next** move between steps (*Step 3 of 14*); **Open in editor** takes
you to the file in Files to change it; **Ask about this** opens the Guide with the lines already
named in its message box. **Back to the map** returns to the Map, whose button then reads **Resume
tour** and brings you back to the step you left. Leaving for the editor (**Open in editor**, or any
file link) and coming back to Docs → How the code works finds the tour on the same step.

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
