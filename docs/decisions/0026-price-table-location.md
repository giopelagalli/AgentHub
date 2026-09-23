# 0026 — The price table lives in the Fireworks provider until a second provider has one

Date: 2026-09-23
Decided by: senior-coder
Status: accepted

## Context

`priceFor(provider, model)` answers for all three providers — local serving is free, Fireworks has
a table, Anthropic has none — but it sits in `providers/fireworks.ts`, which by its own header owns
"the base url, the model defaults, the model list, and their prices". A provider-agnostic function
in a provider-specific module is a boundary worth stating rather than leaving to be discovered.

## Options

- **A — a new `providers/pricing.ts`** owning `ModelPrice`, `priceFor` and `costUsd`, importing the
  Fireworks table. Correct shape, but with exactly one table to import it is a module whose whole
  content is a re-export and two one-line special cases.
- **B — a price field on `ServingEndpoint`**, set where the synthetic cloud nodes are registered.
  Rejected: prices would then be per-endpoint configuration the owner could get wrong, when they
  are facts about a vendor's catalogue.
- **C (chosen) — leave it in `providers/fireworks.ts`** and say why, with a note to move it.

## Decision

`priceFor` and `costUsd` stay in `providers/fireworks.ts`. **When a second provider gains a price
table** — an Anthropic one is the likely first — both move to `providers/pricing.ts`, which owns
`ModelPrice`, the free-local and no-table cases, and dispatch to each provider's own table.

## Consequences

`gateway.ts` imports pricing from a module named for one provider, which reads oddly until that
move. Nothing else depends on the location: `priceFor` and `costUsd` are pure and their callers
(the gateway, and `server.ts` for the model catalogue) would not change.
