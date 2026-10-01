# AgentHub UI redesign — the brief (2026-10-01)

Owner's ask: "this UI currently sucks and needs to be simplified and made to look better … the
simple Apple UI feel that is intuitive … new and modern." Decision record: 0048.

## What's wrong today (from the owner's screenshot of the Demo project)

- **Everything has equal weight.** Chat, Order, a full-width model select, Auto-run, a budget line,
  Pause, Run turn and Add employee sit in one wrapping row; seven same-sized cards below them.
  The eye has nowhere to land.
- **Jargon on the surface.** "Order: Normal", "Auto (local first)", "auto" pill, "hub 24/24 turns
  left today", "project" under every project name — settings and internals shown as content.
- **Boxes everywhere.** Every element is a bordered rectangle; pills next to pills.
- **The sidebar mixes three jobs:** system pages with subtitles, a giant blue New project bar, and
  the project list (with redundant "active" pills and "project" captions).
- **Empty states don't say what to do** ("Not drafted yet", "Not configured").

## Principles (Apple HIG 2025–26, Linear's 2024/2026 refreshes)

1. **One primary action per screen; everything else recedes.** Navigation and chrome are dimmer
   than the content; settings live behind a gear, not on the page.
2. **Sidebar = navigation only.** Inset, quiet, collapsible (toolbar button + `[`). Projects are
   the list. System places (Machines, Help) sit small at the bottom. New project is a `+` in the
   sidebar header.
3. **A window with a toolbar.** Project title on the left; a segmented control for the sections;
   on the right a Chat button (icon), the one primary button (Run turn ↔ Running · m:ss), and a
   `⋯` menu.
4. **Fewer, deeper places.** Seven cards become five tabs: **Overview · Plan · Docs · Code ·
   Activity**. Plan = PRD + Roadmap. Code = Files · Terminal · Preview (a sub-segmented control).
5. **Empty states are invitations:** one sentence and one button ("Describe the idea — we'll
   draft the PRD", "Generate the roadmap", "Run the first turn").
6. **Settings are a sheet, grouped like macOS Settings:** Models, Schedule (auto-run + daily cap),
   Priority, Team (add employee), Danger (pause). The budget line lives there.
7. **Status is a dot, not a pill.** Green working, grey idle, amber needs you, red error.
8. **Words people use.** Priority not Order; "Runs on its own every hour" not "Auto-run";
   "Machines" not Cluster/Allocation/Computer.

## Visual language

- Type: `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`; 13px
  UI / 15px reading; titles 20–28px semibold; no uppercase labels; tabular numbers for costs/times.
- Space: 8-pt grid, generous; content max-width ~1100px; reading measure ~72ch.
- Surfaces: hairline separators and grouped lists instead of bordered cards; 10–12px radii where
  a container is needed; a translucent (backdrop-blur) sidebar and toolbar; soft shadows only on
  floating things (sheets, menus, popovers).
- Color: follows the system (light and dark, `prefers-color-scheme`, tokens for both); one accent
  (system blue); greys do the rest; status colors only for status.
- Motion: 150–200 ms ease-out; sheets and the drawer slide; no bouncing.
- Icons: a small inline SVG set (stroke 1.5, 16/20px) — no icon font, no new dependency.

## The screens

- **Overview** — a "Now" block: the current milestone, a progress bar of the roadmap, the latest
  briefing in two lines, and the next step. Below: the team as a row of avatars with status dots
  (click → the person's drawer: Now feed, model, harness, chat). Below: the last three activity
  lines with "See all".
- **Plan** — the PRD in the docs shell; the roadmap as a clean checklist (done ✓, current ●,
  planned ○) with drag-or-arrow reorder; the editor chat is a toggleable right pane.
- **Docs** — the docs shell (sidebar, breadcrumb, on-this-page, callouts).
- **Code** — Files (tree + editor + Guide pane) · Terminal · Preview.
- **Activity** — the turn timeline, unchanged in substance, restyled.
- **Machines** (system) — Nodes (with Drain/Remove/Add machine), Browser sessions, Queue, API
  tokens, GitHub connection, Cloud spend.
- **Help** — the guide in the docs shell.
- **New project** — a sheet with three big choices (Describe an idea · Paste a PRD · Import from
  GitHub), then one field per step.

## Non-goals

No feature removed. No framework. No new runtime dependency for the redesign itself.

## Addendum — where the build departs from this brief (designer, 2026-10-01; decision 0053)

- **Plan** shows the PRD (*Requirements*) and the **Roadmap** one at a time under a sub-switch,
  not stacked: the docs shell needs the width. The PRD's audit shows only the sections that need
  work, as one line.
- **Settings** is reached from `⋯ → Settings…` (with a gear icon there) rather than a separate gear
  in the toolbar, which keeps the toolbar to Chat, the primary and `⋯`. It is one grouped column,
  not a two-pane window; on a phone it is a bottom sheet.
- **The Overview** adds two things the brief does not list: an *In this project* list (the old
  cards' one-line state for Requirements, Roadmap, Docs, Code and Preview, each a way into its tab,
  plus the 24-hour cost), and an *Above the team* line for the Assistant and the Master — they were
  in the org chart and had no other home. A running turn leads the page with who is doing what.
- **New project** asks the name and short name together on one step, then the content — two steps
  after the choice, not one field per step.
- **Status dots** add a fifth state: a hollow ring for *paused*. Amber is `blocked`; red is "the
  last turn failed", known for any project whose turns have reached the browser.
- **Machines** has four sections: *Nodes* (with the cloud spend under the heading), *Browser*,
  *Queue* (the running order with each project's priority, then the jobs) and *Access* (API tokens
  and GitHub).
- **The terminal** stays dark in the light theme.
- **Code → Files** opens the Guide beside the files only where there is room (over 1000px); on a
  narrow window it waits for *Ask the guide*.
- **Deep links**: none existed before the redesign and none were added; the tab and sub-tab you
  were on are remembered for the session, across projects.
