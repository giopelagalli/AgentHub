# 0034 — The code map is a docs page, and `path:line` is the link format
Date: 2026-09-24
Decided by: senior-coder
Status: accepted

## Context
FR-B5 wants a map into the codebase, written by the manager when a milestone lands and refreshable
from the Code screen. FR-B6's tour then steps through that map. Where the map lives, and what a
"link" in it is, decides how much of the tour is already built.

## Options
- A — a generated artefact of its own (a `code-map.yaml`, a table in the manifest). A second
  document format, a second writer, a second reader, and nothing else in the bundle looks like it.
- B — a section inside `project.md`. It would be rewritten by `update_project_md` on unrelated
  turns, and the charter is not a map.
- C (chosen) — `docs/code-map.md`, an ordinary docs page, written by an ordinary doc tool.

## Decision
`write_code_map(markdown)` writes `docs/code-map.md` through `ProjectBundle.writeDoc`, so it is
linked from `docs/index.md`, committed, readable with `read_bundle`, and visible in the Docs sheet
like any other page. It is on the belt of every orchestrator turn, and the planning rules say to
refresh it once `complete_milestone` returns done. *Refresh map* runs the same job as a one-off
manager-shaped task (`POST /api/projects/:slug/code/map`) for when the owner does not want to wait
for a milestone.

A link is a `` `path:line` `` code span. `renderMarkdown` turns a span that matches
`<path with an extension>:<line>` into `<a class="md__ref" data-path data-line>`, and nothing else —
`` `npm test` `` and `` `Note:12` `` stay code. There is no `href`: the anchor opens the viewer in
this app, and a real URL would be a broken link everywhere else this markdown renders.

## Consequences
The map costs no new storage, no new route to read it (the docs page route already serves it) and no
new renderer. The tour inherits the whole navigation seam: a step is a `path:line` the viewer
already knows how to open. The page is also the freshness signal the Code button shows — the docs
listing already carries each page's `updatedAt`.

The cost is that the map is as good as the last agent to write it, and a stale map looks exactly
like a current one apart from its timestamp. That is why the button shows the age.
