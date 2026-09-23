#!/bin/sh
# AgentHub node installer (PRD FR-D2/FR-D3). One command turns a Mac or Linux box into a node:
#
#     curl -fsSL <hub>/install.sh | sh -s -- --hub <hub> --token <enrollment-token>
#
# POSIX sh, no bashisms. Idempotent: re-running updates in place and skips enrollment.
# What it writes, and how to update or uninstall: deploy/README-install.md.
set -eu

AGENTHUB_HOME=${AGENTHUB_HOME:-$HOME/.agenthub}
SRC=$AGENTHUB_HOME/src
CONFIG=$AGENTHUB_HOME/node.yaml
LOG=$AGENTHUB_HOME/node.log
LAUNCH_SCRIPT=$AGENTHUB_HOME/launch-worker.sh
LABEL=ai.agenthub.node
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
UNIT=$HOME/.config/systemd/user/agenthub-node.service
PROBE_PORTS='8888 8000 8001 8080 11434 1234'
# The Apple Silicon llama.cpp recipe (FR-D3) is verified at 40 GB and up; below that the box
# registers compute-only rather than serving a model that leaves nothing for the machine's owner.
METAL_MIN_GB=40
SERVE_MODEL='unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL'

HUB=''
TOKEN=''
NAME=''
RECIPE=auto
ASSUME_YES=0
DRY_RUN=0
DO_UNINSTALL=0
NL='
'

usage() {
  cat <<'USAGE'
usage: install.sh --hub URL [--token TOKEN] [options]

  --hub URL          the AgentHub hub, e.g. https://hub.example.ts.net   (required)
  --token TOKEN      one-time enrollment token from the Cluster page's "Add node"
                     (required unless this machine is already enrolled)
  --name NAME        node name (default: this machine's Tailscale or system hostname)
  --recipe RECIPE    none | attach | llama-metal | llama-hip | vllm   (default: auto)
  --yes              never prompt
  --dry-run          print every action, change nothing
  --uninstall        stop and remove the service and ~/.agenthub
  -h, --help         this text

AGENTHUB_HOME overrides the install directory (default: ~/.agenthub).
USAGE
}

# ---------------------------------------------------------------- output + shell helpers

step() { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Run a command, or describe it under --dry-run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then info "[dry-run] $*"; return 0; fi
  "$@"
}

# write_file <path> <mode>, content on stdin.
write_file() {
  wf_path=$1
  wf_mode=$2
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] write $wf_path (mode $wf_mode):"
    sed 's/^/    | /'
    return 0
  fi
  mkdir -p "$(dirname "$wf_path")"
  ( umask 077; cat > "$wf_path" )
  chmod "$wf_mode" "$wf_path"
}

# The script is usually its own stdin (curl | sh), so prompts must come from the terminal.
confirm() {
  if [ "$ASSUME_YES" -eq 1 ]; then info "$1 [--yes]"; return 0; fi
  if [ "$DRY_RUN" -eq 1 ]; then info "[dry-run] would ask: $1"; return 0; fi
  if [ ! -r /dev/tty ]; then
    die "no terminal to ask \"$1\" - re-run with --yes"
  fi
  printf '    %s [y/N] ' "$1"
  read -r cf_reply < /dev/tty || cf_reply=n
  case "$cf_reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# First "<key>": "<value>" in a JSON blob. Splitting on commas keeps each match inside one field,
# which works for pretty-printed and compact JSON alike without needing jq on the node.
json_str() {
  printf '%s' "$2" | tr ',' '\n' \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

mask() {
  if [ -z "$1" ]; then printf '(none)'; return; fi
  if [ "${#1}" -le 12 ]; then printf '********'; return; fi
  printf '%s...%s' "$(printf '%s' "$1" | cut -c1-4)" "$(printf '%s' "$1" | tail -c 5)"
}

# Lowercase, and reduce to the [a-z0-9-] a node name may use.
slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-*//; s/-*$//'
}

# yaml_value <file> <top-level key>
yaml_value() {
  sed -n 's/^'"$2"'[[:space:]]*:[[:space:]]*//p' "$1" 2>/dev/null \
    | head -n 1 | sed 's/^"//; s/"$//'
}

# ---------------------------------------------------------------- arguments

need_val() { if [ -z "${2:-}" ]; then die "$1 needs a value"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --hub)        need_val "$1" "${2:-}"; HUB=$2; shift 2 ;;
    --hub=*)      HUB=${1#--hub=}; shift ;;
    --token)      need_val "$1" "${2:-}"; TOKEN=$2; shift 2 ;;
    --token=*)    TOKEN=${1#--token=}; shift ;;
    --name)       need_val "$1" "${2:-}"; NAME=$2; shift 2 ;;
    --name=*)     NAME=${1#--name=}; shift ;;
    --recipe)     need_val "$1" "${2:-}"; RECIPE=$2; shift 2 ;;
    --recipe=*)   RECIPE=${1#--recipe=}; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --uninstall)  DO_UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            usage >&2; die "unknown option: $1" ;;
  esac
done

case "$RECIPE" in
  auto|none|attach|llama-metal|llama-hip|vllm) ;;
  *) die "unknown --recipe $RECIPE (none|attach|llama-metal|llama-hip|vllm)" ;;
esac
HUB=${HUB%/}

# ---------------------------------------------------------------- uninstall

uninstall() {
  step "Uninstalling the AgentHub node"
  case "$(uname -s)" in
    Darwin)
      if [ -f "$PLIST" ] || [ "$DRY_RUN" -eq 1 ]; then
        run launchctl bootout "gui/$(id -u)/$LABEL" || true
        run rm -f "$PLIST"
        info "removed $PLIST"
      fi
      ;;
    Linux)
      if [ -f "$UNIT" ] || [ "$DRY_RUN" -eq 1 ]; then
        run systemctl --user disable --now agenthub-node.service || true
        run rm -f "$UNIT"
        run systemctl --user daemon-reload || true
        info "removed $UNIT"
      fi
      ;;
  esac
  case "$AGENTHUB_HOME" in
    ''|/|/home|/Users|"$HOME") die "refusing to remove $AGENTHUB_HOME" ;;
  esac
  if [ -d "$AGENTHUB_HOME" ] || [ "$DRY_RUN" -eq 1 ]; then
    if confirm "remove $AGENTHUB_HOME (config, daemon source, workspace, logs)?"; then
      run rm -rf "$AGENTHUB_HOME"
      info "removed $AGENTHUB_HOME"
    else
      info "kept $AGENTHUB_HOME"
    fi
  fi
  step "Done. Remove the node from the hub's Cluster page to forget it there too."
}

# ---------------------------------------------------------------- 1. detect

detect() {
  step 'Detecting this machine'
  OS=$(uname -s)
  case "$OS" in
    Darwin|Linux) ;;
    *) die "unsupported OS: $OS (Darwin and Linux only)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=x64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  if [ "$OS" = Darwin ]; then
    MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
    CPU_BRAND=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || printf 'unknown')
  else
    # MemTotal sits a little under the physical size (firmware reservations), so round up.
    MEM_GB=$(awk '/^MemTotal:/ { printf "%d", ($2 + 1048575) / 1048576 }' /proc/meminfo)
    CPU_BRAND=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n 1)
    if [ -z "$CPU_BRAND" ]; then CPU_BRAND=unknown; fi
  fi

  GPU_CLASS=cpu
  GPU_NAME=''
  VRAM_GB=0
  if [ "$OS" = Darwin ]; then
    case "$CPU_BRAND" in
      Apple*)
        # Unified memory: the GPU addresses all of it, so the class is keyed on total RAM.
        GPU_CLASS="apple-silicon-$MEM_GB"
        GPU_NAME=$CPU_BRAND
        VRAM_GB=$MEM_GB
        ;;
    esac
  elif have nvidia-smi; then
    nv=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -n 1 || true)
    if [ -n "$nv" ]; then
      GPU_NAME=$(printf '%s' "$nv" | cut -d, -f1 | sed 's/^ *//; s/ *$//')
      VRAM_GB=$(printf '%s' "$nv" | cut -d, -f2 | awk '{ printf "%d", ($1 + 512) / 1024 }')
      GPU_CLASS="nvidia-$VRAM_GB"
    fi
  fi
  if [ "$GPU_CLASS" = cpu ] && [ "$OS" = Linux ]; then
    amd_name=''
    if have rocm-smi; then
      amd_name=$(rocm-smi --showproductname 2>/dev/null \
        | sed -n 's/.*[Cc]ard [Ss]eries:[[:space:]]*//p' | head -n 1)
      if [ -z "$amd_name" ]; then
        amd_name=$(rocm-smi --showproductname 2>/dev/null \
          | sed -n 's/.*[Cc]ard [Mm]odel:[[:space:]]*//p' | head -n 1)
      fi
    fi
    if [ -z "$amd_name" ] && [ -d /opt/rocm ] && have lspci; then
      amd_name=$(lspci 2>/dev/null | grep -i 'vga\|display' | grep -i amd \
        | head -n 1 | cut -d: -f3- | sed 's/^ *//')
    fi
    if [ -n "$amd_name" ]; then
      GPU_NAME=$amd_name
      if have rocm-smi; then
        VRAM_GB=$(rocm-smi --showmeminfo vram --csv 2>/dev/null \
          | tr ',' '\n' | grep -E '^[0-9]{9,}$' | head -n 1 \
          | awk '{ printf "%d", ($1 + 536870911) / 1073741824 }')
      fi
      if [ -n "$VRAM_GB" ] && [ "$VRAM_GB" -gt 0 ] 2>/dev/null; then
        GPU_CLASS="amd-$VRAM_GB"
      else
        VRAM_GB=0
        GPU_CLASS=amd-unknown
      fi
    fi
  fi

  TS_DNSNAME=''
  if have tailscale; then
    ts_json=$(tailscale status --self --json 2>/dev/null || true)
    if [ -n "$ts_json" ]; then
      # Self comes before Peer in tailscale's JSON, so the first DNSName is this machine's.
      TS_DNSNAME=$(printf '%s' "$ts_json" \
        | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
      TS_DNSNAME=${TS_DNSNAME%.}
    fi
  fi
  HOST_NAME=$(hostname 2>/dev/null || uname -n)

  if [ -n "$TS_DNSNAME" ]; then
    ADVERTISE_HOST=$TS_DNSNAME
  else
    ADVERTISE_HOST=$HOST_NAME
  fi
  if [ -z "$NAME" ]; then
    if [ -n "$TS_DNSNAME" ]; then
      NAME=$(slug "${TS_DNSNAME%%.*}")
    else
      NAME=$(slug "${HOST_NAME%%.*}")
    fi
  fi
  if [ -z "$NAME" ]; then die 'could not derive a node name - pass --name'; fi

  HARDWARE_JSON=$(printf '{"os":"%s","arch":"%s","memGB":%s,"cpu":"%s","gpu":{"class":"%s","name":"%s","vramGB":%s},"host":"%s","tailnet":"%s"}' \
    "$OS" "$ARCH" "$MEM_GB" "$(json_escape "$CPU_BRAND")" "$GPU_CLASS" "$(json_escape "$GPU_NAME")" \
    "$VRAM_GB" "$(json_escape "$HOST_NAME")" "$(json_escape "$TS_DNSNAME")")

  info "os: $OS   arch: $ARCH   memory: ${MEM_GB} GB"
  if [ -n "$GPU_NAME" ]; then
    info "gpu class: $GPU_CLASS ($GPU_NAME)"
  else
    info "gpu class: $GPU_CLASS (no GPU found)"
  fi
  if [ -n "$TS_DNSNAME" ]; then
    info "tailscale: up - advertising $ADVERTISE_HOST"
  else
    info "tailscale: not detected - advertising $ADVERTISE_HOST"
  fi
  info "node name: $NAME"
}

# ---------------------------------------------------------------- 2. Node.js

ensure_node() {
  step 'Checking Node.js'
  node_major=0
  if have node; then
    node_major=$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')
    case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac
  fi
  if [ "$node_major" -ge 20 ]; then
    NODE_BIN=$(command -v node)
    info "node $(node -v) at $NODE_BIN - ok"
    return 0
  fi

  if [ "$node_major" -eq 0 ]; then
    info 'node is not installed'
  else
    info "node v$node_major is too old (need 20 or newer)"
  fi

  if [ "$OS" = Darwin ]; then
    if ! have brew; then
      info 'no Homebrew here. Install Node 22 from https://nodejs.org/en/download and re-run this script.'
      exit 2
    fi
    if ! confirm 'install Node 22 with "brew install node@22"?'; then
      die 'Node 22 is required'
    fi
    run brew install node@22
    if [ "$DRY_RUN" -eq 0 ]; then
      # node@22 is keg-only, so its bin directory is not linked into the Homebrew prefix.
      brew_node=$(brew --prefix node@22 2>/dev/null || true)
      if [ -n "$brew_node" ] && [ -x "$brew_node/bin/node" ]; then
        PATH=$brew_node/bin:$PATH
        export PATH
      fi
    fi
  else
    if ! have sudo; then
      info 'no sudo here. Install Node 22 (https://github.com/nodesource/distributions) and re-run this script.'
      exit 2
    fi
    if ! confirm 'install Node 22 from NodeSource (needs sudo)?'; then
      die 'Node 22 is required'
    fi
    if have apt-get; then
      if [ "$DRY_RUN" -eq 1 ]; then
        info '[dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -'
        info '[dry-run] sudo apt-get install -y nodejs'
      else
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
    elif have dnf || have yum; then
      if [ "$DRY_RUN" -eq 1 ]; then
        info '[dry-run] curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -'
        info '[dry-run] sudo dnf install -y nodejs'
      else
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
        if have dnf; then sudo dnf install -y nodejs; else sudo yum install -y nodejs; fi
      fi
    else
      info 'no apt-get/dnf/yum here. Install Node 22 (https://github.com/nodesource/distributions) and re-run this script.'
      exit 2
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then NODE_BIN='<node>'; return 0; fi
  have node || die 'node is still not on PATH after installing it'
  NODE_BIN=$(command -v node)
  info "node $(node -v) at $NODE_BIN"
}

# ---------------------------------------------------------------- 3. daemon source

fetch_src() {
  step "Fetching the daemon from $HUB/install/agenthub-src.tgz"
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$IS_UPDATE" -eq 1 ]; then
      info "[dry-run] curl -fsSL -H 'Authorization: Bearer $(mask "$NODE_TOKEN")' $HUB/install/agenthub-src.tgz | tar xz -C $AGENTHUB_HOME/src.new"
    else
      info "[dry-run] curl -fsSL '$HUB/install/agenthub-src.tgz?token=$(mask "$TOKEN")' | tar xz -C $AGENTHUB_HOME/src.new"
    fi
    info "[dry-run] swap $AGENTHUB_HOME/src.new into $SRC (the previous one is kept as $AGENTHUB_HOME/src.prev)"
    info "[dry-run] (cd $SRC && npm ci --omit=dev --no-audit --no-fund)"
    return 0
  fi
  rm -rf "$AGENTHUB_HOME/src.new"
  mkdir -p "$AGENTHUB_HOME/src.new"
  # A per-node bearer on an update (the installer's own credential, stronger than a one-time
  # token and the only one still valid), otherwise the enrollment token in the query string.
  src_tgz=$AGENTHUB_HOME/src.tgz.download
  rm -f "$src_tgz"
  if [ "$IS_UPDATE" -eq 1 ]; then
    code=$(curl -sSL -w '%{http_code}' -o "$src_tgz" -H "Authorization: Bearer $NODE_TOKEN" \
      "$HUB/install/agenthub-src.tgz" || true)
  else
    code=$(curl -sSL -w '%{http_code}' -o "$src_tgz" "$HUB/install/agenthub-src.tgz?token=$TOKEN" || true)
  fi
  if [ "$code" != 200 ]; then
    rm -f "$src_tgz"
    case "$code" in
      401) die "the hub refused the download: the enrollment token is invalid or used, or this node's token was revoked — mint a new token on the Cluster page" ;;
      '') die "could not reach $HUB" ;;
      *)  die "fetching the daemon source failed (HTTP $code)" ;;
    esac
  fi
  tar xz -C "$AGENTHUB_HOME/src.new" < "$src_tgz"
  rm -f "$src_tgz"
  # Tolerate a tarball packed with a single top-level directory.
  if [ ! -f "$AGENTHUB_HOME/src.new/package.json" ]; then
    inner=$(find "$AGENTHUB_HOME/src.new" -mindepth 2 -maxdepth 2 -name package.json | head -n 1)
    inner=${inner%/package.json}
    if [ -n "$inner" ] && [ -d "$inner/packages" ]; then
      mv "$inner" "$AGENTHUB_HOME/src.unwrap"
      rm -rf "$AGENTHUB_HOME/src.new"
      mv "$AGENTHUB_HOME/src.unwrap" "$AGENTHUB_HOME/src.new"
    fi
  fi
  if [ ! -f "$AGENTHUB_HOME/src.new/package.json" ]; then
    die 'the source tarball has no package.json at its root'
  fi
  rm -rf "$AGENTHUB_HOME/src.prev"
  if [ -d "$SRC" ]; then mv "$SRC" "$AGENTHUB_HOME/src.prev"; fi
  mv "$AGENTHUB_HOME/src.new" "$SRC"
  info 'installing dependencies (native modules may compile for a minute)'
  # --omit=dev is enough: tsx, which runs the daemon from source, is a root runtime dependency.
  ( cd "$SRC" && npm ci --omit=dev --no-audit --no-fund )
  if [ ! -x "$SRC/node_modules/.bin/tsx" ]; then
    die "tsx is missing from $SRC/node_modules - the daemon cannot start"
  fi
  info "daemon source in $SRC"
}

# ---------------------------------------------------------------- 4. serving recipe

probe_servers() {
  FOUND=''
  FOUND_COUNT=0
  for port in $PROBE_PORTS; do
    body=$(curl -s -m 2 "http://127.0.0.1:$port/v1/models" 2>/dev/null || true)
    case "$body" in *'"data"'*) ;; *) continue ;; esac
    model=$(json_str id "$body")
    if [ -z "$model" ]; then continue; fi
    FOUND="$FOUND$port|$model$NL"
    FOUND_COUNT=$((FOUND_COUNT + 1))
    info "found \"$model\" on port $port"
  done
}

# Worker entry per server that answered; the orchestrator tier too when it is the only one.
attach_entries() {
  printf '%s' "$FOUND" | while IFS='|' read -r port model; do
    if [ -z "$port" ]; then continue; fi
    printf '  - tier: worker%s    model: %s%s    port: %s%s    maxStreams: 2%s' \
      "$NL" "$model" "$NL" "$port" "$NL" "$NL"
    if [ "$FOUND_COUNT" -eq 1 ]; then
      printf '  - tier: orchestrator%s    model: %s%s    port: %s%s    maxStreams: 2%s' \
        "$NL" "$model" "$NL" "$port" "$NL" "$NL"
    fi
  done
}

choose_serving() {
  step 'Choosing a serving recipe'
  SERVING_YAML=''
  CHOSEN=none
  info "probing 127.0.0.1 ports $PROBE_PORTS for an OpenAI-compatible server"
  probe_servers
  if [ "$FOUND_COUNT" -eq 0 ]; then info 'no local model server answered'; fi

  want=$RECIPE
  if [ "$want" = auto ]; then
    if [ "$FOUND_COUNT" -gt 0 ]; then
      want=attach
    else
      case "$GPU_CLASS" in
        apple-silicon-*)
          if [ "$MEM_GB" -ge "$METAL_MIN_GB" ]; then want=llama-metal; else want=none; fi
          ;;
        amd-*)
          # The HIP build of llama.cpp is a manual step (deploy/amd/README.md).
          if have llama-server; then want=llama-hip; else want=none; fi
          ;;
        *) want=none ;;
      esac
    fi
  fi

  case "$want" in
    attach)
      if [ "$FOUND_COUNT" -eq 0 ]; then
        die 'no OpenAI-compatible server is listening - nothing to attach to'
      fi
      if [ "$FOUND_COUNT" -eq 1 ]; then
        info 'recipe: attach - one server, registered for both the orchestrator and worker tiers'
      else
        info "recipe: attach - $FOUND_COUNT servers, each registered for the worker tier"
      fi
      if confirm 'register the server(s) above?'; then
        SERVING_YAML=$(attach_entries)
        CHOSEN=attach
      else
        info 'skipped - registering compute-only'
      fi
      ;;
    llama-metal)
      if [ "$OS" != Darwin ]; then die '--recipe llama-metal needs macOS'; fi
      info "recipe: llama-metal - llama.cpp on Metal serving $SERVE_MODEL on port 8001"
      info 'the model is several GB and is downloaded the first time the server starts'
      if confirm 'install llama.cpp and serve this model?'; then
        if ! have brew; then die 'llama-metal needs Homebrew (https://brew.sh)'; fi
        run brew install llama.cpp
        write_file "$LAUNCH_SCRIPT" 755 <<METAL
#!/bin/sh
# Worker tier on Apple Silicon (deploy/README-install.md, recipe llama-metal).
# exec so the daemon's SIGTERM reaches llama-server itself, not a shell wrapping it.
exec "\${LLAMA_SERVER:-llama-server}" \\
  -hf $SERVE_MODEL \\
  --port 8001 --ctx-size 32768 --parallel 2
METAL
        SERVING_YAML="  - tier: worker$NL    model: $SERVE_MODEL$NL    port: 8001$NL    maxStreams: 2$NL    cmd: [\"$LAUNCH_SCRIPT\"]"
        CHOSEN=llama-metal
      else
        info 'skipped - registering compute-only'
      fi
      ;;
    llama-hip)
      if ! have llama-server; then
        die 'llama-hip needs a HIP build of llama-server on PATH - see deploy/amd/README.md'
      fi
      info "recipe: llama-hip - the llama-server already on PATH, serving $SERVE_MODEL on port 8001"
      info 'the model is several GB and is downloaded the first time the server starts'
      if confirm 'serve this model on port 8001?'; then
        write_file "$LAUNCH_SCRIPT" 755 <<HIP
#!/bin/sh
# Worker tier on the AMD HIP build of llama.cpp (deploy/amd/README.md).
exec "\${LLAMA_SERVER:-llama-server}" \\
  -hf $SERVE_MODEL \\
  --port 8001 --n-cpu-moe 12 --ctx-size 65536 \\
  --parallel 4
HIP
        SERVING_YAML="  - tier: worker$NL    model: $SERVE_MODEL$NL    port: 8001$NL    maxStreams: 4$NL    cmd: [\"$LAUNCH_SCRIPT\"]"
        CHOSEN=llama-hip
      else
        info 'skipped - registering compute-only'
      fi
      ;;
    vllm)
      info 'recipe: vllm - vLLM is a manual step; follow deploy/spark/README.md, then re-run with --recipe attach'
      ;;
  esac

  if [ "$CHOSEN" = none ]; then
    info 'recipe: none - registering compute-only (shell jobs, no model serving)'
    case "$GPU_CLASS" in
      apple-silicon-*)
        if [ "$MEM_GB" -lt "$METAL_MIN_GB" ]; then
          info "note: no verified recipe for ${MEM_GB} GB of unified memory yet (the Apple Silicon recipe needs ${METAL_MIN_GB} GB or more)"
        fi
        ;;
      amd-*)
        info 'note: build llama.cpp with HIP first (deploy/amd/README.md), then re-run with --recipe llama-hip'
        ;;
      nvidia-*)
        info 'note: serve this GPU with vLLM by hand (deploy/spark/README.md), then re-run with --recipe attach'
        ;;
    esac
  fi
}

# ---------------------------------------------------------------- 5. config

render_config() {
  printf '# AgentHub node config, written by install.sh. Re-running the installer rewrites this\n'
  printf '# file and keeps the previous one as node.yaml.prev. Fields: configs/README.md.\n'
  printf 'node:\n  name: %s\n  arch: %s\n' "$NAME" "$ARCH"
  printf 'hub: %s\n' "$HUB"
  printf 'hubToken: "%s"\n' "$NODE_TOKEN"
  printf 'advertiseHost: %s\n' "$ADVERTISE_HOST"
  printf 'heartbeatMs: 5000\n'
  if [ -n "$SERVING_YAML" ]; then
    # SERVING_YAML never ends in a newline (command substitution strips them), so add one here.
    printf 'serving:\n%s\n' "$SERVING_YAML"
  else
    printf 'serving: []\n'
  fi
  printf 'jobTypes: ["shell-task"]\n'
  printf 'workspaceRoot: %s\n' "$AGENTHUB_HOME/workspace"
  printf 'claimIntervalMs: 1000\n'
}

write_config() {
  step "Writing $CONFIG"
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] write $CONFIG (mode 600)"
  else
    if [ -f "$CONFIG" ]; then
      cp "$CONFIG" "$CONFIG.prev"
      info "kept the previous config as $CONFIG.prev"
    fi
    render_config | write_file "$CONFIG" 600
  fi
  run mkdir -p "$AGENTHUB_HOME/workspace"
}

# The config as written, with the node token masked. The real token is never printed.
show_config() {
  masked=$(mask "$NODE_TOKEN")
  render_config | sed 's|^hubToken: ".*"$|hubToken: "'"$masked"'"|' | sed 's/^/    | /'
}

# ---------------------------------------------------------------- 6. enrollment

enroll() {
  step "Enrolling with $HUB"
  enroll_name=$NAME
  attempt=1
  while : ; do
    payload=$(printf '{"token":"%s","name":"%s","arch":"%s","hardware":%s}' \
      "$(json_escape "$TOKEN")" "$(json_escape "$enroll_name")" "$ARCH" "$HARDWARE_JSON")
    if [ "$DRY_RUN" -eq 1 ]; then
      info "[dry-run] POST $HUB/api/nodes/enroll"
      info "[dry-run] $(printf '%s' "$payload" | sed 's/"token":"[^"]*"/"token":"***"/')"
      NODE_TOKEN='<node token from the hub>'
      return 0
    fi
    resp=$(curl -s -m 30 -w '\n%{http_code}' -X POST \
      -H 'Content-Type: application/json' -d "$payload" "$HUB/api/nodes/enroll" || true)
    code=$(printf '%s' "$resp" | tail -n 1)
    body=$(printf '%s\n' "$resp" | sed '$d')
    case "$code" in
      200)
        NODE_TOKEN=$(json_str nodeToken "$body")
        hub_name=$(json_str name "$body")
        if [ -z "$NODE_TOKEN" ]; then die "the hub returned no nodeToken: $body"; fi
        if [ -n "$hub_name" ]; then NAME=$hub_name; fi
        info "enrolled as \"$NAME\" (node token $(mask "$NODE_TOKEN"))"
        return 0
        ;;
      401) die 'the enrollment token is invalid or expired - mint a new one on the Cluster page' ;;
      409)
        if [ "$attempt" -eq 1 ]; then
          enroll_name="$NAME-2"
          attempt=2
          info "the name \"$NAME\" is taken - retrying as \"$enroll_name\""
          continue
        fi
        die "the names \"$NAME\" and \"$enroll_name\" are both taken - pass --name"
        ;;
      '') die "could not reach $HUB" ;;
      *)  die "enrollment failed (HTTP $code): $body" ;;
    esac
  done
}

# ---------------------------------------------------------------- 7. service

install_service() {
  if [ "$OS" = Darwin ]; then
    step "Installing the launchd agent ($LABEL)"
    write_file "$PLIST" 644 <<PLISTXML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SRC/node_modules/.bin/tsx</string>
    <string>packages/node-daemon/src/main.ts</string>
    <string>$CONFIG</string>
  </array>
  <key>WorkingDirectory</key><string>$SRC</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTXML
    run rm -f "$LOG"
    run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    run launchctl bootstrap "gui/$(id -u)" "$PLIST"
    info "the daemon logs to $LOG"
  else
    step 'Installing the systemd user unit (agenthub-node.service)'
    write_file "$UNIT" 644 <<UNITFILE
# ~/.config/systemd/user/agenthub-node.service - written by install.sh.
[Unit]
Description=AgentHub node daemon ($NAME)
After=network-online.target

[Service]
WorkingDirectory=$SRC
ExecStart=$NODE_BIN $SRC/node_modules/.bin/tsx packages/node-daemon/src/main.ts $CONFIG
Restart=on-failure
RestartSec=15
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
UNITFILE
    # Linger keeps the user unit running while nobody is logged in.
    if ! run loginctl enable-linger "$(id -un)" 2>/dev/null; then
      if have sudo; then
        run sudo loginctl enable-linger "$(id -un)" \
          || warn 'could not enable linger - the daemon will stop when you log out'
      else
        warn 'could not enable linger - the daemon will stop when you log out'
      fi
    fi
    run rm -f "$LOG"
    run systemctl --user daemon-reload
    run systemctl --user enable --now agenthub-node.service
    info "the daemon logs to $LOG"
  fi
}

# ---------------------------------------------------------------- 8. verify

verify() {
  step 'Waiting for the daemon to come up'
  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] tail $LOG for \"[daemon] up\" (up to 60s)"
    info "[dry-run] then: Node \"$NAME\" is up. See it on the Cluster page."
    return 0
  fi
  waited=0
  while [ "$waited" -lt 60 ]; do
    if [ -f "$LOG" ] && grep -q '\[daemon\] up' "$LOG"; then
      tail -n 5 "$LOG" | sed 's/^/    | /'
      step "Node \"$NAME\" is up. See it on the Cluster page."
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "the daemon did not report \"[daemon] up\" within 60s. The last lines of $LOG:"
  if [ -f "$LOG" ]; then tail -n 20 "$LOG" | sed 's/^/    | /'; fi
  exit 1
}

# ---------------------------------------------------------------- main

if [ "$DO_UNINSTALL" -eq 1 ]; then
  uninstall
  exit 0
fi

if [ -z "$HUB" ]; then usage >&2; die '--hub is required'; fi

# An existing config with a token means this is an update: same identity, no enrollment.
IS_UPDATE=0
NODE_TOKEN=''
if [ -f "$CONFIG" ]; then
  NODE_TOKEN=$(yaml_value "$CONFIG" hubToken)
  if [ -n "$NODE_TOKEN" ]; then
    IS_UPDATE=1
    if [ -z "$NAME" ]; then
      NAME=$(sed -n 's/^  name:[[:space:]]*//p' "$CONFIG" | head -n 1)
    fi
  fi
fi
if [ "$IS_UPDATE" -eq 0 ] && [ -z "$TOKEN" ]; then
  usage >&2
  die '--token is required to enroll a new node (mint one on the Cluster page)'
fi

if [ "$IS_UPDATE" -eq 1 ]; then
  step "Updating the node already installed in $AGENTHUB_HOME"
else
  step "Installing an AgentHub node into $AGENTHUB_HOME"
fi
if [ "$DRY_RUN" -eq 1 ]; then info '[dry-run] nothing on this machine will be changed'; fi
run mkdir -p "$AGENTHUB_HOME"

detect
ensure_node
fetch_src
choose_serving
write_config
if [ "$IS_UPDATE" -eq 1 ]; then
  step 'Enrolling with the hub'
  info 'already enrolled - keeping the existing node token'
else
  # The config is written first (step 5) and rewritten here with the token the hub hands back.
  enroll
  write_config
fi
show_config
install_service
verify
