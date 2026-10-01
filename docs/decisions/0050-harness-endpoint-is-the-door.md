# 0050 — an external harness calls models through the hub's own door, with a per-run token
Date: 2026-10-01
Decided by: senior-coder (on review of the pi spike)
Status: accepted

## Context
The built-in loop calls `gateway.chat(tier, …)`, which picks an endpoint, streams, fails over,
counts the stream against the endpoint's `maxStreams`, prices the tokens and writes the usage
ledger. A harness running as a subprocess cannot call any of that directly: it needs a url, a model
id and a key it can put in a config file. The spike resolved the endpoint the gateway would have
picked and handed pi that endpoint's url and provider key. The hub's OpenAI-compatible door
(`door.ts`, `POST /v1/chat/completions`) has since merged, and it is exactly that url and key, with
the gateway behind it.

## Options
- A — keep pointing pi at the gateway's chosen endpoint directly (the spike's shape): a provider key
  enters the subprocess, there is no failover, the stream is invisible to `maxStreams`, and the
  spend never reaches the ledger or the daily cloud cap. Why not.
- B — a long-lived `agent` token minted once for all harness runs: one leaked token outlives every
  run and cannot be told apart in the ledger. Why not.
- C (chosen) — pi's per-run `models.json` points at the hub's own door on loopback, authenticated
  by an `agent` API token minted for that run and revoked when it ends.

## Decision
`selectHarness` takes a `HarnessDoor` — the hub's listen base (`http://127.0.0.1:<port>`, read off
the listening server, or `HubOptions.selfBase` in tests) and the `ApiTokens` store. At run start the
pi adapter mints an `agent` token labelled `pi:<project>/<member id>` (the member part empty when
the run has no roster member), writes `models.json` with
`baseUrl: <base>/v1` and `apiKey: "AGENTHUB_HARNESS_KEY"` — the env-var *name*; pi resolves it from
its own environment, where the token is the only credential added back to the stripped env — and
asks for a model that carries the run's route (`doorModel`):

- `prefer: 'local'` → `agenthub/worker@local`, whatever model is named, since the gateway only
  ever applies a named model to a cloud endpoint;
- `prefer: 'cloud'` → the named model, else `agenthub/worker@<provider>`, else
  `agenthub/worker@cloud`;
- `auto` or no policy → plain `agenthub/worker`. A named model or provider under `auto` only
  shapes the gateway's cloud *fallback*, which the door cannot express; sending either would put
  the cloud first, so it is dropped and the fallback uses the endpoint's own model.

The door learned those suffixes for this (0034): `@local` is `prefer: 'local'` plus the existing
no-local-capacity 503, `@cloud` is `prefer: 'cloud'`, `@<provider>` is `prefer: 'cloud'` with
that provider. Without them a local-only project's pi run would have been routed `auto` and could
have been billed to the cloud. `/v1/models` still lists only the two plain names. Note `@local`
is stricter than the built-in loop's `prefer: 'local'`, which spills into the cloud when nothing
local is eligible at all: a pi run on a local-only project then fails at its first call instead.

The token is revoked in the run's `finally`. When the run ends, for any outcome, the adapter also
SIGTERMs pi's process group if anything in it is still alive, so a process pi's `bash`
backgrounded cannot outlive the run. No provider key ever enters the subprocess. `endpointFor` and
`HarnessEndpoint` are gone. When the door cannot be reached (no `HarnessDoor` wired, or the hub is
not listening yet), pi is refused and the run falls back to `builtin` with the reason recorded in
the run's session events.

Because every pi model call is now an ordinary door request into `gateway.chat`:
- pi spend lands in the usage ledger and counts under `MAX_CLOUD_USD_PER_DAY`. The door reads
  the run token's label back (`harnessAttribution`): an `agent` token labelled
  `pi:<project>/<member id>` books its rows to `subject = <project>`, `member_id = <member id>`
  (null when that part is empty; kind stays `door`), so pi spend is in the project's cost exactly
  as the built-in loop's is;
- each call counts toward its endpoint's `maxStreams` like any other stream;
- pi gets the gateway's failover and health marking;
- pi's calls carry the `agent` priority (10), so the owner's assistant still goes first.

The `usage` turn event pi's adapter emits is priced only when the route names a concrete cloud
model; for `agenthub/worker` the door alone knows what served the call, so the event carries the
tokens with `usd: null` and the ledger row is the priced record.

## Consequences
pi can now be served by anything the gateway can, Anthropic included, since the door translates.
The spike's "spend is invisible to the usage page" caveat is closed, which removes one of the two
reasons pi is not yet the default — containment (0049) is the one left. A token minted for a run
shows in the owner's token list while that run is live. A run cannot survive a restart, so at
startup the hub revokes every live `agent` token whose label starts with `pi:` (an exact
`substr` match) — a crash leaves no token open past the next boot. The prefix is reserved:
`POST /api/tokens` refuses a label starting with `pi:` (400), so only a pi run holds one, and
neither the attribution nor the sweep can be steered by a hand-minted token.
The member's live cost chip sums the turn's `usage` events, where pi's `usd` is null, so it shows
pi's tokens but not its dollars; the dollars are in the project's ledger total. A concrete model
id must be one the door can resolve
(an endpoint currently serving it); a member override naming any other model fails the run at
pi's first call rather than silently substituting.
