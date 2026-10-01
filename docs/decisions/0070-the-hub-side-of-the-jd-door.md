# 0070 — The hub's half of the JD door: named routes, raw bytes, ranges served by the hub
Date: 2026-10-01
Decided by: designer
Status: accepted

## Context
0069 fixes the wire between the hub and JD and says the hub "forwards method, path, query, body and
`Content-Type`". Building it left four choices open: which paths to forward, how bodies cross,
what the browser sees when JD refuses the hub's token, and how Safari gets to play JD's voice
notes (it will not play an `<audio>` whose server cannot answer a byte range).

## Options
- A — a wildcard `/api/jd/*` forwarder: least code, but the hub becomes a general proxy into
  whatever JD later serves, owner-only or not by accident.
- B — parse JSON and re-serialise it: loses the "bytes as they came" property and needs a second
  path for `/voice` anyway.
- C — pass JD's 401 through: the UI's `request()` reads any 401 as "the session expired" and
  reloads, so a wrong `JD_WEB_TOKEN` would loop the page.
- D — forward `Range` to JD: works only if JD implements ranges, which 0069 does not ask of it.
- E (chosen) — each 0069 route registered by name (`health`, `history`, `keys`, `messages`,
  `callback`, `voice`, `audio/:id`, `stream`); one catch-all buffer parser in the plugin's scope
  so every body is forwarded byte for byte (10 MB cap → 413); JD's 401/403 answered 502 with a
  "check `JD_WEB_TOKEN`" message; `/audio/:id` fetches the whole file and answers `Range` itself
  (206/416, `Accept-Ranges`, a day's private cache — an audio id never changes).

## Decision
E. Also: the door opens only on a hub with a password, as the terminal does (0041) — it speaks to
JD as the owner, and an open hub has no owner; `/api/jd/status` answers either way so the page can
say what is missing. Status carries a `reason` when JD cannot be talked to — `no-password`
(`JD_URL` set, no `HUB_PASSWORD`), `token` (JD answered 401/403 to the hub's bearer) or
`unreachable` — and the page shows the matching sentence instead of the setup screen or an endless
"Reconnecting…"; the stream's close reason (`JD refused the hub’s token`, `JD is not reachable`,
`JD is not configured`) drives the same choice mid-conversation.

Hardening from review: every door answer carries `X-Content-Type-Options: nosniff`, and
`/audio/:id` passes only an `audio/*` type (anything else goes as `application/octet-stream`) — JD's
bytes are served on the hub's origin, where the owner's session can open a shell, so none of them
may be sniffed or labelled into a page. In-flight requests to JD share one `AbortController`
aborted in `preClose` (with the timeout, via `AbortSignal.any`), so a hung JD never holds the hub's
shutdown for 120 s. The stream's upgrade checks `Origin` itself, like the terminal's, and a
refused upgrade on `/api/jd/stream` (or `/api/jd/*` when unconfigured) is hung up by hand in the
auth hook. `JD_WEB_TOKEN` joins `HUB_SECRET_ENV`, so no agent shell ever sees it.

Dependencies: `ws` moves from the hub's dev to runtime dependencies (the bridge's client to JD
uses it; it was already installed through `@fastify/websocket`). `packages/mocks` declares
`@fastify/websocket` for the mock JD's `/stream`. No new package enters the tree; the lockfile
changes only in those two workspace entries.

## Consequences
- A route JD adds later is not reachable from the browser until it is named in `jd.ts`.
- Each range request re-fetches the clip from JD; fine for voice notes, wrong for anything large.
- JD's own 4xx/5xx other than 401/403 reach the browser unchanged, with JD's `error` text.
