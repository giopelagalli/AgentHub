# 0034 — The OpenAI-compatible door is its own plugin, opened by hashed user API tokens
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

## Options — what `model` names, and what `/v1/models` lists
FR-D6 says `/v1/models` "lists what that user may use", which in a world with grants is a filtered
list of real models. There are no grants yet, and the hub's own routing already decides which node
serves a turn, so a door that names models would hand that decision back to the client.

- D — real model ids only, the OpenAI-literal reading: every client would have to know which node
  is up and pick one, and a client pinned to a model is stranded the moment that node drains; it
  also gives up failover, the cloud fallback and the spend cap, which are the point of the hub;
  why not.
- E — the two tier names only, nothing else accepted: simple and honest, but there is no way left
  to say "this one really must run on the Spark's local model" or "this one really is worth
  Fireworks", which projects can already say through their `ModelPolicy`; why not.
- F (chosen) — two synthetic names, `agenthub/orchestrator` and `agenthub/worker`, are the
  namespace `/v1/models` lists; `POST /v1/chat/completions` additionally accepts any concrete id
  that some registered endpoint is serving right now, resolved through the registry into a tier
  plus a `Route` (a cloud id → that provider and that model; a local id → local only, 503 when no
  local endpoint can serve it).

## Decision — the model namespace
The two tier names are what the door advertises, and a tier is what a `model` normally selects: the
hub picks the node exactly as it does for a project turn, and the response's `model` field says
what actually served it. Concrete ids work but are deliberately not listed, because the list is
`/api/models`'s job and a door client should not be shopping for nodes. This diverges from FR-D6's
wording, not its intent — until accounts exist, "what that user may use" is "the owner's whole
fleet", which is exactly what the two names mean.

## Decision
`packages/hub/src/door.ts` holds both halves — the tokens and the `/v1` routes — and is registered
in `server.ts` with one line. `routeAccess` classifies `/v1/*` as `door` rather than `none`, so the
routes are still explicitly guarded, just not by the shared hook: only the plugin knows which token
a request speaks for, and it needs that answer for priority and for the ledger anyway. Bad bearers
get `LoginThrottle` per IP, on its own counter, like enrollment. Every door request records a usage
row with `kind: 'door'`, `subject: 'door:<label>'`, `member_id: null`, so the cost chip and the
daily cloud cap see an outside client exactly as they see a project turn. `user` is `admin` today;
the column is there for Phase F.

The lockout counts bad bearers only: a token that verifies is answered before the throttle is
consulted and never clears its counter either, because behind the droplet's proxy every outside
client shares one address and one misconfigured client must not take the rest down with it. That
makes `TRUST_PROXY` the thing that keeps the lockout per-client rather than per-fleet, as it
already is for login (0025). A door request is also refused during a control-node switch, GET
included, because unlike the read-only API every one of them writes — a usage row, a token's
last-used stamp, possibly cloud dollars.

## Consequences
The door is the first route family outside `/api/` that is guarded, which is why `Access` needed a
new value rather than a special case. Tokens are per-owner, not per-user, until accounts land; a
`user` column and a `kind` are the two things Phase F will need and neither has to be migrated in.
The gateway streams internally and assembles tool calls, so a door stream emits tool calls as one
delta rather than fragment by fragment — correct for any client that concatenates, and the only
visible difference from talking to vLLM directly. Requests carry no `temperature`/`max_tokens`:
the gateway has nowhere to put them, so they are accepted and ignored rather than half-honoured.
A concrete *local* id needs the gateway's new `localAvailable(tier)` to keep its promise, because
`prefer: 'local'` is local-*first*: without the check a drained node would have turned "run this
on my own hardware" into a cloud bill. The door refuses with a 503 instead.

Amended by 0050: a tier name takes a route suffix — `@local` (with the same 503), `@cloud`,
`@<provider>` — documented but not listed in `/v1/models`, so a caller can carry a model policy.
