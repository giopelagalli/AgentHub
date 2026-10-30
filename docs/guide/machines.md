# Machines

## Nodes

**Machines → Nodes** lists nodes with status, the model per tier and active streams, with the cloud
spend over them; the job queue is under **Machines → Queue**.

The Spark is configured in `configs/spark.yaml` in *attach mode*: the daemon does not start a
model server, it attaches to the vLLM that `sparkmodel.service` already runs on `:8888`, checks
it answers, and registers both tiers with `priority: 10` and small stream caps (2 orchestrator,
3 worker) because the KV cache is shared with JD.

**Adding a node.** Press **Add machine** above the list. The hub mints a one-time token — good for
24 hours, usable once — and shows the command it belongs to:

```
curl -fsSL http://<hub>/install.sh | sh -s -- --hub http://<hub> --token <token>
```

Copy it, run it on the machine you're adding, and you're done: it installs the node daemon, fetches
the hub's own source (the machine never needs repo access), enrolls the node under your account,
and starts it under systemd or launchd. The node appears in the table within a minute. Re-running
the command on a machine that's already a node updates it in place and rotates its token.

Each node gets its own bearer token, which is why the **Owner** column exists: a node's token works
only for that node — it can register, heartbeat and report on its own jobs, and nothing else. The
hub stores only a hash of it, so the plaintext exists once, in the reply to the installer. **Remove**
deletes the token along with the node, so a removed daemon cannot come back on its own.

The manual way is still there as a fallback: install Node 22, clone the repo, write a config from
the examples in `configs/` (`amd.yaml` for the 7900 XTX, `macbook.yaml`, `macmini.yaml` for the
browser node), set `DAEMON_TOKEN` to the hub's shared token, and run
`npx tsx packages/node-daemon/src/main.ts <config>` under a service; the per-machine playbooks are
in `deploy/`. `DAEMON_TOKEN` remains the admin's break-glass and works for every node.

A node's **⋯ → Drain** stops new jobs, turns and browser leases from landing on a node while
whatever it's already running finishes, and **Undrain** reverses it. **Remove** forgets the node
outright — its daemon exits once the hub tells it so — so getting it back means re-running its
service or install.

**⋯ → Pause models** is the narrower lever: the node stays online, keeps heartbeating and keeps
claiming jobs, but the model gateway stops picking its serving endpoints, so chat and agent turns go
elsewhere. **Resume models** puts them back. Use it to stop generating on a local model without
taking the machine offline; use **Drain** when the machine should take no work at all. With every
local model paused, projects set to Auto fall through to the cloud tier, subject to
`MAX_CLOUD_USD_PER_DAY`, while projects set to Local fail with "no capacity … (local models paused)"
rather than spend.

A node is *offline* when its heartbeats stop; the hub requeues its jobs and routes around it.

The one-command installer is `curl -fsSL <hub>/install.sh | sh -s -- --hub <hub> --token <token>`,
with the token minted by *Add machine* in Machines → Nodes. It detects the machine, installs Node 22
if it has to, fetches the daemon from the hub (no clone, no repo access), attaches to an
OpenAI-compatible server that is already listening or picks the recipe for the hardware class —
registering compute-only when no recipe is verified for it yet — writes `~/.agenthub/node.yaml`,
enrolls, and starts the daemon under launchd or systemd. Re-running the same command updates the
node in place; `--uninstall` reverses it. `--dry-run` prints the whole plan without touching the
machine, which is the quickest way to see what a given box would become. The flags, the recipe
table and everything it writes are in `deploy/README-install.md`.

## The browser pool (Machines → Browser)

A browser node (the Mac mini) runs one browser with several isolated sessions — *slots* — set by
`browser.slots` in its daemon config (default 1, at most 8). Agents *lease* a slot for a task and
release it. A project holds one slot at a time: its manager and employees share it, so several
projects browse at once and nobody in a project waits for a colleague. A slot that passes to a
different project starts over in a fresh, empty session, so nothing of the last project carries
over. When every slot is taken,
requests wait in line (manager before employee) and get the next slot that frees up.

**Machines → Browser** has a tile per slot: the node and slot number, who holds it and for how
long, and a live thumbnail. A free slot stays quiet. **Watch** shows a slot large at the top;
**Take control** takes that slot for you (its holder's next action fails, other slots carry on);
**Release** gives a slot back. **Drain** on a browser node stops it handing out slots — current
holders finish — and **Remove** takes its slots away. A browser node that misses heartbeats keeps
its holders' leases until they run out. Pausing models doesn't affect the browser.
Recordings of each session are kept under the data root, one per lease.
