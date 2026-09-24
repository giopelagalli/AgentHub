# 0033 — Credentials are tried in order: the App, then the personal access token
Date: 2026-09-24
Decided by: senior-coder

## Context
A hub can now have two ways to reach GitHub at once: a registered App with installations a member
connected, and `GITHUB_TOKEN` in `hub.env`. `Github` takes one `GithubCredentials` (0028), so
something has to decide which — and what happens to a repository one of them cannot see.

## Options
- A — whichever is configured, App winning outright: simple, and a member who connected the App
  loses access to every repository the owner's token covers but their installation does not.
- B — per-project choice, stored on the manifest: more control than anyone has asked for, and a
  question at import time that a non-technical member cannot answer.
- C (chosen) — a chain: ask each in order, take the first that answers with a token.

## Decision
`ChainedCredentials` holds `[AppCredentials?, PatCredentials?]` and answers `tokenFor` with the
first non-null. Its `method` — what `GET /api/github/status` reports and what the UI switches the
Repository field on — is the *first* link's, because that is what the hub is set up with, not what
one repository happened to resolve through. A link that throws (GitHub unreachable while minting an
installation token) is passed over rather than fatal, so one broken credential cannot take out a
working one behind it.

The App is first because its token is the narrower one: minted per installation, scoped to the
repositories the member chose on GitHub, and dead in an hour.

## Consequences
"PAT fallback" is literal: a member with the App connected can still import a repository only the
owner's token reaches, and nothing has to be reconfigured for that to work. The cost is that a
failure is one step further from its cause — a repository neither credential covers reports "could
not read owner/repo", not which one was tried. The chain is two links and is not a plugin point;
a third credential kind would want its own record first.
