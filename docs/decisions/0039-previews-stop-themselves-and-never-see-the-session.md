# 0039 — A preview idles out after 30 minutes, and never sees a credential
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
A preview is a dev server: a file watcher, a compiler and a few hundred megabytes of resident
memory, started by a click and forgotten.

## Options
- A — leave previews running until the owner stops them: the Spark ends up hosting every project's
  dev server forever; why not.
- B — stop a preview when the sheet closes: a closed sheet is not the same as done — the owner
  opens the app in a tab, or comes back in two minutes to a cold start; why not.
- C (chosen) — stop it after 30 minutes with no proxied traffic, HTTP or WebSocket.

## Decision
`PreviewSupervisor` stamps `lastSeenAt` on every proxied request and every upgrade; a sweep every
minute stops anything past the window and says so in the log tail, so the sheet explains itself.
The clock is injectable and the sweep is a method, so the rule is tested rather than waited on.

Separately, nothing that authenticates reaches the dev server: `cookie`, `authorization` and
`proxy-authorization` are deleted on the way in — belt and braces, since after 0040 the preview
origin has no hub cookie to send — and `set-cookie` with the hop-by-hop headers on the way back.
`Host` is set to loopback, the child is spawned with `secretsStripped()`, and it is killed by
process group.

## Consequences
A preview left open overnight is stopped, and the next request 503s until the owner presses Start —
the status pill and the log say which happened. A dev server that needs a cookie to authenticate
against something of its own cannot borrow the hub's.
