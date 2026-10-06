# 0072 — The Code tab: one control, one chat; the map and the tour move to Docs
Date: 2026-10-06
Decided by: owner (direction), designer (details)
Status: accepted

## Context
The owner looked at Code → Files and called it "too complicated". The bar held two segmented
controls (`Files · Terminal · Preview · Browser` and the view's own `Files · Map · Tour` — "Files"
twice), there were two ways to chat (the toolbar's chat icon and a blue *Ask the guide*, which
opened a third panel), the editor said "No file open" over a big blue **Save** with nothing open,
and on a wide window the Guide pane opened by itself: tree, editor and chat all at once. That breaks
0048's "one obvious thing per screen, quiet chrome". The Map/Tour/Guide features themselves (0056–
0058) were not in question.

## Options
- A — keep Map and Tour on Code as a fourth/fifth part of the toolbar's control. Still mixes
  *working on* the code with *learning* it, and a six-part control is no simpler.
- B — the map and tour as pages in the Docs rail ("How the code works" group). Literal, but the
  tour is a two-pane interactive view (editor + explanation) that does not fit the docs shell's
  reading column, rail and contents list; it would need the shell to host arbitrary views.
- C (chosen) — Docs gains a third part, **Pages · Media · How the code works**: the Map, with
  *Refresh map* and *Start tour* in the bar; the Tour replaces the map while touring, with *Back to
  the map* (the button then reads *Resume tour*). Code keeps one control and nothing else in its bar.

## Decision
- **Code's bar is only `Files · Terminal · Preview · Browser`.** Files is tree + editor
  (`views/code.ts`); `views/codemap.ts` is the new home of the map and its tour (`views/tour.ts`
  unchanged). The code map is taken out of Docs → Pages' *Reference* group, where its links were
  dead anyway, so it is not listed twice.
- **One chat.** *Ask the guide* is gone. The toolbar's chat button (and `c`) is the Guide on the
  Code tab — every part of it, Terminal and Preview included — docked in the page's pane, the
  button lit while it is open; on every other tab it is the Manager, as before. Its tooltip and
  label say which ("Chat with the Guide"), and the pane's heading says *Guide*. The Guide gets what
  *Ask the guide* gave it: its `path:line` citations open files. The tour's *Ask about this* still
  opens it with the lines named in the box.
- **The Guide no longer opens by itself** on a wide window: the chat button is how it is asked for.
- **Links into Files.** Views get `ViewContext.openCode(path, line)` and `openGuide(draft)`. A map
  link, *Open in editor*, or a citation goes to Code → Files at the line; if Files is already on
  screen the file opens in place (`CodeHandle.reveal`, so unsaved edits are still asked about),
  otherwise Files mounts with it. An open Guide pane stays open across that move.
- **Quiet editor.** No header until a file is open; then the path, the unsaved dot, and **Save**
  only while there are unsaved changes (⌘S throughout). With nothing open the column is one line:
  *Choose a file to open it.*

## Consequences
The Code tab is now the code and nothing about the code. Understanding it is one click further
(Docs, not Code), which is the trade the owner asked for; a map link still lands in the editor in
one click. The Guide is not given the open file as context — *Ask the guide* never did, and the
chat route has no field for it; adding one is a hub change, left for a later decision. The
tour's place in 0058 is superseded; its snippet and caching rules (0056, 0057) are unchanged.
