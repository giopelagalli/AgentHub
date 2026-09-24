# 0031 — The OpenAI-compatible door is its own plugin, opened by hashed user API tokens
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
PRD FR-D6 wants any OpenAI client — JD, pi, curl — to reach the hub's nodes with the caller's
identity, priority and grants. The hub's existing credentials are the owner's session cookie and
per-node daemon bearers; neither fits a long-lived machine client the owner hands out and revokes.

## Options
- A — reuse `DAEMON_TOKEN` for the door: one shared secret for every client, no identity to
  attribute usage or priority to, and no revoking one client; why not.
- B — issue the door a session cookie via `/api/login`: makes every API client hold the owner's
  password and inherit the whole owner surface; why not.
- C (chosen) — an `api_tokens` table storing only sha256, minted from `POST /api/tokens` with a
  label and a kind, plaintext shown once (`ah_` + 48 hex); `routeAccess` gains a `door` kind for
  `/v1/*` and the plugin that owns those routes checks the bearer itself.

## Decision
`packages/hub/src/door.ts` holds both halves — the tokens and the `/v1` routes — and is registered
in `server.ts` with one line. `routeAccess` classifies `/v1/*` as `door` rather than `none`, so the
routes are still explicitly guarded, just not by the shared hook: only the plugin knows which token
a request speaks for, and it needs that answer for priority and for the ledger anyway. Bad bearers
get `LoginThrottle` per IP, on its own counter, like enrollment. Every door request records a usage
row with `kind: 'door'`, `subject: 'door:<label>'`, `member_id: null`, so the cost chip and the
daily cloud cap see an outside client exactly as they see a project turn. `user` is `admin` today;
the column is there for Phase F.

## Consequences
The door is the first route family outside `/api/` that is guarded, which is why `Access` needed a
new value rather than a special case. Tokens are per-owner, not per-user, until accounts land; a
`user` column and a `kind` are the two things Phase F will need and neither has to be migrated in.
The gateway streams internally and assembles tool calls, so a door stream emits tool calls as one
delta rather than fragment by fragment — correct for any client that concatenates, and the only
visible difference from talking to vLLM directly. Requests carry no `temperature`/`max_tokens`:
the gateway has nowhere to put them, so they are accepted and ignored rather than half-honoured.
