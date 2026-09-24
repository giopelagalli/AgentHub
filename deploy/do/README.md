# DigitalOcean proxy (Caddy over Tailscale)

The one machine in AgentHub with a public listener. It is a **stateless reverse
proxy on the tailnet** (PRD §4): no database, no `data/`, no API keys, nothing
that would hurt if the droplet were rebuilt from scratch on a Tuesday — except
one state file and, optionally, one bot token for the watchdog (§8). It
terminates TLS for your domain, forces a second factor before anything is
forwarded, and proxies to whichever machine is currently the control node,
over Tailscale.

Everything else — the hub, the nodes, the models, the browser, ComfyUI — keeps
listening on the tailnet only. Nothing anywhere needs a router port forward.

    internet ──TLS──▶ droplet (Caddy; basic auth on the UI paths) ──tailnet──▶ spark-f9a9:4000

As deployed (2026-09-23): the public name is the apex **rosenroot.com** (DNS at Porkbun; `www`
redirects to it); the upstream is the Spark's tailnet name; `rosenroot.ai` is a different app.

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

## 3. Public DNS (Porkbun)

In Porkbun → rosenroot.com → DNS records: delete the parking records Porkbun creates by default
(the `ALIAS @ → pixie.porkbun.com` and the `CNAME www` ones), then add:

    A     @      <droplet public IPv4>     TTL 600
    A     www    <droplet public IPv4>     TTL 600

(and `AAAA` for both if the droplet has IPv6). Nothing else is ever published — no node name,
no tailnet address. Caddy gets its certificate from Let's Encrypt over HTTP-01 on port 80, so
give DNS a few minutes to propagate before starting it (`dig +short rosenroot.com`).

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
    HUB_DOMAIN=rosenroot.com
    HUB_UPSTREAM=spark-f9a9.tail7ac2e2.ts.net:4000
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

        // The owner's own devices reach everything, so the management UI still works
        // from inside the tailnet without going through the droplet.
        { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }
      ],
      "ssh": [
        { "action": "accept", "src": ["autogroup:member"],
          "dst": ["tag:proxy", "tag:hub", "tag:node"], "users": ["autogroup:nonroot", "root"] }
      ]
    }

Tag the Spark `tag:hub`, every other machine `tag:node`, the droplet `tag:proxy`. Adjust
the port ranges to the ports your `configs/<node>.yaml` files actually use.
The point of the shape, not the exact numbers: **`tag:proxy` can open exactly
one port on exactly two machines**, so a compromised droplet is a compromised
reverse proxy and not a foothold on the tailnet.

There is no public exposure anywhere else. Do not add a Tailscale Funnel, do
not open 4000 on the droplet's firewall, and keep every daemon bound to its
tailnet interface rather than `0.0.0.0` (`deploy/tailscale.md`).

## 6. The upstream name

`HUB_UPSTREAM` is the Spark's MagicDNS name, `spark-f9a9.tail7ac2e2.ts.net:4000` (the short
`spark-f9a9:4000` also resolves when `--accept-dns` is on). The Spark is the hub for good (decision
0003); if that ever changes, this one line and a `systemctl reload caddy` move the site. Check
from the droplet before starting Caddy:

    curl -s http://spark-f9a9.tail7ac2e2.ts.net:4000/api/health     # {"ok":true}

## 7. The hub side: `TRUST_PROXY`

Behind Caddy, every request reaches the hub from the droplet's tailnet address.
Unless the hub is told to trust it, the login throttle counts all traffic as one
client — so **one attacker's five failed logins lock the owner out globally** —
and the session cookie never gets marked `Secure`, because the hub sees plain
HTTP.

Set it in `~/AgentHub/configs/hub.env` on the Spark and restart the hub:

    TRUST_PROXY=100.x.y.z        # the droplet's tailnet IP — the safe form
    TRUST_PROXY=1                # trust any proxy: only if *nothing* else can reach :4000

With it set, `req.ip` becomes the real client from `X-Forwarded-For` (so the
throttle counts per attacker) and `X-Forwarded-Proto: https` marks the session
cookie `Secure`. Leave it unset when the hub is reachable directly on the
tailnet by anything other than the droplet: those headers are attacker-supplied
in that case, and trusting them lets anyone forge a client identity.

## 8. When the hub is down

A visitor gets the offline page, not a bare 502: the `Caddyfile`'s `handle_errors` block catches
the errors Caddy itself raises when it can't reach the upstream — dial failure, timeout, no
healthy upstream — not a 502/503/504 the hub returned on its own, and serves
`/etc/caddy/site/offline.html` with **status 503**, so browsers and uptime monitors both see an
outage, not a live page. The page polls `/api/health` every 15 seconds and reloads itself once
the hub answers again.

A second, independent piece — `hub-watch.timer` — runs on the droplet every minute and messages
Telegram on the down/up transition only (not on every check). It is the droplet's own alert, not
JD's: JD runs on the Spark, so it goes silent for exactly the outage you'd want to hear about.

Install the offline page (scp'd from the Mac like the Caddyfile — the droplet has no repo):

    sudo mkdir -p /etc/caddy/site
    sudo cp deploy/do/site/offline.html /etc/caddy/site/

Install the watchdog:

    sudo cp hub-watch.sh /usr/local/bin/
    sudo chmod +x /usr/local/bin/hub-watch.sh
    sudo cp hub-watch.service hub-watch.timer /etc/systemd/system/

    sudo tee /etc/agenthub-watch.env >/dev/null <<'EOF'
    HUB_UPSTREAM=spark-f9a9.tail7ac2e2.ts.net:4000
    HUB_DOMAIN=rosenroot.com
    TELEGRAM_BOT_TOKEN=your-bot-token
    TELEGRAM_CHAT_ID=your-chat-id
    EOF
    sudo chmod 600 /etc/agenthub-watch.env

    sudo systemctl daemon-reload
    sudo systemctl enable --now hub-watch.timer

Test it:

    sudo systemctl start hub-watch.service; journalctl -u hub-watch -n 5

To create the bot: message [@BotFather](https://t.me/BotFather) `/newbot` and copy the token it
gives you. To find the chat id: message [@userinfobot](https://t.me/userinfobot) and copy the `Id`
it replies with. Leaving either key blank in the env file still runs the check and updates the
state file; it just skips the send.

## 8b. Previews: a second site, on its own hostname

Previews are served by a **second listener on the Spark** (`PREVIEW_PORT`, default `4010`) on its
own origin, because a preview document is project code and must never share an origin with the
hub's API (decision 0040). Publishing it therefore means a second Caddy site, not a path on the
first one.

DNS, alongside the records in §3:

    A     preview    <droplet public IPv4>     TTL 600

Caddy — add a site block beside the main one (this repo's `Caddyfile` is the file to edit, then
scp it to `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy`):

    preview.rosenroot.com {
        reverse_proxy {$HUB_PREVIEW_UPSTREAM}
    }

with `HUB_PREVIEW_UPSTREAM=spark-f9a9.tail7ac2e2.ts.net:4010` in the same environment file §4
writes.

Two things about that block are deliberate:

- **No basic auth.** The main site's edge password is what keeps strangers off the hub; the preview
  site cannot have it, because the iframe on the hub's page would have no way to answer the prompt.
  What protects a preview is the capability in its path — 32 random hex, minted per project, reset
  from the sheet's **Settings → Reset link**.
- **Nothing else is proxied there.** The listener behind it serves `/p/<slug>/<cap>/…` and answers
  404 to everything else, including `/api`, so a misconfigured block cannot expose the hub.

Finally, tell the hub what the public origin is, so the UI links to the hostname rather than to
`spark:4010` — in `~/AgentHub/configs/hub.env` on the Spark:

    PREVIEW_PUBLIC_BASE=https://preview.rosenroot.com

Leave it unset and the hub links to its own host on `PREVIEW_PORT`, which is right on the tailnet
and wrong through the droplet. The §5 tailnet ACL needs `4010` opened to the droplet the same way
`4000` is.

## 9. Rate limiting

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

## 10. Verify

    curl -sI https://hub.example.com/                      # 401 — basic auth demanded
    curl -sI https://hub.example.com/ -u owner:<pass>      # 200 — the UI, then the hub's login box
    curl -s  https://hub.example.com/api/state -u owner:<pass>   # 401 from the hub: no session yet
    curl -sI http://hub.example.com/                       # 308 → https

Both gates are visible in that sequence: the edge answers 401 without basic
auth, and the hub answers 401 without a session even once basic auth passes.
