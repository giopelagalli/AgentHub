#!/bin/sh
# Worker tier on the 7900XTX: the llama-server command from deploy/amd/README.md.
# `exec` so the daemon's SIGTERM reaches the server itself, not a shell wrapping it.
exec "${LLAMA_SERVER:-llama-server}" \
  -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL \
  --port 8001 --n-cpu-moe 12 --ctx-size 65536 \
  --parallel 4
