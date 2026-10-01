# 0062 — Media is a part of the Docs tab
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
FR-E2 wants a Media panel: the project's renders with their prompts, and a prompt box. The
redesign (0048, 0053) settled on five tabs; the brief left the choice open between a section under
Docs and an Overview "In this project" row opening a pane.

## Options
- A — a sixth tab: the brief's "fewer, deeper places"; why not.
- B — an Overview row opening a side pane: a grid of thumbnails needs the width the pane does not have, and the pane is where chat lives; why not.
- C (chosen) — Docs gets the sub-switch Plan and Code already have: **Pages · Media**.

## Decision
C. Docs is "what the project has produced besides code"; media sits beside the pages. The prompt
box leads the view (its one primary action); jobs in flight sit under it; the grid below.

## Consequences
The Docs tab now remembers its part for the session like Plan and Code. "In this project" on the
Overview has no Media row yet; adding one means loading the media list with the other summaries.
