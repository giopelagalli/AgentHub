# 0060 — A project's Browser view: whose slot it is, and no Open a browser
Date: 2026-10-01
Decided by: designer
Status: accepted

## Context
FR-B7 puts each project's live browser in its Code tab (Files · Terminal · Preview · Browser) on
the pool from 0059. Three things the pool left open: which slot counts as "the project's" when the
owner takes control, whether the owner can open a browser for a project from there, and how the
page gets frames when the cast was the computer page's alone.

## Options
- Whose slot: by `lease.requester.project` only — but Take control sent no project, so a slot the
  owner took from a project vanished from that project's page the moment it was taken.
- Open a browser: `POST /api/browser/preempt` (or `/lease`) with `{ id: 'owner', project }` — the
  route accepts the field, but the hub never folds the owner into a project nor resets a slot for
  the owner, so the "project's" browser would be another project's leftover session, the project's
  agents would not get it back, and nothing in the UI renews or drives it (it lapses in 120 s).
  Posting as the orchestrator instead would make the UI impersonate an agent.
- Frames: a second subscription path for the project page — two owners of one topic.
- (chosen) Take control names the displaced holder's project, on both the Machines tile and the
  project view; no Open a browser button; one `wantsCast(state)` (computer page, or a project's
  Browser view open) decides the topic and when frames are dropped.

## Decision
A slot is the project's while its lease names the project; the owner's Take control carries the
project (the hub uses it only as a label — no reset, no folding), so the view keeps showing it as
*Held by you*. If the owner and an agent both hold a slot for the project, the agent's is shown.
The empty state has no Open a browser button: agents open one when a task needs the web. The store
gains `projectBrowser`, set by the view while mounted; the socket subscribes while `wantsCast`.

## Consequences
An owner lease now shows its project on Machines (*owner — pomodoro-cli*). An owner-opened browser
for a project needs the hub to grant the owner a project lease that resets into the project's
session and that the project's agents share — a hub change, not a UI one, if it is ever wanted.
The project page's Browser view and the computer page share the take/release calls
(`takeControl`, `releaseLease` in `pages/computer.ts`).
