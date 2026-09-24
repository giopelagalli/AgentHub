# 0031 — CodeMirror 6 for the Code screen, loaded on demand
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
FR-B3 wants a viewer the owner can also edit in: syntax highlighting, a line gutter, a cursor
they can put on line 412 because the code map linked there. The UI has had no runtime dependency
at all until now — Vite + vanilla TypeScript, 122 kB of JavaScript — so whatever goes in is the
first, and sets the precedent for how the app pays for a heavy widget.

## Options
- A — a `<textarea>` with a hand-rolled gutter. No highlighting, no reliable line addressing, and
  the gutter drifts out of alignment the first time a line wraps. It is not a viewer for code.
- B — Monaco (VS Code's editor). More capable than anything this screen needs, several megabytes,
  and it carries its own worker and loader story.
- C (chosen) — CodeMirror 6, assembled by hand from the pieces the screen uses, and imported
  dynamically so only the Code screen loads it.

## Decision
CodeMirror 6: `@codemirror/{state,view,language,commands,theme-one-dark}` plus one language package
per file type the screen highlights (`lang-javascript`, `-json`, `-markdown`, `-python`, `-html`,
`-css`). `basic-setup` is deliberately not used — autocompletion, linting, search and folding are
weight for features this screen does not offer. `packages/ui/src/code/editor.ts` is the only module
that imports any of it, and `views/code.ts` reaches it through `import()`.

## Consequences
Measured against the same build before this change: the main bundle goes 121.6 kB → 131.4 kB
(43.2 kB → 46.8 kB gzipped) — the Code screen's own code — and CodeMirror lands in a separate
564.99 kB chunk (200.95 kB gzipped) that is fetched the first time the sheet is opened and never
on any other page. CSS goes 35.9 kB → 37.9 kB.

The precedent is the part that matters: a heavy widget is allowed, in its own module, behind a
dynamic import, with its bundle delta recorded. The eleven packages are also eleven supply-chain
entries on a page the owner edits their own code in; they move together and are updated together.
