# AMD node playbook (7900XTX, Linux)

Worker-tier inference overflow. llama.cpp server via the HIP (ROCm) build —
vLLM's ROCm support is second-class on RDNA3, so llama.cpp is the serving
stack here, not vLLM.

## Model

`unsloth/Qwen3.6-35B-A3B-GGUF`, UD-Q4_K_XL quant (~23GB, ~65 tok/s on the
7900XTX's 24GB). For 64K context, offload some MoE experts to CPU with
`--n-cpu-moe 12` to keep the KV cache in VRAM.

    ./llama-server \
      -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL \
      --port 8001 --n-cpu-moe 12 --ctx-size 65536 \
      --parallel 4

## Video generation: not enabled

The AMD node does not serve `video-gen` in v1. ComfyUI on RDNA3 hits a
known noise bug (Comfy-Org/ComfyUI#15314); this node stays worker-only
until that's fixed upstream. Do not add `video-gen` to `jobTypes` here.

## Daemon config

`configs/amd.yaml` (checked into the repo) — copy it to the node and fill
in the tailnet host and workspace path:

    node: { name: amd, arch: x64 }
    hub: http://spark-f9a9:4000
    advertiseHost: <amd-tailnet-name>
    serving:
      - tier: worker
        model: unsloth/Qwen3.6-35B-A3B-GGUF
        port: 8001
        maxStreams: 4
        cmd: ["./launch-worker.sh"]
    jobTypes: ["shell-task"]
    workspaceRoot: /home/<you>/agenthub-workspace

`deploy/amd/launch-worker.sh` (in the repo; copy it next to the config and
`chmod +x`) wraps the `llama-server` command above with `exec` so `SIGTERM`
reaches the server when the daemon stops it. Set `LLAMA_SERVER` if the binary
is not on `PATH`.

## systemd unit (sketch)

    # /etc/systemd/system/agenthub-node.service
    [Unit]
    Description=AgentHub node daemon (amd)
    After=network-online.target tailscaled.service

    [Service]
    WorkingDirectory=/home/<you>/AgentHub
    ExecStart=/usr/bin/npx tsx packages/node-daemon/src/main.ts configs/amd.yaml
    Restart=on-failure
    User=<you>

    [Install]
    WantedBy=multi-user.target

    sudo systemctl enable --now agenthub-node
