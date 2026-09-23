# 0015 — Accounts wait; their foundations are built now
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The owner said accounts 'can wait' and also 'if it's easier to make it now, make it'. Retrofitting ownership onto every entity later is the expensive part; the invite/admin UI is not.

## Options
- A — nothing until Phase F: cheap now, painful later; why not.
- B — full accounts now: the riskiest change before the product is used daily; why not.
- C (chosen) — `owner` on nodes and projects, per-node tokens, and a per-user OpenAI-compatible door now, single-user; invites, sessions per user and grants last.

## Decision
PRD D1/D2, FR-D5/D6; `NodeInfo.owner` exists today with value `admin`.

## Consequences
Single-user behaviour is unchanged. Phase F becomes UI and policy, not a data migration.
