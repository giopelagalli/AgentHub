# 0049 — happy-dom for the UI's DOM tests, scoped per file
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
The UI's tests run in node and nothing that needs a DOM has been tested. The docs shell's review
found bugs that live only in its DOM wiring — the rail, the pager, the filter box, the observers
it must disconnect, a callout title that must stay escaped — and pure tests cannot reach them.

## Options
- A — no DOM tests: keep testing only the pure helpers; the shell's wiring stays unchecked; why not.
- B — jsdom: the established choice, but heavier to install and slower to start, for a handful of
  component tests; why not.
- C (chosen) — happy-dom as a devDependency of `packages/ui`, selected with a
  `// @vitest-environment happy-dom` docblock in each file that needs it.

## Decision
happy-dom, opted into per file rather than set as the workspace's test environment, so the
hub's and the UI's pure tests keep running in plain node. Layout-driven APIs
(`IntersectionObserver`, `ResizeObserver`) are stubbed in the test and their callbacks fired by
hand; happy-dom does no layout, so nothing about real geometry is asserted.

## Consequences
DOM components can now be tested (first: `test/docshell.dom.test.ts`). One more devDependency.
Behaviour that depends on real layout or scrolling still needs the browser to check.
