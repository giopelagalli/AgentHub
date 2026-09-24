# 0041 — A real pty behind the Terminal button, owner-only, over the hub's own socket
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
FR-B2 wants a *Terminal* button that opens a shell in a project's `workspace/`. The hub already
runs commands for agents (`run_shell`, the verify command), so the cheap-looking move is to reuse
that path and put a command box on screen. But a terminal that cannot run `vim`, `top`, `git
rebase -i` or anything that asks a question is not the thing the owner reached for; decision 0021
had already settled that this goes through the hub rather than a raw port.

## Options
- A — a command box over the existing `runShellTask`: no job control, no curses, no interactivity,
  and every command starts in a fresh process. It is a worse `run_shell`, not a terminal; why not.
- B — SSH in the browser (wetty, ttyd) behind the hub's proxy: a second daemon, its own auth, its
  own port, and the hub's login no longer the only door; why not.
- C (chosen) — node-pty on the hub, xterm.js in the sheet, the two joined by a WebSocket on the
  hub's own origin (`GET /api/projects/:slug/terminal`) under the session cookie.

## Decision
C. Two dependencies: `node-pty` on the server (native; prebuilt binaries for macOS and Linux,
otherwise a compiler) and `@xterm/xterm` + `@xterm/addon-fit` in the browser. The route is `owner`
under `routeAccess` — the shared daemon bearer and per-node tokens are a plain 401 there, because a
leaked node token must never become a shell on the control node. The shell is spawned with
`secretsStripped(process.env)`, the same environment agent-run commands get, so the terminal is not
a way to read the hub's own credentials. Bytes travel as binary frames both ways; the only text
frames are `{type:'resize'}` up and a short notice down. One socket is one shell, killed by process
group on close, four sessions per hub, 60 minutes idle. Sessions are logged as a slug and a
duration, never a transcript.

## Consequences
The hub now holds an interactive shell as the OS user it runs as: everything that user can do, a
browser tab can do, which is why it is owner-only until Phase F scopes it per member and per owned
node (PRD Security). It is registered only on a hub that has a password: `owner` means nothing
where there is no credential to hold. The hub's process is no longer purely request-shaped — it has
children that outlive a request — so `app.close()` has to kill them, and it does, outright. A second
native dependency joins `better-sqlite3` in the install story.

**xterm is loaded eagerly, and that is temporary.** `views/terminal.ts` imports xterm at the top of
the module, so it lands in the main chunk: the UI bundle goes from 123.50 kB to 460.53 kB (gzip
43.95 → 129.90), a 3.7× cost paid on every page load for a button most sessions never press. It is
this way because it is the smallest thing that works, and it stays this way no longer than the
next round: the follow-up is a dynamic `import()` inside `mountTerminal`, which Vite emits as its
own chunk, plus the load-race handling a lazy mount needs (a dispose that lands before the import
resolves). ROADMAP carries it under *Next*. Preview and Code will want the same treatment, so the
lazy-mount shape should be settled once and shared rather than invented three times.
