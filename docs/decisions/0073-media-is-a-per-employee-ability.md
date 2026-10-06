# 0073 — Media is a per-employee ability, not a role
Date: 2026-10-06
Decided by: owner
Status: accepted

## Context
Since 0060 only an employee with the `designer` role got `generate_image` and `generate_video`,
both or neither. The owner asked for image and video generation to be "an ability for an agent":
any employee can make either, both or neither, depending on what is selected for them. The
recommendation on the table had been the role, which keeps the roster simple but forces a hire
(and a second person) for a coder who should also draw the app icon.

## Options
- A — keep the `designer` role as the only way in. Not what the owner asked; one clip-maker means
  a whole extra employee.
- B — a new `media` role per kind. Same problem, two more roles.
- C (chosen) — `TeamMember.abilities?: ('image' | 'video')[]`, stored in `team.yaml`; each ability
  gives that one tool, whatever the role.

## Decision
C. `memberAbilities` (`@agenthub/shared`) is the one reading of it: the member's `abilities` when
set (even `[]`), otherwise both for a `designer` and none for anyone else — so a roster from
before this behaves exactly as it did, and switching a designer's toggles off really takes the
tools away. `spawn_subagent` adds `memberMediaTools(member, desk)` on top of the role's extras;
the manager's own belt and the milestone reviewer's pinned read-only belt never get them.

The owner sets it in the employee drawer: a **Can make** row with **Images** and **Videos**
switches, saved through the existing `PATCH /api/projects/:slug/team/:id` (`abilities`, validated
to a deduplicated subset in `image, video` order; `null` clears back to the role default), and
also accepted on hire. It is stored whether or not a machine can render; `GET …/team` carries
`renderers` (the same answer as the media panel's) so the drawer can say "No machine can render
yet — renders are refused until one joins" — refused rather than queued, because `MediaDesk`
refuses a kind no registered node offers (0060).

The manager's roster line reads `Ada (coder, makes images)` and its rule sends media work to
whoever the roster says makes it; the subagent prompt tells any role with a render tool about it.

## Consequences
- The `designer` role stays as a role brief (visual assets), but it is no longer what gates media.
- An employee with an ability on pi or claude-code runs on the built-in loop for each delegated
  task, said in the job log — the same fallback a designer always had, because an external
  harness cannot offer the hub's tools. The drawer says so under Harness ("Tasks run on the
  built-in loop while Images is on.").
- `memberAbilities` honours `abilities` only when it is a list (team.yaml is hand-editable);
  anything else reads as unset, and unknown kinds drop out.
- The hire form in Settings → Team does not show the switches yet (the route accepts the field);
  abilities are set from the drawer after hiring.
