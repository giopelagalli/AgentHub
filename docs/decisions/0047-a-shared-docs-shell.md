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
