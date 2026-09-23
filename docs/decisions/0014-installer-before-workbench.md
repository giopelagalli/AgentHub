# 0014 — The node installer moves ahead of the workbench; the PC joins through it
Date: 2026-09-23
Decided by: owner
Status: accepted

## Context
The plan ordered the workbench (preview, terminal, code) before the node network. The owner wants adding a machine to be 'pull and it's a node', starting with the PC.

## Options
- A — workbench first (my recommendation): daily-use value sooner, PC via hand-written YAML; why not.
- B — both in parallel: splits attention on the riskier auth work; why not.
- C (chosen) — enrollment + installer first, then the workbench.

## Decision
PRD D1; `configs/amd.yaml` is no longer the path for the PC.

## Consequences
Owner override. Per-node tokens and ownership land earlier than accounts need them (0015).
