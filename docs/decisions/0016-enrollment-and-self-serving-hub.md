# 0016 — Nodes enroll with one-time tokens, get per-node bearers, and fetch the daemon from the hub itself
Date: 2026-09-23
Decided by: orchestrator
Status: accepted

## Context
Adding a node meant a shared `DAEMON_TOKEN`, repo access on the machine (a private repo), and hand-written YAML. A friend's machine has none of that.

## Options
- A — keep the shared daemon token and a public repo: one leaked token is every node; repo must be public; why not.
- B — SSH-based provisioning from the hub: the hub reaching into machines is the wrong direction; why not.
- C (chosen) — `POST /api/nodes/enrollment-tokens` (owner) → one-time token → `POST /api/nodes/enroll` (open, throttled) → per-node bearer; the hub serves `/install.sh` and a `git archive` tarball of its own source, so nodes never need repo access.

## Decision
Node tokens valid only for the node they name (two-phase check); `DAEMON_TOKEN` stays as the admin's break-glass; Remove revokes; a 60 s lockout on removed names; node names validated.

## Consequences
The hub's version is what nodes run. A 409 on a name clash burns the token (mint again). Verified end to end on the owner's MacBook 2026-09-23.
Admission is trust: an enrolled node may advertise serving endpoints the gateway will route the
owner's turns through, and may claim `shell-task` jobs carrying the owner's project work. There is
no per-node allow-list yet; until Phase F adds ownership-aware routing, only enroll machines you
would hand your workspace to. An enrollment token may create a node or re-enroll the node it was
minted for (`suggested_name`); it can never take over another existing node (review 2026-09-23).
