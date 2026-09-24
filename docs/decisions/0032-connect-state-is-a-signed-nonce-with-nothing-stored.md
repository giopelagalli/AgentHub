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

The callback verifies `state` **when present** and requires the hub session **always**
(`routeAccess` leaves everything under `/api/` as `owner`, and `SameSite=Lax` sends the session
cookie on a top-level GET, which is what GitHub's redirect is). What the state adds on top of the
session is that the install being reported started from this member's own press of the button.
A `code` is required unconditionally, because without it there is no way to learn who is connecting
and so no way to check that the installation is theirs (0031) — a callback without one is a 400
saying to press Connect again.

## Consequences
No table, no sweeper, no row to leak. A hub restart mid-connect invalidates the state only when
`HUB_SESSION_SECRET` is unset, which is the same condition under which it logs the member out
anyway. The 15-minute window is the ceiling on how long someone may spend on GitHub's repository
picker before their press stops counting; nothing else depends on it.
