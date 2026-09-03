# DGX Spark node playbook (Phase 1)

The Spark serves two vLLM instances (orchestrator + worker tiers) managed by
the node daemon. Stock vLLM does not support GB10 (sm_121) — use NVIDIA's NGC
container.

## Worker tier — Qwen3.6-35B-A3B NVFP4 (official recipe)

    docker run --gpus all --ipc=host -p 8001:8000 \
      nvcr.io/nvidia/vllm:26.05-py3 \
      vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4 \
        --gpu-memory-utilization 0.5 --kv-cache-dtype fp8 \
        --enable-prefix-caching --async-scheduling --max-num-seqs 48 \
        --reasoning-parser qwen3 --tool-call-parser qwen3_xml

## Orchestrator tier — Qwen3.8-Flash-Next NVFP4 (single-Spark recipe)

Follow https://github.com/blazux/qwen3.8-Flash-DGX with the
RadixArk/Qwen3.8-Flash-Next-NVFP4 checkpoint (n-gram table mmap'd from NVMe;
~76 GiB resident). Serve on port 8002 with --max-num-seqs 4. Known caveats
(as of 2026-09): non-deterministic greedy decode (vllm persistent_topk on
GB10), coherence loss near 100k context with fp8 KV cache. Fallback: point
the orchestrator tier at a second Qwen3.6-35B-A3B instance instead — the
daemon config makes this a one-line change.

## Daemon config for the Spark (configs/spark.yaml on that machine)

    node: { name: spark, arch: arm64 }
    hub: http://<control-node-tailnet-name>:4000
    advertiseHost: <spark-tailnet-name>
    serving:
      - tier: worker
        model: nvidia/Qwen3.6-35B-A3B-NVFP4
        port: 8001
        maxStreams: 48
        cmd: ["./launch-worker.sh"]
      - tier: orchestrator
        model: RadixArk/Qwen3.8-Flash-Next-NVFP4
        port: 8002
        maxStreams: 4
        cmd: ["./launch-orchestrator.sh"]
    jobTypes: ["shell-task", "video-gen"]
    workspaceRoot: /home/<you>/agenthub-workspace

launch-*.sh wrap the docker commands above with `exec` so SIGTERM reaches
docker. Memory split (0.5 worker / remainder orchestrator) is a starting
point — tune on the real box.

`jobTypes` includes `video-gen` because the Spark is the only node with
ComfyUI + MiniMax-H3 (spec §11) — video jobs only ever land here. `advertiseHost`
must be the Spark's own tailnet name (see ../tailscale.md), since the hub
tells the gateway to route agent traffic straight to it — not the control
node's name, and not `127.0.0.1`.
