# 0018 — Media renders on the 7900 XTX via ComfyUI; MiniMax-H3 stays out
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The owner wants image and video generation. H3 was the original video model; it does not fit next to Flash-Next on the Spark, and on AMD it has a ROCm noise bug and a license that excludes US use.

## Options
- A — H3 on the Spark: no memory beside the model server; why not.
- B — H3 on AMD after fixing the ROCm bug (owner: 'or we just fix it'): the bug is fixable upstream, the license is not ours to fix; why not, for now.
- C (chosen) — Qwen-Image for stills, Wan 2.2 or LTX-2 for video, via ComfyUI on the 7900 XTX; H3 revisited if the license changes or a second Spark exists.

## Decision
PRD D5 / FR-E1–E4. The license text is to be re-read before Phase E.

## Consequences
Owner accepted the recommendation with the ROCm caveat noted.
