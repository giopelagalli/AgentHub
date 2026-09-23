# The node installer

One command turns a Mac or Linux box into an AgentHub node (PRD FR-D2):

    curl -fsSL <hub>/install.sh | sh -s -- --hub <hub> --token <enrollment-token>

Mint the enrollment token on the hub's **Cluster** page (*Add node*); it is one-time and expires
after 24 hours. The node needs no repo access and no clone — the hub serves both the script
(`GET <hub>/install.sh`) and the daemon source (`GET <hub>/install/agenthub-src.tgz`), the latter
gated by that same enrollment token on a first install, or the node's own token on an update.

Re-running the same command **updates in place**: it refetches the daemon, re-reads the hardware,
rewrites the config and restarts the service, but does not enroll again. `--uninstall` reverses
everything the script did.

## What it does, in order

1. **Detect** — OS (Darwin/Linux), arch (`arm64`/`x64`), memory, GPU class, and whether Tailscale
   is up. All of it goes to the hub as the node's `hardware` at enrollment.
2. **Node.js** — anything 20 or newer is left alone. Otherwise: Homebrew `node@22` on macOS,
   NodeSource 22 (via `sudo`) on Linux. With neither available it prints the manual instruction
   and exits 2.
3. **Fetch** — downloads and unpacks the daemon into `~/.agenthub/src`, keeping the previous copy
   as `src.prev` for one rollback, then installs its dependencies (native modules may compile for
   a minute).
4. **Serving** — probes `127.0.0.1` on ports 8888, 8000, 8001, 8080, 11434 and 1234 for an
   OpenAI-compatible `/v1/models`, and otherwise picks the recipe for the hardware class (below).
   It never downloads a model without a confirmation or `--yes`.
5. **Config** — writes `~/.agenthub/node.yaml` (mode 0600) and prints it with the token masked.
6. **Enroll** — `POST <hub>/api/nodes/enroll`, and writes the node token the hub returns into the
   config. If the name is taken, it exits and says to mint a fresh token and re-run with `--name`.
7. **Service** — a launchd agent on macOS, a systemd user unit on Linux, both set to start at
   login/boot and restart on failure.
8. **Verify** — watches the log for up to 60 s and prints `Node "<name>" is up.` once the daemon
   reports in.

Every step prints one `==> ` line, so the transcript is the record of what happened.

## Flags

| flag | meaning |
|---|---|
| `--hub URL` | the hub to enroll with and fetch from. **Required.** |
| `--token TOKEN` | the one-time enrollment token. Required unless this machine is already enrolled (a `node.yaml` with a `hubToken`), in which case the run is an update. |
| `--name NAME` | the node's name. Default: the Tailscale DNS name's short hostname when Tailscale is up, otherwise the system hostname, lowercased and reduced to `[a-z0-9-]`. |
| `--recipe R` | `none`, `attach`, `llama-metal`, `llama-hip` or `vllm`. Default `auto` — see the table below. |
| `--yes` | answer every prompt yes. Needed for an unattended run, since `curl … \| sh` has no terminal on stdin. |
| `--dry-run` | print every action and change nothing. Detection and the port probe still run; they only read. |
| `--uninstall` | stop and remove the service, then remove `~/.agenthub` (asks first unless `--yes`). |

`AGENTHUB_HOME` overrides the install directory (default `~/.agenthub`).

## Recipes (FR-D3)

Picked automatically unless `--recipe` says otherwise. A class is listed here only once it has
been verified by hand on that hardware; everything else registers **compute-only**, which is a
useful node — it runs shell jobs, it just serves no model.

| hardware class | what the installer does |
|---|---|
| any, with an OpenAI-compatible server already listening | **attach** — a `worker` entry per server that answered, plus an `orchestrator` entry when it is the only one; `maxStreams: 2`, no `cmd` (the daemon health-checks and registers it, never starts or stops it) |
| `apple-silicon-*`, 40 GB or more | **llama-metal** — `brew install llama.cpp` and a `launch-worker.sh` running `llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL --port 8001 --ctx-size 32768 --parallel 2` |
| `apple-silicon-*`, under 40 GB | compute-only. No verified recipe at this memory size yet. |
| `amd-*`, with `llama-server` on `PATH` | **llama-hip** — a `launch-worker.sh` around the HIP build, per `deploy/amd/README.md` |
| `amd-*`, without it | compute-only. The HIP build of llama.cpp is a manual step (`deploy/amd/README.md`); re-run with `--recipe llama-hip` afterwards. |
| `nvidia-*` | compute-only, with a pointer to the vLLM playbook (`deploy/spark/README.md`). Start vLLM by hand, then re-run with `--recipe attach`. |
| `cpu` | compute-only. |

The Apple Silicon class is keyed on total RAM (`apple-silicon-24`) because the GPU addresses all
of it; the NVIDIA and AMD classes are keyed on VRAM (`nvidia-24`, `amd-24`).

## What it writes where

| path | what |
|---|---|
| `~/.agenthub/node.yaml` | the daemon config, mode 0600. Rewritten on every run; the previous one is kept as `node.yaml.prev`. |
| `~/.agenthub/src/` | the daemon source and its `node_modules`. |
| `~/.agenthub/src.prev/` | the previous source tree, for one rollback. |
| `~/.agenthub/workspace/` | `workspaceRoot` — where shell-task jobs run. |
| `~/.agenthub/node.log` | the daemon's stdout and stderr. |
| `~/.agenthub/launch-worker.sh` | only for the `llama-metal` and `llama-hip` recipes. |
| `~/Library/LaunchAgents/ai.agenthub.node.plist` | macOS service. |
| `~/.config/systemd/user/agenthub-node.service` | Linux service (plus `loginctl enable-linger`, so it survives logout). |

Because the config is rewritten on every run, hand edits to `node.yaml` (a `video:` block,
`hubCandidates:`, a `priority:` on a serving entry) do not survive an update — reapply them from
`node.yaml.prev`, or manage that node from the repo the way the per-machine playbooks in
`deploy/` do.

## Updating and uninstalling

    # update: same command, no token needed
    curl -fsSL <hub>/install.sh | sh -s -- --hub <hub> --yes

    # uninstall
    curl -fsSL <hub>/install.sh | sh -s -- --uninstall --yes

Uninstalling stops and removes the service and deletes `~/.agenthub`. It does not touch the hub's
record of the node — use **Remove** on the Cluster page for that.

## Checking the script

    sh -n deploy/install.sh          # syntax
    shellcheck -s sh deploy/install.sh
    sh deploy/install/test.sh        # dry-run smoke tests

`deploy/install/test.sh` runs the installer with `--dry-run` and greps for the lines each path
must print — the full plan, the per-OS service, the attach path (against
`deploy/install/fake-openai-server.py` on port 8001), argument errors, the update path and
uninstall. It asserts that `--dry-run` creates no `AGENTHUB_HOME` and that no token is ever
echoed. It is deliberately outside vitest: it tests a shell script, and a node must be
installable without the repo's test tooling.

## Why `--omit=dev` is enough

The daemon runs from TypeScript source (`packages/node-daemon/src/main.ts`) through `tsx`, which
the repo declares as a root **runtime** dependency for exactly this reason (the hub's own service
units run through it too). So `npm ci --omit=dev` installs everything a node needs and skips the
test tooling (vitest, typescript, vite). The script fails loudly if `tsx` is missing after the
install rather than leaving a node that looks enrolled but never comes up.
