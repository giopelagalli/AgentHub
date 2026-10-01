# 0032 — an external harness gets the gateway's chosen endpoint directly, until the hub's door exists
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
The built-in loop calls `gateway.chat(tier, …)`, which picks an endpoint, streams, fails over,
prices the tokens and writes the usage ledger. A harness running as a subprocess cannot call any
of that: it needs a url, a model id and a key it can put in a config file. Meanwhile the hub is
growing its own OpenAI-compatible door (`/v1/chat/completions`), which would be exactly the right
thing to point a subprocess at.

## Options
- A — give pi a cloud provider's key straight from the hub's environment: hands a subprocess a
  credential with no hub-side accounting or cap. Why not.
- B — wait for the door and ship no adapter this branch: leaves FR-G2 unverified behind a
  dependency owned by someone else. Why not.
- C (chosen) — resolve the endpoint the gateway itself would have picked (`gateway.pick('worker',
  route)`) and point pi at that, with the endpoint's own `apiKeyEnv` passed through pi's
  environment under a fixed name the generated `models.json` refers to. Shape the `HarnessTask`
  so the door replaces the endpoint without touching the adapter.

## Decision
`HarnessTask.endpoint` is `{url, model, apiKeyEnv?, provider}` — the four facts a subprocess needs
and nothing more. `endpointFor()` in `harness/select.ts` resolves it, refusing Anthropic (no
OpenAI-compatible url exists; the hub speaks it through its own SDK client) and refusing an
endpoint whose key env var is unset. A refusal falls back to `builtin`.

Two consequences of not going through `gateway.chat` are accepted for now and named here so they
are not discovered later as bugs:

- **No failover or health marking.** A pi run is pinned to the endpoint picked when it started; if
  that endpoint dies mid-run, pi's own retries are all there is.
- **The usage ledger does not see it.** `UsageStore` is written by `AgentLoop`. A pi run emits a
  `usage` turn event (priced with the hub's own `priceFor`/`costUsd`, so the turn's cost line in
  the feed is right) but writes no ledger row, so `/api/usage` under-counts pi work.

`endpointFor` also mirrors one rule from the gateway — that a named model only ever replaces a
*cloud* endpoint's model — rather than calling into it. That duplication is deliberate and
temporary: it disappears with the endpoint itself.

## Consequences
pi works today against local vLLM and Fireworks alike, with the key never on disk and never in
argv. When the door lands, `endpointFor` becomes "the door's url, the door's model name, a
short-lived token", failover and the ledger come back for free because every harness call is then
an ordinary hub request, and this record is superseded. Until then, an owner who runs employees on
pi sees their spend in the turn feed but not in the usage page — worth fixing before pi becomes
anyone's default.
