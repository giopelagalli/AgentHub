# 0020 — A shared node serves one model at the owner's priority; guests get what is left
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
Members will borrow the owner's nodes. Model weights cannot be swapped per user, and the owner must not notice a guest.

## Options
- A — per-user model switching on a shared node: reloads take minutes; why not.
- B — equal priority for all: the owner's assistant would wait behind guests; why not.
- C (chosen) — one model per node (the owner's); vLLM priority tiers owner assistant 0, owner agents 10, guest assistant 15, guest agents 20; each member brings a cloud key, the admin may lend the hub's under a cap.

## Decision
PRD D3 / FR-D7, FR-F3–F4.

## Consequences
llama.cpp nodes cannot prioritise; sharing them is first-come. Batched decoding means guests cost the owner little until the KV cache is full.
