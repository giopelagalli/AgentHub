# 0031 — The App works with installation tokens; the user token is used once and dropped
Date: 2026-09-24
Decided by: senior-coder

## Context
Connecting GitHub has to be seamless for a non-technical member: a button, GitHub's own "choose
repositories" screen, done (owner requirement, 2026-09-24). A registered GitHub App gives two kinds
of credential — a *user-to-server* token (the person acts, through the app) and an *installation*
token (the app acts, scoped to the repositories the person chose). The hub has to pick which one
its clones, pushes and pull requests run on, and what it keeps between visits.

## Options
- A — user-to-server tokens: they expire in 8 hours and need a refresh token stored per member, so
  the hub would hold a long-lived credential that can act as the person everywhere the app is
  installed. Why not: a stored secret with the broadest reach, refreshed forever, for work that
  happens hours after anyone is at the keyboard.
- B — a webhook-driven installation store: correct, and needs a public webhook endpoint, a shared
  secret and delivery handling before anything works at all. **Deferred** — it is how an
  uninstall on GitHub would reach the hub by itself, and is worth doing when there is more than one
  member.
- C (chosen) — installation tokens, minted per repository on demand from the app's own JWT. The
  user token is exchanged at the callback, used for exactly one call, and dropped.

## Decision
`GET /api/github/callback` exchanges the `code` for a user token, asks `GET /user/installations`
which installations that person has, stores the matching id, and never keeps the token.
`github_installations` holds the installation id, the member, and the account it sits on — no
credential, because an installation id names a grant the member made on GitHub and can revoke
there.

Everything afterwards runs on `AppCredentials`: an RS256 JWT signed from the `.pem` with Node's
`crypto` (no new dependency — this is the only JWT the hub makes, and it is three base64url
segments), traded at `POST /app/installations/{id}/access_tokens` for a token good for an hour and
cached until five minutes before GitHub expires it. The lookup is `tokenFor(owner, repo)`, the
interface 0028 put there for exactly this.

The ownership check is `GET /user/installations`, not a comparison of `account.login`. GitHub's own
docs warn that the `installation_id` on the callback can be spoofed and say to check the
installation against the user; the listing answers that in one call and *also* covers an
organisation the member can administer, which a login comparison would have refused.

## Consequences
The hub holds no GitHub credential that outlives a request: the longest-lived thing in the database
is an installation id. An installation removed on GitHub leaves a stale row until the next mint
fails (`tokenFor` returns null and the import says the repository cannot be read) or the member
presses Disconnect — the webhook that would tell us sooner is option B, still deferred. Repository
listings and installation tokens are cached in memory, so a hub restart re-mints; that is cheap and
keeps the cache out of the database.
