# 0059 — The browser pool is contexts in one browser, leased per project
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
FR-D8: several projects should browse at once instead of queueing for the one shared session on
the Mac mini. A slot must be isolated from the others (cookies, storage, cache), addressable by the
hub, and cheap enough that a browser node can run several without a second machine. Two questions:
what a slot is on the node, and who a lease belongs to on the hub.

## Options
What a slot is:
- A — a Playwright browser process per slot: strongest isolation (a crash takes one slot), but N
  Chromium processes on the mini's memory and N launches at start; why not.
- B — one browser server (port) per slot: the same per-slot cost plus N ports to advertise and
  bind; why not.
- C (chosen) — one browser process with N isolated contexts (`browser.slots`, default 1, at most
  8), one page each, addressed by `?slot=N` on the existing routes.

Who holds a lease:
- D — per session (each AgentLoop session its own requester): a project's orchestrator and its
  subagents would each take a slot, so one busy project could fill the pool; and the orchestrator's
  fresh session id per turn would queue it behind its own lease; why not.
- E — per agent (id + kind, as before the pool): same pool-filling problem, and the manager and an
  employee could never look at the same page; why not.
- F — per project with a limit above one: more parallelism per project, but needs a per-project
  setting and a way to say *which* of the project's slots a tool means; not needed yet.
- G (chosen) — the project is the requester: one slot per project; anyone in it gets the project's
  lease back. Requests without a project keep the old id + kind key.

## Decision
The daemon launches one Chromium and opens a context per slot; `?slot=` absent means slot 0, so a
hub from before the pool drives exactly what it did. Registration advertises `browser: { url,
slots }`. The hub's `LeaseManager` reads the pool from the registry and grants `(node, slot)`,
least-loaded node first; a full pool queues by priority (owner, orchestrator, subagent). A
project's queued entry waits at its best member's rank and stays while any member still waits. The
owner's Take control names a slot and preempts only that slot. Leases, TTL and recordings keep their
single-browser semantics; a recording is per lease, which is per slot. Only a requester that was
granted a lease itself releases it; one sharing it through its project just lets go.

Behaviour that changed from the single browser:
- **Drain** queues a new request (it was a 409 "browser busy"); holders on the node finish.
- **No browser node online** queues every request, the owner's too, until a slot appears (it was
  granted and then every action failed with 503).
- **Offline** (stale heartbeat): the node's slots stay in the pool as draining, so a holder keeps
  its lease through a heartbeat gap until its TTL or a failed renew; its free slots are not shown.
  **Removal** or re-registering with fewer slots drops the leases on the slots that went away.
- **Slot reset**: the hub remembers each slot's last project; a lease granted to a different
  project — or on a slot whose last project it doesn't know (new to this hub, or the hub
  restarted) — resets the slot (`POST /browser/reset?slot=N`, a fresh context) before its first
  action. The owner taking a slot neither resets it nor counts as its last project.
- **Browser crash**: an unexpected Chromium disconnect exits the daemon non-zero so its service
  manager restarts it with a fresh browser.

## Consequences
A Chromium crash takes every slot on that node at once; a context isolates state, not process.
Within a project the orchestrator and its subagents share one page. A slot's last project lives
only in hub memory, so after a hub restart every slot's first grant resets it — one extra reset per
slot rather than a session leaking across projects, since the daemon's contexts outlive the hub.
Pausing models does not touch browsers. A per-project limit above one
(F) would be a new requester key and a slot argument on the tools, not a new shape.
