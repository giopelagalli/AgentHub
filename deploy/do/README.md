# DigitalOcean proxy (Caddy over Tailscale)

The one machine in AgentHub with a public listener. It is a **stateless reverse
proxy on the tailnet** (PRD §4): no database, no `data/`, no API keys, nothing
that would hurt if the droplet were rebuilt from scratch on a Tuesday. It
terminates TLS for your domain, forces a second factor before anything is
forwarded, and proxies to whichever machine is currently the control node,
over Tailscale.

Everything else — the hub, the nodes, the models, the browser, ComfyUI — keeps
listening on the tailnet only. Nothing anywhere needs a router port forward.

    internet ──TLS──▶ droplet (Caddy, basic auth) ──tailnet──▶ control node :4000

## 1. Droplet

The smallest one. A $6/mo *Basic / Regular* droplet (1 vCPU, 1 GB, 25 GB) is
more than this workload needs — it proxies one owner's traffic and streams the
occasional video clip. Pick the region nearest you (latency here is added to
every UI interaction), Ubuntu 24.04 LTS, and add your SSH key at create time.

Harden it before it does anything else:

    sudo apt update && sudo apt upgrade -y
    sudo apt install -y ufw
    sudo ufw default deny incoming
    sudo ufw allow 22/tcp          # dropped again in step 2, once Tailscale SSH works
    sudo ufw allow 80,443/tcp
    sudo ufw enable
    sudo apt install -y unattended-upgrades

## 2. Join the tailnet

    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh --advertise-tags=tag:proxy --accept-dns=true

`--ssh` puts SSH behind Tailscale identity, so you can then close public SSH
entirely — the droplet's only inbound ports become 80 and 443:

    sudo ufw delete allow 22/tcp

`--advertise-tags=tag:proxy` is what the ACL in step 5 keys on. Tag ownership
has to exist in the tailnet policy before the node can claim it (see step 5).
`--accept-dns=true` is required: the upstream is a MagicDNS name.

## 3. Public DNS

One `A` record (and `AAAA` if you enabled IPv6) for `hub.example.com` pointing
at the droplet's **public** IP. Nothing else is ever published — no node name,
no tailnet address. Caddy gets its certificate from Let's Encrypt over HTTP-01
on port 80, so let DNS propagate before starting it.

## 4. Caddy

    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt update && sudo apt install -y caddy

Copy this directory's `Caddyfile` to `/etc/caddy/Caddyfile`, then write the
environment it reads:

    caddy hash-password            # type your edge password; copy the $2a$... hash

    sudo tee /etc/caddy/agenthub.env >/dev/null <<'EOF'
    HUB_DOMAIN=hub.example.com
    HUB_UPSTREAM=hub.internal:4000
    ACME_EMAIL=you@example.com
    EDGE_USER=owner
    EDGE_HASH=$2a$14$replace-me
    EOF
    sudo chmod 600 /etc/caddy/agenthub.env
    sudo chown root:root /etc/caddy/agenthub.env

The Debian package ships `caddy.service`; it needs one override to load that
env file. `sudo systemctl edit caddy` and put in:

    [Service]
    EnvironmentFile=/etc/caddy/agenthub.env

Then:

    sudo systemctl enable --now caddy
    sudo systemctl reload caddy      # after any Caddyfile or env change
    sudo journalctl -u caddy -f

If you would rather not use the packaged unit, the equivalent standalone
`/etc/systemd/system/caddy.service` is:

    [Unit]
    Description=Caddy (AgentHub edge)
    After=network-online.target tailscaled.service
    Wants=network-online.target
    Requires=tailscaled.service

    [Service]
    User=caddy
    Group=caddy
    EnvironmentFile=/etc/caddy/agenthub.env
    ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
    ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
    TimeoutStopSec=5s
    LimitNOFILE=1048576
    PrivateTmp=true
    ProtectSystem=full
    AmbientCapabilities=CAP_NET_BIND_SERVICE
    Restart=on-abnormal

    [Install]
    WantedBy=multi-user.target

(There is no `docker-compose.yml` here. The plan sketched Caddy plus a
Tailscale sidecar in Docker; on a droplet whose entire job is these two
daemons, host packages plus systemd is fewer moving parts, keeps `tailscale
--ssh` working for the host itself, and makes `TS_AUTHKEY` unnecessary.)

## 5. Tailnet ACL

The droplet is the internet-facing machine, so it gets the *narrowest* grant in
the tailnet: the hub port on the control-node candidates, and nothing else. In
the Tailscale admin console → Access controls:

    {
      "tagOwners": {
        "tag:proxy":   ["autogroup:admin"],
        "tag:hub":     ["autogroup:admin"],
        "tag:node":    ["autogroup:admin"]
      },
      "acls": [
        // The droplet may reach the hub port on control-node candidates. Nothing else.
        { "action": "accept", "src": ["tag:proxy"], "dst": ["tag:hub:4000"] },

        // Nodes and the hub talk to each other on the daemon control server,
        // the browser server and the model-serving ports.
        { "action": "accept", "src": ["tag:hub", "tag:node"],
          "dst": ["tag:hub:4000", "tag:node:7000-7999", "tag:node:8000-8999"] },

        // The owner's own devices reach everything, so the tower UI still works
        // from inside the tailnet without going through the droplet.
        { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }
      ],
      "ssh": [
        { "action": "accept", "src": ["autogroup:member"],
          "dst": ["tag:proxy", "tag:hub", "tag:node"], "users": ["autogroup:nonroot", "root"] }
      ]
    }

Tag the Mac mini and the Strix Halo `tag:hub` (both are control-node
candidates), every other machine `tag:node`, the droplet `tag:proxy`. Adjust
the port ranges to the ports your `configs/<node>.yaml` files actually use.
The point of the shape, not the exact numbers: **`tag:proxy` can open exactly
one port on exactly two machines**, so a compromised droplet is a compromised
reverse proxy and not a foothold on the tailnet.

There is no public exposure anywhere else. Do not add a Tailscale Funnel, do
not open 4000 on the droplet's firewall, and keep every daemon bound to its
tailnet interface rather than `0.0.0.0` (`deploy/tailscale.md`).

## 6. The upstream name, and what the control-node switch does to it

`HUB_UPSTREAM` is deliberately an *alias*, not a machine name, because the
control node moves (`deploy/controlnode.md`). Point it at whichever machine is
currently the hub, in one of two places:

**A. `/etc/hosts` on the droplet** (works on any tailnet, no admin console):

    100.x.y.z   hub.internal        # macmini — the current control node

**B. A custom DNS record in the Tailscale admin console** (DNS → Custom
records): `hub.internal` → the control node's tailnet IP. Tidier, and it moves
for every machine at once.

Either way, `/controlnode` **does not repoint it for you** — the switch hands
the hub over between machines, and the edge has to be told separately. After a
switch:

    sudo sed -i 's/^100\.[0-9.]* *hub\.internal/100.a.b.c   hub.internal/' /etc/hosts
    sudo systemctl reload caddy
    curl -sI https://hub.example.com/api/health -u owner:...   # expect 200

Until you do, the public URL 502s while the tailnet UI (`http://<new
node>.<tailnet>.ts.net:4000`) already works — which is the right failure
direction: the owner keeps control, the internet does not.

## 7. The hub side: `TRUST_PROXY`

Behind Caddy, every request reaches the hub from the droplet's tailnet address.
Unless the hub is told to trust it, the login throttle counts all traffic as one
client — so **one attacker's five failed logins lock the owner out globally** —
and the session cookie never gets marked `Secure`, because the hub sees plain
HTTP.

Set it in the hub's environment on the control node (`deploy/macmini/README.md`,
`deploy/controlnode.md`):

    TRUST_PROXY=100.x.y.z        # the droplet's tailnet IP — the safe form
    TRUST_PROXY=1                # trust any proxy: only if *nothing* else can reach :4000

With it set, `req.ip` becomes the real client from `X-Forwarded-For` (so the
throttle counts per attacker) and `X-Forwarded-Proto: https` marks the session
cookie `Secure`. Leave it unset when the hub is reachable directly on the
tailnet by anything other than the droplet: those headers are attacker-supplied
in that case, and trusting them lets anyone forge a client identity.

## 8. Rate limiting

Caddy's standard build has no rate limiter, and the layers below it do carry
their own: `basic_auth` refuses everything unauthenticated before it costs the
hub anything, and the hub locks a client out for 15 minutes after five failed
logins (which is why step 7 matters — the lockout is only per-attacker if the
real client IP survives the hop).

If you want a request cap at the edge as well, build Caddy with the rate-limit
module and add a `rate_limit` block ahead of `basic_auth`:

    xcaddy build --with github.com/mholt/caddy-ratelimit

    rate_limit {
        zone edge {
            key    {remote_host}
            events 60
            window 1m
        }
    }

Treat that as optional hardening, not as the security boundary. The boundary is
basic auth, the hub's own login, and an ACL that lets this machine open exactly
one port.

## 9. Verify

    curl -sI https://hub.example.com/                      # 401 — basic auth demanded
    curl -sI https://hub.example.com/ -u owner:<pass>      # 200 — the UI, then the hub's login box
    curl -s  https://hub.example.com/api/state -u owner:<pass>   # 401 from the hub: no session yet
    curl -sI http://hub.example.com/                       # 308 → https

Both gates are visible in that sequence: the edge answers 401 without basic
auth, and the hub answers 401 without a session even once basic auth passes.
