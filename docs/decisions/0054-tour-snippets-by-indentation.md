# 0054 — A tour step's snippet ends where its indentation says the block ends
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
A tour step (FR-B6) is a `path:line` from the code map. The map names where something starts, not
where it ends, but the explanation has to be about a definite set of lines — the hub caches against
them and the UI tints them. Something has to turn "line 412" into "lines 412–447" for every
language a project might be written in.

## Options
- A — parse the file (TypeScript's compiler API, tree-sitter grammars). Exact for the languages it
  knows and nothing for the rest; a parser per language on the hub, and another on the UI so the
  two agree on the lines.
- B — a fixed window (the line and the next 30). No grammar, but it cuts functions in half and runs
  into the next one.
- C (chosen) — indentation: from the line to the first blank line whose next non-blank line is
  indented no deeper than the starting line; also stop before a line indented *less* than the start,
  at the end of the file, and after 60 lines.

## Decision
`tourSnippet(text, line)` in `packages/shared/src/tour.ts` (exported as `@agenthub/shared/tour`). A
blank line inside a function is followed by its own deeper body, so it does not stop; the blank
after the closing brace is followed by the next declaration at the same depth, so it does. A method
at the end of a class stops before the class's closing brace. The 60-line cap is `SNIPPET_MAX_LINES`:
a longer block is shown from its start, which is where the explanation starts anyway. A line past
the end of the file returns null, and the route says the map may be out of date.

`tourSteps(markdown)` sits beside it: every `` `path:line` `` span of the map in document order, the
same regex the renderer links (0046), fenced blocks skipped, a repeat visited once, the item's own
words (reference and list marker removed) as the title.

## Consequences
One pure module the hub and the UI both import, so the snippet the UI tints is byte for byte the
snippet the guide explained and the cache is keyed on. It is wrong in known ways: a function with no
blank line before the next one runs on into it (up to the cap), and a comment dedented inside a body
stops it early. The map can always point at a better starting line, and a parser can replace the
heuristic behind the same signature if a project needs it.
