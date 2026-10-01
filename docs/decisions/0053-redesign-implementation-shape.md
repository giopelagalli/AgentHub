# 0053 — How the redesign is built: tabs in one page, token aliases, Machines over the old page ids
Date: 2026-10-01
Decided by: designer
Status: accepted

## Context
0048 set the direction and the brief (`docs/design/redesign-2026-10.md`) the screens. Building it
left choices the brief does not make: how the five tabs relate to the views that used to open in a
full-screen sheet, how a new visual language reaches ~2,000 lines of component CSS without a
rewrite of each, how Cluster, Computer and Allocation become one page without touching the socket
or the store, and how the roadmap's drag-to-reorder fits an API that only moves one step.

## Options
- A — rewrite every view's DOM and CSS for the tabs: the views (PRD, roadmap, docs, code,
  terminal, preview, activity) already take a host and a context; rewriting them buys nothing and
  risks their behaviour; why not.
- B — rename the page ids to `machines/nodes…` and migrate the store, net and their tests: a
  churn of working code for names nobody sees; why not.
- C (chosen) — the project page mounts the existing views into its body as tabs, with two small
  extensions to `ViewContext` (`actions`, a bar the page gives a view for its buttons; `openChat`
  toggling a pane); Machines' sections keep the old page ids (`cluster`, `computer`,
  `allocation`, plus `access`) and the sidebar maps them to one place; a token file defines the new
  palette for light and dark and aliases the old token names onto it, so `app.css` follows the
  theme, and one stylesheet per area in `styles/` re-dresses it.

## Decision
C. Smaller decisions inside it:
- Plan shows the PRD and the roadmap one at a time under a sub-switch (*Requirements · Roadmap*):
  the docs shell needs the width a side-by-side layout would take.
- The roadmap is a checklist whose glyph opens a status menu; a drag sends one `move` per step,
  in order, then re-reads — the hub has no move-to-index.
- Settings is one grouped column (a bottom sheet on a phone), not a two-pane window: five small
  groups read in one scroll.
- The terminal stays a dark screen in the light theme: programs' ANSI colours assume one.
- The sidebar hides completely rather than collapsing to an icon strip, and is a drawer under 760px.
- A project's dot: green while a turn runs, amber when `blocked`, red when its last turn failed,
  a ring while paused, grey otherwise.

## Consequences
Every view still works on its own (the sheet era's tests and behaviour hold), at the cost of two
layers of CSS for those views — `app.css` and the `styles/` file that re-dresses it. Folding each
component's rules into its `styles/` file is a cleanup that can happen view by view; nothing
depends on the split. Page ids no longer match the words on screen (`cluster` is Nodes); the
mapping lives in `rail.ts` and `pages/machines.ts`. A drag across many rows is several requests;
with roadmaps of a dozen milestones that is fine, and a move-to-index route would replace it.
