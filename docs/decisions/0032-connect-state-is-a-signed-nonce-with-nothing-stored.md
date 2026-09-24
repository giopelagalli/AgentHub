# 0032 — The connect round trip carries a signed nonce; nothing is stored
Date: 2026-09-24
Decided by: senior-coder

## Context
Pressing **Connect GitHub** sends the browser to github.com and hopes it comes back. The hub has to
recognise the return: that this callback belongs to a connect *this* hub started, for *this*
member, recently — and it has to survive GitHub's own inconsistency, because `state` comes back on
the install leg but a later "redirect on update" can arrive without one.

## Options
- A — a `pending_connects` table keyed by nonce: a row per press, swept on expiry. Why not: a table
  and a sweeper for a value that is verified once, seconds later, and is never worth reading.
- B — nothing at all, relying on the owner session alone: the callback is an owner route, so the
  session is already required. Why not: it would accept any callback URL anyone can get the
  member's browser to visit, and the `installation_id` on it is attacker-chosen.
- C (chosen) — a stateless signed token: `<nonce>.<member>.<expiry>.<hmac>`, signed with the hub's
  session key, valid 15 minutes.

## Decision
`ConnectState.sign(user)` mints it, `verify` gives back the member or null. The MAC is compared
with `timingSafeEqual`, the expiry is inside the signed payload (so a forged token's age proves
nothing), and the key is `HUB_SESSION_SECRET` when there is one — a per-process random key
otherwise, which is the same trade `Auth` already makes for sessions.

The callback requires a valid `state` for **every return that carries a `code`** — that is, every
return that would bind an installation to a member. GitHub preserves `state` through
`installations/new`, so a return without one is not a connect this hub started.

A return with **no `code`** is the other shape GitHub sends: "redirect on update", when the member
only changed which repositories an existing installation covers. There is no way to learn who is
connecting without a `code`, so nothing is stored and nothing is checked — the browser is simply
sent home. That branch comes first in the handler, so the `state` requirement cannot turn a routine
update into an error.

The hub session is required on top of all this, always (`routeAccess` leaves everything under
`/api/` as `owner`, and `SameSite=Lax` sends the session cookie on a top-level GET, which is what
GitHub's redirect is).

## Correction (review, 2026-09-24)
This record first said the callback "verifies `state` when present rather than requires it to
exist", reasoning that the session covered the rest. That was wrong. A callback URL an attacker
assembles — their `code`, their `installation_id`, no `state` — binds *their* installation to this
account the moment the member opens it as a top-level GET, and on a hub running without
`HUB_PASSWORD` it needs no member at all. The check is now unconditional wherever a `code` is
present, and the test that asserted the lenient behaviour asserts the 400 instead.

## Consequences
No table, no sweeper, no row to leak. A hub restart mid-connect invalidates the state only when
`HUB_SESSION_SECRET` is unset, which is the same condition under which it logs the member out
anyway. The 15-minute window is the ceiling on how long someone may spend on GitHub's repository
picker before their press stops counting; nothing else depends on it.
