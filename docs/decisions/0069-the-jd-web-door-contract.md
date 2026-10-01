# 0069 — The JD web door: JD serves a small HTTP API, the hub proxies it
Date: 2026-10-01
Decided by: orchestrator
Status: accepted

## Context
FR-C4 (plan-jd-web-agenthub.md, Phase 2) puts JD in the hub's UI: chat with inline buttons and
voice notes, from a phone or laptop browser. JD lives in another repo (`telegramManager`) and
process on the Spark; the hub already has the login, the public edge and the UI. The two sides are
built in parallel, so the wire between them is fixed here first.

## Options
- A — the hub talks to Telegram's Bot API as the owner: impossible (a bot can't read its own
  chat as the user) and it would tie the web to Telegram.
- B — the browser talks to JD directly: JD would need its own login, TLS and public route.
- C — the hub embeds JD (import its Python logic): two runtimes in one process; no.
- D (chosen) — JD serves a tailnet-only HTTP API with a bearer token; the hub proxies
  `/api/jd/*` behind its owner login, and a **JD** page in the UI renders it.

## Decision
**JD's web API** (telegramManager), off unless `JD_WEB_TOKEN` is set; binds `JD_WEB_HOST`
(default `127.0.0.1`) : `JD_WEB_PORT` (default `8891`). Every request carries
`Authorization: Bearer <JD_WEB_TOKEN>`; a wrong or missing one is 401. Same router as Telegram
underneath — a web message is a message to JD, nothing forks.

A **message** on the wire:
```
{ id: string,                 // stable; an edit reuses the id it replaces
  from: 'owner' | 'jd',
  at: number,                 // ms epoch
  text: string,               // Telegram-HTML subset: b i u s code pre a[href] and \n; or plain
  format: 'html' | 'plain',
  buttons?: { label: string, data: string }[][],   // inline keyboard rows
  audio?: { id: string, mime: string },            // fetch with GET /audio/:id
  edit?: true }               // replaces the message with the same id
```

| Route | Body | Answer |
|---|---|---|
| `GET /health` | — | `{ ok: true, name }` (JD's display name) |
| `GET /history?limit=50` | — | `{ messages }`, oldest first, the web conversation |
| `POST /messages` | `{ text }` | `{ messages }` — the owner's message echoed, then JD's replies |
| `POST /callback` | `{ data }` | `{ messages }` — usually one `edit: true` |
| `POST /voice` | raw audio (`audio/webm`, `audio/mp4`, `audio/ogg`) | `{ transcript, messages }`; replies may carry `audio` |
| `GET /audio/:id` | — | the bytes, with a browser-playable `Content-Type` (mp3 or m4a preferred so Safari plays it) |
| `GET /keys` | — | `{ keys: string[] }` — JD's quick keys, sent as text when tapped |
| `WS /stream` | — | server pushes `{ type: 'message', message }` and `{ type: 'typing', on: boolean }` |

Proactive messages (briefings, project reports, check-ins) go to Telegram as today **and** to
every open `/stream`. A message sent on the web is answered on the web; it does not appear in the
Telegram chat (a bot cannot post as the owner), but it is in JD's conversation memory either way.
Bodies over 10 MB are 413. Long model work answers when done — the hub's proxy allows 120 s.

**The hub** (AgentHub): `JD_URL` (e.g. `http://127.0.0.1:8891`) and `JD_WEB_TOKEN` in its env.
`/api/jd/*` is **owner-only** (cookie + `sameOriginWrite`, never an API token, never in the
assistant allow-list) and forwards method, path, query, body and `Content-Type` to `JD_URL`, adding
the bearer and nothing else from the browser (no cookies forwarded). `/api/jd/stream` is a
websocket the hub bridges to JD's `/stream`. `/api/jd/status` answers locally:
`{ configured, reachable, name? }`. Unset → the JD page says how to connect JD and nothing else.

The token is generated on the Spark (`openssl rand -hex 32`) and put in both `.env`s by the owner;
it never passes through chat.

## Consequences
- JD gains an HTTP server (its first listener) — tailnet/loopback only; the hub is its only client.
- Two `.env`s share one secret; rotating it is two edits and two restarts.
- The web conversation and the Telegram chat are two views of one JD, not one transcript.
- FR-C5 (JD's model through the hub's door) is **not** part of this: JD keeps its own model path
  until the owner says otherwise (local model paused for AgentHub; JD's choice is separate).
