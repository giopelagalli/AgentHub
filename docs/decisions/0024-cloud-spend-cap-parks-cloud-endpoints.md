# 0024 — The cloud spend cap parks cloud endpoints, it does not stop the hub

Date: 2026-09-23
Decided by: senior-coder
Status: accepted

## Context

`MAX_CLOUD_USD_PER_DAY` bounds what the hub may spend on cloud inference in a trailing 24 hours.
The existing turn cap (`MAX_TURNS_PER_DAY`) refuses turns outright, which is right for turns —
a turn is a unit of work — but wrong for dollars, because only *cloud* requests cost anything and
a hub with a local GPU can keep working for free.

## Options

- **A — refuse turns once the cap is reached**, like `MAX_TURNS_PER_DAY`. Rejected: it stops free
  local work to protect a cloud budget, which is the opposite of what the owner wants.
- **B — refuse the request inside `chat()`** when the picked endpoint is cloud. Rejected: it fails
  a turn that a local endpoint could have served, because the refusal happens after the pick.
- **C (chosen) — take cloud endpoints out of `eligible()`**, the same list `prefer: 'local'` and
  the Spark park already filter.

## Decision

The gateway takes a `cloudAllowed: () => boolean` predicate, read on every `eligible()` call. While
it answers false, cloud endpoints are not candidates: local serving is unaffected, and a tier only
the cloud serves finds no capacity. That error names the cap — but only when lifting it would in
fact have found an endpoint, so a tier nothing serves at all still reads as plain "no capacity".

Spend is measured by `UsageStore.cloudUsdSince`, which sums rows whose provider is not local.
Unpriced rows (Anthropic) contribute nothing, because `SUM` skips NULL — **Anthropic spend does not
count against the cap**, since the hub has no price table for it and will not guess one.

## Consequences

The cap needs no reset: it lifts itself as the 24-hour window slides past the spend. It is read
per pick rather than cached, so the moment a turn's own spend crosses it the next pick sees it.
Crossings are announced once each, by a log line and (when configured) one Telegram alert, rather
than once per request. A hub with no local node and a reached cap cannot run turns at all — which
is the point, and the error says so.
