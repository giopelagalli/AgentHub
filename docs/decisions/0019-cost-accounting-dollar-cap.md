# 0019 — Every cloud request is priced; a hub-wide daily dollar cap turns cloud off
Date: 2026-09-23
Decided by: orchestrator
Status: accepted

## Context
The owner's first surprise bill was bounded in turns (0001) but not in money. Prices differ 20× between the flash and hard models, and the picker did not say so.

## Options
- A — show prices only: no protection; why not.
- B — token caps: the owner thinks in dollars; why not.
- C (chosen) — prices checked in per model (dated), usage captured per request via `stream_options.include_usage`, cost shown in the picker, header, per turn and per employee, and `MAX_CLOUD_USD_PER_DAY` making cloud endpoints ineligible when the trailing-24h spend reaches it.

## Decision
Prices as of 2026-09-23 from the owner's Fireworks page; local models cost 0; unknown prices record tokens with `usd: null`.

## Consequences
Prices drift; the date is shown. The cap is hub-wide until per-member accounting (Phase F).
