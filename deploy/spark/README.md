# DGX Spark node playbook (Phase 1)

The Spark runs one vLLM that the node daemon attaches to — see "Current
layout" right below. The two-instance layout further down (orchestrator +
worker tiers, each with its own vLLM) was the original plan, kept here for
reference; it does not fit in memory. Stock vLLM does not support GB10
(sm_121) — use NVIDIA's NGC container.

## Current layout (2026-09): one vLLM, attach mode

The box actually runs a single Qwen3.8-Flash-Next vLLM on `:8888`
(`sparkmodel.service`, the MiaAI-Lab single-DGX-Spark recipe), shared with the
owner's Telegram assistant. Both AgentHub tiers attach to that one server
instead of launching their own, each with `priority: 10` so agent traffic
yields to the assistant. `configs/spark.yaml` is the live config. The
two-instance layout below (8001/8002) was the original plan and does not fit
in memory — see `docs/spark-setup.md`.

## Install on the box (hub + daemon under systemd)

Clone to `~/AgentHub`, `npm install && npm run build:ui`, write `configs/hub.env`
(`PORT`, `HUB_HOST=0.0.0.0`, `DATA_ROOT`, `HUB_PASSWORD`, `HUB_SESSION_SECRET`,
`DAEMON_TOKEN`, `FIREWORKS_API_KEY`), run both by hand once, then:

    mkdir -p ~/.config/systemd/user
    cp deploy/spark/agenthub-hub.service deploy/spark/agenthub-node.service ~/.config/systemd/user/
    sudo loginctl enable-linger $USER
    systemctl --user daemon-reload
    systemctl --user enable --now agenthub-hub agenthub-node
    systemctl --user status agenthub-hub agenthub-node --no-pager

The daemon exits if vLLM is not answering within 15 s and systemd restarts it
every 15 s, so a reboot (vLLM takes ~10 min) sorts itself out.

## Worker tier — Qwen3.6-35B-A3B NVFP4 (official recipe) (original two-instance plan, unused)

    docker run --gpus all --ipc=host -p 8001:8000 \
      nvcr.io/nvidia/vllm:26.05-py3 \
      vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4 \
        --gpu-memory-utilization 0.5 --kv-cache-dtype fp8 \
        --enable-prefix-caching --async-scheduling --max-num-seqs 48 \
        --reasoning-parser qwen3 --tool-call-parser qwen3_xml

## Orchestrator tier — Qwen3.8-Flash-Next NVFP4 (single-Spark recipe) (original two-instance plan, unused)

Follow https://github.com/blazux/qwen3.8-Flash-DGX with the
RadixArk/Qwen3.8-Flash-Next-NVFP4 checkpoint (n-gram table mmap'd from NVMe;
~76 GiB resident). Serve on port 8002 with --max-num-seqs 4. Known caveats
(as of 2026-09): non-deterministic greedy decode (vllm persistent_topk on
GB10), coherence loss near 100k context with fp8 KV cache. Fallback: point
the orchestrator tier at a second Qwen3.6-35B-A3B instance instead — the
daemon config makes this a one-line change.

## Daemon config for the Spark (configs/spark.yaml on that machine)

    # DGX Spark: the hub's own box. Both tiers attach to the vLLM that sparkmodel.service already
    # runs on :8888 (one model, one server — there is no memory for a second; see docs/spark-setup.md
    # and deploy/spark/README.md). No `cmd`: the daemon health-checks and registers, never starts or
    # stops it.
    node:
      name: spark
      arch: arm64
    # The hub runs on this machine, and the vLLM is bound to localhost — so no advertiseHost: the
    # endpoint registers as 127.0.0.1:8888, which is the address the hub can actually dial.
    hub: http://127.0.0.1:4000
    heartbeatMs: 5000
    # `priority: 10` = vLLM request priority (lower is served sooner). The Spark also answers the
    # owner's Telegram assistant, which sends none (0, the front of the line); agents yield to it.
    # Needs the server started with `--scheduling-policy priority`, or non-zero values are a 400.
    # maxStreams is small on purpose: ~1M tokens of KV are shared with the assistant.
    serving:
      - tier: orchestrator
        model: qwen3.8-flash-next
        port: 8888
        maxStreams: 2
        priority: 10
      - tier: worker
        model: qwen3.8-flash-next
        port: 8888
        maxStreams: 3
        priority: 10
    # No video-gen: a video model does not fit next to Flash-Next (docs/spark-setup.md §4).
    jobTypes: ["shell-task"]
    workspaceRoot: /home/giospark1/agenthub-workspace
    claimIntervalMs: 1000

There are no launch scripts in attach mode — the daemon only health-checks
and registers `:8888`. There's no `advertiseHost`: the hub runs on this box
and the vLLM is bound to localhost, so the endpoint registers as
`127.0.0.1:8888`, the address the hub can dial. `video-gen` is off on this
node — a video model doesn't fit next to Flash-Next (`docs/spark-setup.md`).

## Video generation (ComfyUI + MiniMax-H3)

The `video-gen` job type is executed by the daemon against a ComfyUI instance
running on the Spark itself. Add to `configs/spark.yaml`:

    video:
      comfyUrl: http://127.0.0.1:8188
      workflow: /home/<you>/AgentHub/deploy/spark/minimax-h3-t2v.json

`comfyUrl` may also come from the `COMFY_URL` env var. `workflow` defaults to
the repo's own `deploy/spark/minimax-h3-t2v.json`.

### Workflow template

`minimax-h3-t2v.json` is a ComfyUI **API-format** workflow (the "Save (API
format)" export, node-id keyed — not the editor's graph format) with four
nodes: loader → text encode → sampler → SaveVideo. The `_meta.title` of each
node documents its role. The daemon fills these placeholders before posting to
`/prompt`:

| placeholder      | from the job payload | note                              |
|------------------|----------------------|-----------------------------------|
| `{{prompt}}`     | `prompt`             | JSON-escaped                      |
| `{{mode}}`       | `mode`               | `t2v` \| `i2v` \| `ref2v`          |
| `{{duration}}`   | `durationSec`        | 4–15, substituted **unquoted**    |
| `{{aspect}}`     | `aspect`             | e.g. `16:9`                       |
| `{{resolution}}` | `resolution`         | `768p` \| `1080p`                  |
| `{{imagePath}}`  | `imagePath`          | empty string for `t2v`            |

The file is therefore not valid JSON until substituted. The `class_type` names
are the ones this recipe assumes; match them to the H3 node pack actually
installed on the box (`/object_info` lists them) and keep the placeholders and
the node-id wiring as they are — the executor only cares that the final node
produces a video output, which it downloads from `/view` into
`<workspace>/<project>/media/video/<jobId>.mp4`.

Steps/cfg (12 steps, low-res + SPAN upscale) follow the published Spark recipe;
a 15s 1080p clip takes roughly 12 minutes.

### Serving profiles (Spark exclusivity, PRD §4.3)

A video job needs the worker-tier vLLM parked. The daemon exposes named
profiles over serving entry names:

    serving:
      - name: worker-vllm
        tier: worker
        ...
      - name: orchestrator-vllm
        tier: orchestrator
        ...
    profiles:
      llm: [worker-vllm, orchestrator-vllm]
      video: [orchestrator-vllm]
    controlPort: 8131

The hub switches with `POST http://<spark>:8131/control/profile {"name":"video"}`
carrying `Authorization: Bearer $DAEMON_TOKEN`; the daemon stops the entries
outside the profile and starts the ones in it (both idempotent), and answers
with the active profile. Unknown profile → 404, missing/wrong token → 401. On a
node that also runs the browser server the control routes share its port.

### License note (PRD §11)

The MiniMax-H3 community license **excludes use in the US, EU, UK and South
Korea** without separate authorization from MiniMax, and requires "MiniMax H3"
attribution in commercial products. The owner acknowledges and owns this
decision. The 7900XTX becomes video-eligible once Comfy-Org/ComfyUI#15314
(RDNA3 noise) is fixed.
