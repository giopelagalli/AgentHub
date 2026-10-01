# 0061 — Stills take the same GPU slot as clips
Date: 2026-10-01
Decided by: senior-coder
Status: accepted

## Context
A `video-gen` claim acquires the node's one media slot: worker serving is parked and drained, the
daemon switches to its `video` profile, and it is all handed back when the job settles. `image-gen`
is new; it runs on the same ComfyUI on the same 24 GB 7900 XTX that serves the worker model.

## Options
- A — let stills skip the slot: a minute-long Qwen-Image render next to a resident worker model on 24 GB is an OOM or a crawl; why not.
- B — a separate image slot: two diffusion jobs on one card at once; why not.
- C (chosen) — `isMediaJob` (image-gen, video-gen) everywhere the hub said `video-gen` about the
  slot: claim gating, acquire, release, restore, and the control switch's "something is rendering".

## Decision
C. One media job per node at a time, both kinds through the same swap.

## Consequences
A burst of stills swaps the worker out and back per image; if that proves slow on the PC, the
next step is keeping the slot across back-to-back media jobs, not skipping it.
