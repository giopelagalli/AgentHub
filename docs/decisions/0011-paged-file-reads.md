# 0011 — `read_file`/`read_bundle` page long files instead of cutting at 8k; a reviewer without a report is not findings
Date: 2026-09-23
Decided by: orchestrator
Status: accepted

## Context
The reviewer got source files back truncated at 8,000 characters with no way to read the rest, burned its budget trying, and ended without a report — which the manager read as change requests and delegated non-existent fixes.

## Options
- A — raise the flat cap to 32k: still a dead end for a 50k file; why not.
- B — give the reviewer a shell tool: breaks read-only review; why not.
- C (chosen) — `fromLine`/`maxLines` paging with a 32k page cut at a line boundary and a marker naming the next `fromLine`; a reviewer that never reported is presented as 'NO findings to act on'.

## Decision
`READ_FILE_LIMIT = 32_000`, `Tool.selfCapped`; `verify.ts` distinguishes reported from unreported reviews; `complete_milestone` no longer says 'fix what is listed' for an unreported review.

## Consequences
Other tools keep the 8k flat cap. The reviewer's task text explains paging.
