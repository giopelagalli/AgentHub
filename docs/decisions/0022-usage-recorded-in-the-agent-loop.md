# 0022 — Usage is recorded in the agent loop, not at each call site

Date: 2026-09-23
Decided by: senior-coder
Status: accepted

## Context

Cost accounting has to cover every model request the hub makes: project turns, subagent runs,
one-on-one chats, the PRD drafter, the roadmap generator and the owner's assistant. Each of those
has its own module, and the spec named several of them individually as places to "wire it up".

## Options

- **A — record at each call site.** Every module that spends would call the ledger. Rejected: five
  call sites to keep in step, and the next one added silently spends nothing.
- **B — record inside `ModelGateway.chat()`.** One place, but the gateway knows nothing about
  sessions, projects or roster members, so the rows could not be attributed.
- **C (chosen) — record in `AgentLoop`.** Every model call in the hub already runs through
  `AgentLoop.run()`, and the loop is the narrowest layer that knows both the `ChatUsage` the
  gateway returns and the session, subject, kind and member it belongs to.

## Decision

`AgentLoop` takes an `onUsage` hook, wired once in `createHub` to `UsageStore.record`. The gateway
prices a request and returns `ChatResult.usage`; the loop attributes it. A run whose ledger kind
differs from its session kind passes `usageKind` — the PRD drafter runs as a `chat` session but
records as `prd`.

## Consequences

One hook covers every present and future caller of the loop. `AgentRuntime` (the legacy staff-floor
agents) calls the gateway directly and is *not* covered; it is unused by the project system, and
wiring it would mean giving it a session identity it does not have.
