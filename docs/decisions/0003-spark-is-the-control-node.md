# 0003 — The DGX Spark hosts the hub
Date: 2026-09-21
Decided by: owner
Status: accepted

## Context
The original plan made the Mac mini the control node with a tailnet alias for switching. The Spark is the one always-on box and already runs JD and the model server.

## Options
- A — Mac mini as hub, Spark as a node: two machines must be up for anything to work; why not.
- B — the droplet as hub: state off-site, every turn crosses the internet; why not.
- C (chosen) — hub, daemon, JD and the model on the Spark; the mini joins later as the browser node.

## Decision
Hub and node daemon run on the Spark under systemd user units; `configs/spark.yaml` points at `127.0.0.1:4000`. The control-node switch machinery stays as the migration path.

## Consequences
One box to keep alive. The Spark's memory and KV cache are shared by JD, the model and agent work; caps and priority tiers exist because of this.
