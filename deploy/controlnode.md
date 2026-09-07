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

The hub is told about it with `controlNode.dataRoot` (see `createHub`, wired from the `DATA_ROOT`
environment variable), and each daemon repeats it in its own `controlNode.dataRoot`. A hub started
by a daemon inherits `DATA_ROOT` plus `HUB_DB`, `PROJECTS_ROOT` and `MEMORY_ROOT` derived from it,
so a switched-to hub can only ever read the copy that just landed.

## Daemon config on each candidate

```yaml
# configs/macmini.yaml (and configs/strix.yaml, with its own paths)
node: { name: macmini, arch: arm64 }
hub: http://macmini:4000
hubToken: ${DAEMON_TOKEN}
advertiseHost: macmini          # the tailnet name — rsync and the hub both use it
controlPort: 8131
controlNode:
  hubCmd: ["node", "/opt/agenthub/packages/hub/src/main.js"]
  dataRoot: /opt/agenthub/data
  hubUrl: http://macmini:4000   # optional; defaults to http://<advertiseHost>:4000
```

`controlNode` alone is a capability, so a standby node needs no `serving` entries. It makes the
daemon advertise `controlNode: true` in its registration and adds four bearer-protected endpoints to
its control server (the same `DAEMON_TOKEN` that guards `/control/profile`):

| Endpoint | What it does |
| --- | --- |
| `GET /control/hub` | `{ running, pid?, hubUrl, dataRoot }` |
| `GET /control/hub/data-stamp` | sha256 over every file's path and size under the data root |
| `POST /control/hub/start` | spawns `hubCmd`, answers only once `GET <hubUrl>/api/health` succeeds |
| `POST /control/hub/stop` | SIGTERM, escalating to SIGKILL after 10s |

The hub is a **child of the daemon**, so keep the daemon itself alive with launchd (Mac mini) or
systemd (Strix Halo) — stopping the daemon stops the hub it started.

launchd, `~/Library/LaunchAgents/dev.agenthub.node.plist` (Mac mini):

```xml
<key>ProgramArguments</key>
<array><string>/usr/local/bin/node</string><string>/opt/agenthub/packages/node-daemon/src/main.js</string>
       <string>/opt/agenthub/configs/macmini.yaml</string></array>
<key>KeepAlive</key><true/>
```

systemd, `/etc/systemd/system/agenthub-node.service` (Strix Halo):

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
2. `PRAGMA wal_checkpoint(TRUNCATE)`;
3. rsync the data root to the target;
4. compare the local data stamp with the target's `GET /control/hub/data-stamp`;
5. `POST /control/hub/start` on the target, which waits for the new hub's own `/api/health`;
6. answer `{ switchedTo, hubUrl }`;
7. stop this hub two seconds later.

**Refusals**, all of which leave both hubs exactly as they were:

| Status | When |
| --- | --- |
| 400 | the node isn't a registered control-node candidate, is offline, or is the current one |
| 409 | a video job is running, a switch is already in progress, or the target already runs a hub |
| 412 | the data stamps disagree — the sync is stale or partial, so **nothing is started** |
| 501 | this hub was started without a `controlNode` data root |
| 502 | the target's control server could not be reached, or its hub never came up |

Step 4 is the "refuse to start if the sync is stale" rule of PRD §4.2: the target's hub is never
started against a data root that does not match the one this hub just checkpointed.

## DO proxy

The DigitalOcean droplet proxies to a **tailnet DNS alias**, not to a node name, so a switch is a
one-line change there rather than a redeploy. With MagicDNS:

```sh
tailscale up --hostname=hub-alias        # on the node that is taking over, after the switch
```

or point the alias at the new node in the tailnet admin console, then reload Caddy on the droplet
(`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`). The Caddyfile itself keeps
saying `reverse_proxy http://hub-alias:4000` (see `deploy/do/`). Until the alias moves, the old URL
simply stops answering — the new hub is already serving on its own tailnet name.
