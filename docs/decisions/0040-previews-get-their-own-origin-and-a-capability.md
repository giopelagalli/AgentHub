# 0040 — Previews are served from their own origin, behind a capability
Date: 2026-09-24
Decided by: senior-coder (after review)
Status: accepted

## Context
The first cut of FR-B1 served previews at `/preview/<slug>/` on the hub's own port, behind the
owner session. Review found that fundamental: a preview document *is* project code — written by
the agents, or cloned in from an imported repository — and on the hub's origin it can `fetch('/api/…')`
with the session cookie and act as the owner. The iframe's `sandbox` attribute does not stop that,
because `allow-same-origin` on a document already from that origin is not a boundary; and "Open in
tab" has no sandbox at all. Serving somebody else's code and the owner's API from one origin is the
mistake, not the way it is framed.

## Options
- A — keep the hub's origin and rely on `sandbox`: sandbox is not an origin boundary, it can be
  dropped by opening the preview in a tab, and it would have to be right forever. Why not.
- B — a separate hostname per hub (`preview.<domain>`): a real origin, and the right answer behind
  the public site — but it needs DNS and a certificate, which a hub on a tailnet or a laptop does
  not have. Not enough on its own.
- C (chosen) — a second listener on its own port, which is a separate origin everywhere, plus
  (option B) a separate hostname in front of it for the public site.

## Decision
The hub runs a **second HTTP listener** that serves previews and nothing else: no `/api`, no UI, no
session. `PREVIEW_PORT` sets it, defaulting to the hub's port plus ten (4000 → 4010);
`PREVIEW_PUBLIC_BASE` is the origin the UI links to when something else terminates TLS in front of
it. `/preview/*` is gone from the hub's port and from `routeAccess`.

A port with no session cannot tell the owner from anyone else who can reach it, so access is a
**per-project capability** in the path: `/p/<slug>/<cap>/…`, 32 hex minted when the preview is saved
and stored with its config. It is compared in constant time, an unknown one is a 404 exactly like a
nonexistent project, and `POST /api/projects/:slug/preview/rotate` ("Reset link" in the sheet) mints
a new one — which changes the base path, so the preview stops and restarts under the new one.
`GET …/preview` answers with the absolute URL, which is what the iframe and "Open in tab" use.

A different port is still the same **site**, and the session cookie is `SameSite=Lax`, so it would
still ride along on a top-level POST from a page served there. The hub's auth hook therefore refuses
any cookie-authenticated write whose `Sec-Fetch-Site` is not `same-origin`, or whose `Origin` is not
the hub's own. Bearer-carrying requests are exempt (nothing attaches a bearer by itself), and login
is unauthenticated so it is unaffected.

The public site (0025) gets a second Caddy site — `preview.<domain>` → `spark:4010`, no basic auth,
and an `A` record — described in `deploy/do/README.md` §8.

## Consequences
Two ports to open on the hub's machine instead of one, two Caddy sites instead of one, and a URL
with a secret in it that anyone holding can open the app (the reset button is why). In exchange
project code runs where it cannot see or use the owner's session, and the guarantee is the browser's
own same-origin policy rather than an attribute we have to keep getting right.
