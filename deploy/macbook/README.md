# MacBook node playbook (M4 Pro, ephemeral worker)

Worker-tier inference, joins and leaves the cluster at will — this node is
not expected to stay up. llama.cpp server via Metal.

## Model

A Qwen3.6-27B GGUF, Q4_K_M quant.

    llama-server -hf <org>/Qwen3.6-27B-GGUF:Q4_K_M --port 8001 --parallel 2

`maxStreams: 2` in the daemon config matches `--parallel 2` above — keep
them in sync.

## Daemon config

`configs/macbook.yaml` (checked into the repo) — copy it to the machine and
fill in the tailnet host and workspace path:

    node: { name: macbook, arch: arm64 }
    hub: http://<control-node-tailnet-name>:4000
    advertiseHost: <macbook-tailnet-name>
    serving:
      - tier: worker
        model: Qwen3.6-27B-GGUF
        port: 8001
        maxStreams: 2
        cmd: ["./launch-worker.sh"]
    jobTypes: ["shell-task"]
    workspaceRoot: /Users/<you>/agenthub-workspace

## launchd plist (sketch)

    <!-- ~/Library/LaunchAgents/com.agenthub.node.plist -->
    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict>
      <key>Label</key><string>com.agenthub.node</string>
      <key>ProgramArguments</key>
      <array>
        <string>npx</string><string>tsx</string>
        <string>packages/node-daemon/src/main.ts</string>
        <string>configs/macbook.yaml</string>
      </array>
      <key>WorkingDirectory</key><string>/Users/<you>/AgentHub</string>
      <key>RunAtLoad</key><true/>
    </dict></plist>

    launchctl load ~/Library/LaunchAgents/com.agenthub.node.plist

## Closing the lid

Sleep stops the daemon's process, which means it stops heartbeating. After
three missed heartbeats (~15s) the hub marks `macbook` offline and re-queues
any of its in-flight jobs to another node with the required capability
(spark or amd); if none is free, jobs wait in the queue until a worker
frees up. Nothing is lost — reopening the lid re-registers the node and it
resumes claiming new jobs.
