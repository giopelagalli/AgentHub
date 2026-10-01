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
- `menu.ts` is a hand-rolled pop-up menu (positioned under its button, arrow keys, Escape and
  outside-click to close), with one module-level `closeOpen` so only one menu is ever open. Rejected:
  a native `<select>` (no icons, no separators, no links, and it cannot be a button's menu) and a
  menu/popover library (a dependency for ~150 lines; the brief rules out new runtime dependencies).
- `panels/modal.ts` is one shared dialog — scrim, focus trap, Escape, return focus — that the
  settings sheet and New project both fill; it replaces `panels/sheet.ts` and the wizard's own copy
  of the same trap. Rejected: the native `<dialog>` element (its top layer sits above the menus and
  toasts the sheets open, and its backdrop and focus return differ across browsers) and keeping one
  trap per sheet (three copies of the same keyboard rules).
- `icons.ts` is an inline SVG set (~30 glyphs on one 24-unit grid, `currentColor` strokes).
  Rejected: an icon package or font (a dependency, and a font cannot follow the theme's stroke
  weight), and image files (they cannot take the text colour in both themes).
- The full-screen artifact sheet is gone: a document's chat is a **pane** beside the tab
  (`openChat` into the page's own column, toggled by the same button), and a team member's panel
  is a **floating drawer** over the page. Rejected: keeping the sheet over the tabs (a second
  window over the first, which is what the owner found cluttered) and a modal chat (the document
  and the conversation about it have to be usable at once).

## Consequences
Every view still works on its own (the sheet era's tests and behaviour hold), at the cost of two
layers of CSS for those views — `app.css` and the `styles/` file that re-dresses it. Folding each
component's rules into its `styles/` file is a cleanup that can happen view by view; nothing
depends on the split. Page ids no longer match the words on screen (`cluster` is Nodes); the
mapping lives in `rail.ts` and `pages/machines.ts`. A drag across many rows is several requests;
with roadmaps of a dozen milestones that is fine, and a move-to-index route would replace it.

## Addendum 2026-10-01 — the two API pieces landed
Decided by: orchestrator. Supersedes three statements above: "a drag sends one `move` per step … the
hub has no move-to-index" (Decision), the dot being red only from turns the browser has loaded
(Decision, the project's dot), and "a drag across many rows is several requests … a move-to-index
route would replace it" (Consequences). All three are now out of date.

- A drag sends one `POST /roadmap/move { id, to }` (0-based target index, clamped) — one request,
  one commit. The keyboard and the arrow buttons keep the `{ id, direction }` form.
- Each project in `/api/state` carries `lastTurn { outcome, endedAt }` from the transcript, so the
  dot no longer needs the browser to have loaded the project's turns. Turns the browser does hold
  are fresher and win over the snapshot.
- **`lastTurn` shape.** A computed field on the project entry, never written to `manifest.json`.
  Rejected: a separate `lastTurns` map on `HubState` (a second thing for every consumer to join to
  the project list by slug, for a value that is only ever read alongside it). The cost: the
  `ProjectManifest` type has a field the stored file never has.
- **`to` on the existing route.** Overloaded onto `/roadmap/move` rather than a new route: one
  route, one meaning ("move this milestone"), and the step form keeps working. When both `to` and
  `direction` are sent, `to` wins. Rejected: a new `/roadmap/move-to` route (two routes for one
  action).
- **Aborted is not red.** A hub restart marks the turns it interrupted `aborted`; showing those as
  failures would turn dots red after every restart. In `projectDot`, `aborted` (from `lastTurn` or
  from loaded turns) reads as amber "Needs you"; red stays for `error`/`failed`.
- `sessions(kind, subject, ended_at)` is indexed for the per-subject "latest ended session" query.

