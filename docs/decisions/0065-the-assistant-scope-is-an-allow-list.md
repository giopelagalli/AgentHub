# 0065 — The assistant scope: an allow-list of `/api` routes for assistant tokens
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
JD (FR-C1–C3) has to create projects, run turns and read briefings, which are `/api/*` routes
guarded `owner` (session cookie only). JD holds a door token (0034/0035), which only opens `/v1/*`.
The question is how much of `/api` that token may reach, and how it is checked.

## Options
- A — give JD the owner password or a long-lived session cookie. Everything opens, and a leaked
  JD config is a full owner compromise.
- B — let any user API token reach every `/api/*` route not on a deny-list. A route added later is
  open by default, and `agent` tokens (pi runs, 0050) could start turns.
- C (chosen) — a new guarded access class, `assistant`, for an explicit `<METHOD> <route>`
  allow-list in `auth.ts` (`ASSISTANT_ROUTES`), checked by the same hub-wide `onRequest` hook.

## Decision
C. The list is exactly: `GET /api/state`, `GET /api/briefings`, `GET /api/projects`,
`GET /api/projects/:slug/turns`, `POST /api/projects`, `POST /api/projects/:slug/prd/draft`,
`POST /api/projects/:slug/roadmap/generate`, `POST /api/projects/:slug/turn`,
`POST /api/projects/:slug/pause|resume`, `POST /api/projects/:slug/priority`. On those routes the
owner's session still works (checked first, CSRF guard unchanged); otherwise a bearer is verified:
an `assistant` token passes, an `agent` token gets 403, a bad one 401 and then 429.

The bearer check moves out of the door plugin into `TokenGate` (`door.ts`) — the token store plus
one lockout counter — which both `/v1` and the hook use, so a guesser cannot double its tries by
alternating between the two. Only an `Authorization: Bearer …` header is a token attempt: no header
(the owner's UI with a lapsed session) or another scheme (the edge's basic auth, which rides every
same-origin request) is a plain 401 and is not counted, or it would lock JD out of the owner's own
address. `POST /api/projects` with a `source` (a GitHub import, cloned with the hub's credentials)
is 403 for a token: importing stays the owner's. A cookie-less bearer request never reaches the CSRF guard, as before.

## Consequences
Every new route is the owner's until someone adds it to the list on purpose. The list is the whole
of what a stolen JD token can do: create and steer projects — never tokens, nodes, enrollment,
GitHub, terminals, previews, code writes, media or the browser. A hub run without `auth` (dev mode)
has no hook at all, so bearers are ignored there and nothing is attributed.
