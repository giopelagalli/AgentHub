# 0047 — One docs shell for Docs, the PRD and Help, fed by two markdown conventions
Date: 2026-09-24
Decided by: owner
Status: accepted

## Context
The owner found the rendered docs and the Help page flat, and pointed at a Docusaurus site as the
target: a sidebar of sections, breadcrumbs, an on-this-page list, callouts. Agents write the pages,
so the layout has to come from the markdown automatically, not from hand formatting.

## Options
- A — style each sheet separately: three layouts to keep in step; why not.
- B — adopt a docs generator (Docusaurus/VitePress) for project docs: a build step and a second
  site per project, outside the hub's single-page app; why not.
- C (chosen) — one `mountDocShell` component in the UI, used by the Docs sheet, the PRD sheet and
  the Help page; sections from a `section:` front-matter line, the on-page list from `##`/`###`,
  callouts from `:::info|tip|warning|danger` blocks in the existing escape-first renderer; agents
  are told the convention in one prompt line.

## Decision
The shell owns navigation and typography; the renderer stays escape-first; the Help guide is one
document whose `##` sections act as the sidebar's pages. Owner decision on the target look; the
conventions are the orchestrator's.

## Consequences
Every agent-written page lands in the layout with no formatting work. A light theme is a token
swap, not a rewrite. Pages without front matter fall under a default section.

## Implementation choices (added 2026-10-01, after review)
Made by the orchestrator and senior-coder while building the shell; recorded here rather than
under new numbers because they all follow from C.

- **Front matter, bare or fenced.** Agents write `section: Architecture` as a bare first line as
  often as inside `---` fences, so both are read. Bare lines are only taken as front matter when
  every one holds a known key (`section`, `title`). Otherwise a page that opens with
  "Status: draft" would lose that line, so any other key leaves the document untouched. Inside
  `---` fences any key is accepted, because the fences say it is metadata. Rejected: fences only,
  which drops the form agents actually write.
- **The Docs view fetches every page when the index lands**, not one page as it is opened. A page's
  rail group comes from its own front matter, so the rail cannot be drawn until every page is
  read; fetching lazily would reshuffle the sidebar under the reader. Docs bundles are a few short
  local files, so the cost is small. A reload keeps the previous text and overwrites it as fetches
  land, and a page not yet fetched shows a loading line rather than a blank.
- **The PRD is read section by section.** Its `##` headings are the shell's pages (`page` mode),
  which is also what the audit grades, and the completeness chips navigate to them. Editing still
  hands over the whole markdown: sections are a way to read the file, not to slice it.
- **The decision log and the code map are pinned under "Reference"**, last in the rail, whatever
  their own front matter says. They are looked up rather than read in order.
- **Callouts are split before rendering** (`splitCallouts` in `markdown.ts`), not parsed inside
  `renderMarkdown`. Each callout body goes through the unchanged escape-first renderer, so
  `renderMarkdown` and its guarantees stay untouched, and the only new markup is the wrapper.
  Rejected: teaching the line parser a nested block, which would put the escape rule at risk for
  one feature.
