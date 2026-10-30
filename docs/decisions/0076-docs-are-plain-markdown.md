# 0076 — Docs are plain markdown; no HTML docs site
Date: 2026-10-30
Decided by: owner
Status: accepted

## Context
A GitBook-style HTML site (`docs/site/`, published as an Artifact) was built on 2026-10-06 as a
view over the records, kept in sync by a documenter agent and a Stop hook. No agent read it, every
sync was a slow hand edit of a 430 KB file, and it drifted. The owner asked for the agent setup to
be as fast as possible.

## Options
- A — keep the site and generate it from the records with a script: no drift, but still a second
  copy that only the owner reads, and a build to maintain.
- B — per-agent notes files: splits what's known; a coder wouldn't see what the designer learned.
- C (chosen) — one shared set of markdown files per project that every agent reads: root
  `CLAUDE.md`, `docs/ROADMAP.md` (Now/Next), `docs/CHANGELOG.md` (one line per merge),
  `docs/ARCHITECTURE.md`, `docs/decisions/`.

## Decision
The markdown is the only record. GitHub renders it, and Mermaid diagrams cover the visual parts.
The roadmap's Done list moved to the changelog, which only the main session edits at merge, so
parallel branches no longer conflict on it.

## Consequences
- `docs/site/` and the documenter agent are gone; the published Artifact is a stale snapshot.
- The owner browses docs on GitHub or in the editor instead of a designed site.
