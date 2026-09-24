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
environment itself: every inherited `GIT_*` variable is dropped (an inherited `GIT_DIR` would
redirect the command; `EDITOR`/`GIT_ASKPASS`/`PAGER` name programs git would run), `GIT_TERMINAL_PROMPT=0`
so a repository we cannot see fails instead of waiting, the committer identity is set by environment
rather than written into the owner's clone, and the token — when `tokenFor` returns one — becomes a
single `http.extraHeader` config entry. simple-git blocks `GIT_CONFIG_COUNT` by default because an
*inherited* one lets someone else configure git; `allowUnsafeConfigEnvCount` is enabled here because
the inherited environment is stripped first and this is the only config git sees.

`GET /api/github/status` answers `{ configured, method: 'token' | 'none' }` — never the token — so
the UI can add `'app'` without a new route.

## Consequences
The token is in the hub process's environment and nowhere else: not in argv, not in a file, not in
the project bundle, not on the wire to the UI. Swapping in a GitHub App is one new
`GithubCredentials` implementation plus a new `method` value. The cost is that this module cannot
use the shared `simpleGit(dir)` helper the bundle uses — it constructs its own client with the
`unsafe` flag — and the `allowUnsafeConfigEnvCount` opt-out has to stay correct: if anything ever
stops stripping the inherited `GIT_*` variables, that flag becomes a real hole.
