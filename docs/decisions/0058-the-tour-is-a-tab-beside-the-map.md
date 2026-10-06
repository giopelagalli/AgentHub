# 0058 — The tour is a third tab beside Files and Map, entered by *Start tour*
Date: 2026-10-01
Decided by: senior-coder
Status: superseded by 0072 (where the tour lives; the rest stands)

## Context
FR-B6 says the tour starts "from the Code map". The redesign (0048, 0053) gives Code three parts in
the toolbar's sub-segmented control — Files · Terminal · Preview — and inside Files a small Files /
Map control of the view's own. The tour needs a home in that language that a reader can leave (to
edit the file it showed them) and come back to at the same step.

## Options
- A — a fourth part in the toolbar (Files · Terminal · Preview · Tour). A new route, a new
  `CodePart`, and the tour cut off from the map and the editor it hands off to.
- B — a modal or sheet over the Map. Blocks the Guide pane that *Ask about this* opens, and closing
  it loses the place.
- C (chosen) — a third tab in the Files view's own control: Files · Map · Tour, with *Start tour* as
  the Map's primary button.

## Decision
`views/tour.ts` mounts the step view (snippet left in a read-only CodeMirror with the step's lines
tinted, explanation right through `renderDocMarkdown`; *Back* / *Next* / *Step 3 of 14* / *Open in
editor* / *Ask about this*), and `views/code.ts` holds it as the third pane. *Start tour* on the Map
starts at step 1; the Tour tab returns to the step the reader left. *Open in editor* and every
`path:line` in an explanation go to the Files tab at that line; *Ask about this* opens the Guide
pane with `About \`path:A\`–B (tour step N): ` already in its box (`ChatTarget.draft`; asking for the
open Guide with a draft reopens it rather than toggling it shut).

The tour's editor is a second `mountEditor`, loaded on the first step rather than with the screen,
so the Files editor's unsaved text is never disturbed by touring.

## Consequences
No new route or toolbar part, and the tour sits one click from the map it walks and the editor it
hands off to. The cost is that the Tour tab exists before there is a map; it says so and points at
*Refresh map*.
