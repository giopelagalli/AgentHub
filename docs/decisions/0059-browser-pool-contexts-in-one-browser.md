# 0059 — The browser pool is contexts in one browser, leased per project
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
FR-D8: several projects should browse at once instead of queueing for the one shared session on
the Mac mini. A slot must be isolated from the others (cookies, storage, cache), addressable by the
hub, and cheap enough that a browser node can run several without a second machine.

## Options
- A — a Playwright browser process per slot: strongest isolation (a crash takes one slot), but N
  Chromium processes on the mini's memory and N launches at start; why not.
- B — one browser server (port) per slot: the same per-slot cost plus N ports to advertise and
  bind; why not.
- C (chosen) — one browser process with N isolated contexts (`browser.slots`, default 1, at most
  8), one page each, addressed by `?slot=N` on the existing routes.

## Decision
The daemon launches one Chromium and opens a context per slot; `?slot=` absent means slot 0, so a
hub from before the pool drives exactly what it did. Registration advertises `browser: { url,
slots }`. The hub's `LeaseManager` takes the pool from the registry (online browser nodes; a
draining node's slots finish their lease but are never handed out; a removed or offline node's
slots — and leases — are gone) and grants `(node, slot)`, least-loaded node first. A project holds
one slot: anyone in the same project gets the project's lease back. The owner's Take control names
a slot and preempts only that slot. Leases, queue and TTL keep their single-browser semantics;
recordings stay per lease, which is per slot.

## Consequences
A Chromium crash takes every slot on that node at once; a context is isolation of state, not of
process. Within a project the orchestrator and its subagents share one page, so one of them
releasing it releases it for all. Pausing models does not touch browsers. A per-project limit
above one would be a new requester key, not a new shape.
