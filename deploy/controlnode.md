# Control-node switching (Mac mini ⇄ Strix Halo)

The hub is one process whose entire state is its **data root** — the SQLite database, the project
bundles and the memory bundle. Moving the hub between control nodes is therefore: freeze writes,
fold the WAL into the database file, copy the data root to the other node, prove the copy arrived
intact, start the hub there, and only then stop the hub here (PRD §4.2).

Mac mini M2 Pro is the default control node; the Strix Halo box is the standby. Both run the node
daemon; exactly one of them runs the hub at a time.

## Data root layout

Everything the hub owns lives under one directory (`/opt/agenthub/data` below):

```
data/
  hub.db            SQLite (WAL mode)
  projects/         project bundles
  memory/           MEMORY.md, notes/, planner/ (git-versioned)
  media/            browser recordings, finished video clips
```

During a switch one more file appears next to `hub.db`:

```
  checkpoint.db     a VACUUM INTO snapshot, written just before the sync
```

`hub.db` is open and being written for the whole copy, so the bytes that land on the target are a
copy of a moving file. `checkpoint.db` is not: it is a consistent snapshot taken after the WAL
checkpoint, and `POST /control/hub/start` renames it over `hub.db` (dropping any stale `-wal`/`-shm`)
before spawning the hub. The data stamp reflects that split — the live `hub.db` is excluded, the
snapshot is compared by **content hash**, everything else by path and size.

The hub is told about the data root with `controlNode.dataRoot` (see `createHub`, wired from the
`DATA_ROOT` environment variable), and each daemon repeats it in its own `controlNode.dataRoot`. A
hub started by a daemon gets `DATA_ROOT` plus `HUB_DB`, `PROJECTS_ROOT` and `MEMORY_ROOT` derived
from it, so a switched-to hub can only ever read the copy that just landed.

## The environment the new hub gets

A hub is configured entirely by its environment, and after a switch that environment comes from the
**target's daemon**, not from the machine the hub left. The daemon passes an explicit allowlist
through to the hub it spawns:

    HUB_PASSWORD  HUB_SESSION_SECRET  DAEMON_TOKEN  TRUST_PROXY
    CONTROL_NODE_NAME  HUB_HOST  PORT
    TELEGRAM_BOT_TOKEN  TELEGRAM_OWNER_CHAT_ID  BRIEFING_TIME  CHECKIN_TIMES
    XAI_API_KEY  X_API_KEY  GEMINI_API_KEY  SEARCH_API_KEY  SEARCH_PROVIDER  COMFY_URL

Each name is read from `controlNode.env` in the daemon config first and the daemon's own process
environment second; `CONTROL_NODE_NAME` is always overridden with `node.name`, so the new hub cannot
offer its own machine as a switch target. Set them **the same on both candidates**: a value only the
Mac mini has is a capability the hub loses the moment it moves.

`GET /control/hub` reports `authConfigured` (true when a `HUB_PASSWORD` is reachable at all). A hub
that has auth on **refuses with 412** to hand itself to a node reporting `authConfigured: false`,
rather than silently coming back up open on the tailnet.

launchd (Mac mini) — `~/Library/LaunchAgents/dev.agenthub.node.plist`:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>HUB_PASSWORD</key><string>…</string>
  <key>HUB_SESSION_SECRET</key><string>…</string>
  <key>DAEMON_TOKEN</key><string>…</string>
  <key>TRUST_PROXY</key><string>100.x.y.z</string>
  <key>HUB_HOST</key><string>100.a.b.c</string>
  <key>TELEGRAM_BOT_TOKEN</key><string>…</string>
  <key>TELEGRAM_OWNER_CHAT_ID</key><string>…</string>
  <key>XAI_API_KEY</key><string>…</string>
  <key>GEMINI_API_KEY</key><string>…</string>
  <key>SEARCH_API_KEY</key><string>…</string>
</dict>
```

systemd (Strix Halo) — `/etc/systemd/system/agenthub-node.service`. Keep the secrets out of the unit
file itself, which is world-readable:

```ini
[Service]
EnvironmentFile=/etc/agenthub/hub.env      # chmod 600, root-owned; the same names as above
Environment=HUB_HOST=100.d.e.f
```

`HUB_HOST` is the address the hub binds (default `0.0.0.0`). On a deployed control node set it to
that machine's **tailnet IP**, so the hub is not listening on every interface the box happens to
have — the same rule the daemons follow (`deploy/tailscale.md`).

## Daemon config on each candidate

```yaml
# configs/macmini.yaml (and configs/strix.yaml, with its own paths)
node: { name: macmini, arch: arm64 }
hub: http://hub.internal:4000   # the alias, not a machine name — it follows the switch
hubCandidates:                  # backstop if the alias is slow to move
  - http://macmini.<tailnet>.ts.net:4000
  - http://strix.<tailnet>.ts.net:4000
hubToken: ${DAEMON_TOKEN}
advertiseHost: macmini          # the tailnet name — rsync and the hub both use it
controlPort: 8131
controlNode:
  hubCmd: ["node", "/opt/agenthub/packages/hub/src/main.js"]
  dataRoot: /opt/agenthub/data
  hubUrl: http://macmini:4000   # optional; defaults to http://<advertiseHost>:4000
  # env: {}                     # optional per-node overrides for the allowlist above
```

**Every daemon's `hub:` is the alias**, not a machine name — the same `hub.internal` the DO proxy
uses (`deploy/do/README.md` §6). When the hub moves, repointing that one record moves every daemon
with it. `hubCandidates` is the backstop for the window before the record has moved: after three
consecutive failed heartbeats the daemon re-probes `hub`, then each candidate in order, and follows
the first that answers `GET /api/health`.

`controlNode` alone is a capability, so a standby node needs no `serving` entries. It makes the
daemon advertise `controlNode: true` in its registration and adds four bearer-protected endpoints to
its control server (the same `DAEMON_TOKEN` that guards `/control/profile`):

| Endpoint | What it does |
| --- | --- |
| `GET /control/hub` | `{ running, pid?, hubUrl, dataRoot, authConfigured }` |
| `GET /control/hub/data-stamp` | sha256 over the data root: content for `*.db`, path+size for the rest |
| `POST /control/hub/start` | adopts `checkpoint.db`, spawns `hubCmd`, answers only once `GET <hubUrl>/api/health` succeeds; **409** if a hub is already up here |
| `POST /control/hub/stop` | SIGTERM, escalating to SIGKILL after 10s |

The hub is a **child of the daemon**, so keep the daemon itself alive with launchd (Mac mini) or
systemd (Strix Halo) — stopping the daemon stops the hub it started.

launchd, `~/Library/LaunchAgents/dev.agenthub.node.plist` (Mac mini) — alongside the
`EnvironmentVariables` block above:

```xml
<key>ProgramArguments</key>
<array><string>/usr/local/bin/node</string><string>/opt/agenthub/packages/node-daemon/src/main.js</string>
       <string>/opt/agenthub/configs/macmini.yaml</string></array>
<key>KeepAlive</key><true/>
```

systemd, `/etc/systemd/system/agenthub-node.service` (Strix Halo) — alongside the `EnvironmentFile`
line above:

```ini
[Service]
ExecStart=/usr/bin/node /opt/agenthub/packages/node-daemon/src/main.js /opt/agenthub/configs/strix.yaml
Restart=always
[Install]
WantedBy=multi-user.target
```

## ssh key for the sync

The sync is one `rsync -a --delete <dataRoot>/ <tailnet-host>:<their dataRoot>/`, run by the hub as
the user it runs as. Give that user a key the other node accepts, once per direction:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/agenthub -N ''
ssh-copy-id -i ~/.ssh/agenthub.pub agenthub@strix     # and the mirror image on strix
```

The host rsync targets is the hostname out of the control URL the node registered — i.e.
`advertiseHost`, which must be the node's tailnet name. Override the argv with `controlNode.rsync`
(`{from}`, `{host}` and `{dataRoot}` are substituted) if the deployment needs different flags.

## The switch

`POST /api/controlnode {node}` (owner session), or `/controlnode <name>` in Telegram, which asks for
confirmation first — the switch takes this hub down. `GET /api/controlnode` lists the candidates and
which one is current. In order:

1. state-mutating `/api/*` routes start answering **503** (reads keep working);
2. the writers no HTTP request drives stop too: the project ticker, the assistant's scheduler, the
   offline sweep, and the **Telegram long poll** — that last one before the new hub starts, so the
   two never both consume the owner's updates;
3. `PRAGMA wal_checkpoint(TRUNCATE)`, then `VACUUM INTO <dataRoot>/checkpoint.db`;
4. rsync the data root — snapshot included — to the target;
5. compare the local data stamp with the target's `GET /control/hub/data-stamp`;
6. `POST /control/hub/start` on the target, which renames the snapshot into place and waits for the
   new hub's own `/api/health`;
7. answer `{ switchedTo, hubUrl }`;
8. stop this hub two seconds later.

Anything that fails before step 6 puts the paused writers back and leaves this hub serving.

**Refusals**, all of which leave both hubs exactly as they were:

| Status | When |
| --- | --- |
| 400 | the node isn't a registered control-node candidate, is offline, or is the current one |
| 409 | a video job is running, a switch is already in progress, or the target already runs a hub |
| 412 | the data stamps disagree (stale or partial sync), or the target reports `authConfigured: false` while this hub has auth on — **nothing is started** |
| 501 | this hub was started without a `controlNode` data root |
| 502 | the target's control server could not be reached, or its hub never came up |

Step 5 is the "refuse to start if the sync is stale" rule of PRD §4.2: the target's hub is never
started against a data root that does not match the one this hub just snapshotted.

## DO proxy

The DigitalOcean droplet proxies to `hub.internal` — a **tailnet alias**, not a node name — so a
switch is a one-line change there rather than a redeploy. The Caddyfile keeps saying
`reverse_proxy {$HUB_UPSTREAM}` with `HUB_UPSTREAM=hub.internal:4000`, and only the alias moves
(`deploy/do/README.md` §6). Caddy runs as a **host systemd service**, not in Docker:

```sh
# on the droplet, after a switch
sudo sed -i 's/^100\.[0-9.]* *hub\.internal/100.a.b.c   hub.internal/' /etc/hosts
sudo systemctl reload caddy
```

or repoint the `hub.internal` custom DNS record in the Tailscale admin console instead, which moves
it for every machine at once — including the daemons, whose `hub:` is the same alias.

Renaming the *machine* (`tailscale up --hostname=…`) is not the mechanism, and doing it has side
effects: the node's MagicDNS name is what `advertiseHost` and the rsync target are built from, and
the ACL grants in `deploy/do/README.md` §5 key on **tags** (`tag:hub`), which survive a rename but
have to be present on both candidates. Move the alias; leave the hostnames alone.

Until the alias moves, the public URL 502s while the tailnet UI on the new node already works —
which is the right failure direction.
