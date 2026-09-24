# 0028 — The GitHub token travels as a per-invocation header, behind a credentials interface
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
Importing a repository means the hub clones, pushes and calls GitHub's REST API on the owner's
behalf. A personal access token in `hub.env` is the credential today, but the next branch replaces
it with a GitHub App installation, which mints a short-lived token *per repository*. Two things had
to be decided at once: how a token reaches git without leaking, and what shape the lookup has so the
App slots in without a rewrite.

## Options
- A — token in the remote URL (`https://x-access-token:TOKEN@github.com/o/r.git`): git persists it
  into the clone's `.git/config`, which lives inside `workspace/` — a directory agents read and a
  reviewer subagent is pointed at. Why not: the secret ends up in the project's own files.
- B — `git -c http.extraHeader=...`: not persisted, but the token is an argv entry, and `/proc/<pid>/cmdline`
  is world-readable. Why not: any user on the box can read it while the clone runs.
- C — a `GIT_ASKPASS` helper script: works, but needs a temporary executable on disk and a second
  channel to hand it the token. Why not: more moving parts for the same result as D.
- D (chosen) — `http.extraHeader` set through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`
  in the child's environment. Per-invocation like `-c`, never written to any `.git/config`, and a
  process's environment is readable only by its own user.

For the lookup shape: a single `token` string on `Github` would have to be torn out for the App, so
the client takes a `GithubCredentials { method, tokenFor(owner, repo) }` instead. `PatCredentials`
is the only implementation today; an installation-backed one is a second class beside it, and
nothing below `tokenFor` knows the difference.

## Decision
`packages/hub/src/projects/github.ts` is the only module that sees a token. It builds git's
environment itself:

- Every inherited `GIT_*` variable is dropped (an inherited `GIT_DIR` would redirect the command),
  along with `EDITOR`/`VISUAL`/`PAGER`/`SSH_ASKPASS`, which name programs git would run.
- `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, so neither `/etc/gitconfig` nor
  `~/.gitconfig` can add an `insteadOf` rewrite, a proxy or a credential helper to a command that is
  carrying the token.
- `core.hooksPath=/dev/null`, plus `--no-verify` on commit and push: `.git/hooks` lives inside the
  workspace, which agents write, and a hook runs in this process's environment.
- `GIT_TERMINAL_PROMPT=0` so a repository we cannot see fails instead of waiting, and the committer
  identity by environment rather than written into the owner's clone.
- The token, when `tokenFor` returns one, as an `http.<cloneBase>/.extraHeader` config entry —
  scoped to the host, not a bare `http.extraHeader`, because the clone's `origin` URL is
  agent-writable and an unscoped header goes wherever the remote points. Pushes name the URL
  outright for the same reason (0030).

simple-git blocks three of these by default because they are how *someone else's* environment
configures git; `allowUnsafeConfigEnvCount`, `allowUnsafeConfigPaths` and `allowUnsafeHooksPath` are
enabled here because each one is used to take configuration *away*, after the inherited git
environment has been stripped.

`GET /api/github/status` answers `{ configured, method: 'token' | 'none' }` — never the token — so
the UI can add `'app'` without a new route.

## Correction (security review, 2026-09-24)
This record originally claimed the token was "in the hub process's environment and nowhere else".
That was wrong, and in the most important direction: `runShellTask` spawned every agent command with
`{ ...process.env }`, so `run_shell` and the milestone's own test command could read `GITHUB_TOKEN`
and push to the owner's default branch themselves. Being in the hub's environment is exactly what
made it reachable.

The fix is `secretsStripped()` in `@agenthub/shared/shell`: an allow-nothing list of the hub's
credentials (`GITHUB_TOKEN`, the model provider keys, `HUB_PASSWORD`, `HUB_SESSION_SECRET`,
`DAEMON_TOKEN`, `TELEGRAM_BOT_TOKEN`, the search keys, `GITHUB_APP_*`) removed from the environment
handed to `runShellTask`. Every path that runs a command on an agent's behalf passes it: `run_shell`
(`agents/tools.ts`), the verify command (`agents/verify.ts`) and the daemon's `shell-task` job
runner, which on a control node is started from the same environment as the hub.

## Consequences
The token is in the hub process's environment, and the hub is responsible for keeping it out of
every child it spawns — which is a standing obligation, not a property of this module. Anything that
adds a new way to run a command on an agent's behalf has to pass `secretsStripped()`; a test asserts
`run_shell` of `printenv GITHUB_TOKEN` comes back empty while the hub holds one.

It is not in argv, not in a file, not in the project bundle, and not on the wire to the UI. Two
further leaks are closed here rather than left implicit: simple-git logs each spawn — argv and the
environment it was given — through `debug`, so `packages/hub/src/debug-guard.ts` appends
`-simple-git,-simple-git:*` to `DEBUG` and `main.ts` imports it first (`debug` fixes a namespace's
enablement when the logger is created, so the order matters and is commented at both ends).

Swapping in a GitHub App is one new `GithubCredentials` implementation plus a new `method` value.
The cost is that this module cannot use the shared `simpleGit(dir)` helper the bundle uses — it
constructs its own client with the `unsafe` flags — and those opt-outs only stay honest while the
inherited git environment is stripped first. If that stripping ever goes, the flags become real
holes.
