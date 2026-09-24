# Tailscale setup

All nodes talk to each other over a Tailscale tailnet — no port forwarding,
no public IPs. Each machine addresses the others by tailnet hostname
(MagicDNS), not raw IP.

## Install (each node)

    curl -fsSL https://tailscale.com/install.sh | sh   # linux (amd, spark)
    brew install --cask tailscale                        # macOS (macbook, macmini)
    sudo tailscale up

On macOS the Tailscale app can also be used instead of the CLI; either way
run `tailscale up` once and approve the device in the admin console.

## MagicDNS names

With MagicDNS enabled (Tailscale admin console → DNS), each node is
reachable as `<name>.<tailnet>.ts.net`, e.g.:

    spark.<tailnet>.ts.net
    amd.<tailnet>.ts.net
    macbook.<tailnet>.ts.net
    macmini.<tailnet>.ts.net
    proxy.<tailnet>.ts.net      # the DO droplet

`<tailnet>` is your tailnet's name, shown in the admin console. Confirm the
name resolves before wiring it into a config:

    tailscale status
    ping macmini.<tailnet>.ts.net

## Config values

Every daemon config's `hub` and `advertiseHost` use these tailnet names, not
localhost or LAN IPs:

    hub: http://macmini.<tailnet>.ts.net:4000
    advertiseHost: spark.<tailnet>.ts.net

`advertiseHost` is what the hub tells the gateway to route agent traffic to
for that node's serving endpoints — it must be reachable from wherever the
hub runs, which on a tailnet means the node's own tailnet name.

## The DO proxy node

One more machine joins the tailnet: the DigitalOcean droplet that fronts the
hub for the public internet (`deploy/do/README.md`). It joins like any other
node, but with SSH behind Tailscale and a tag the ACL keys on:

    sudo tailscale up --ssh --advertise-tags=tag:proxy --accept-dns=true

It holds no project data — Caddy, tailscaled, and the hub watchdog timer (one state file, optionally a bot token), nothing else — and it reaches the hub
by an *alias* (`hub.internal`, an `/etc/hosts` line or a custom DNS record in
the admin console) rather than a machine name, because `/controlnode` moves the
hub between the Mac mini and the Strix Halo. Repointing that alias after a
switch is a manual step; `deploy/do/README.md` §6 has the one-liner.

## ACLs

Default-open tailnets are fine until one node is internet-facing. With the
droplet in the picture, write the policy down (admin console → Access
controls) so that:

- **`tag:proxy` (the droplet) may reach exactly `tag:hub:4000`** — the hub port
  on the two control-node candidates, and nothing else. No SSH into the tailnet,
  no model ports, no browser server. A compromised droplet is then a compromised
  reverse proxy, not a foothold.
- **`tag:hub` and `tag:node` reach each other** on the ports they actually use:
  the hub's 4000, each daemon's control/browser server, and the model-serving
  ports from `configs/<node>.yaml`.
- **The owner's own devices (`autogroup:member`) reach everything**, so the
  management UI works from inside the tailnet without going through the droplet.

The full policy JSON is in `deploy/do/README.md` §5.

## No public exposure

Nothing here needs a router port forward or public DNS. Only the droplet has a
public listener (443, plus 80 for the ACME challenge); every other machine is
tailnet-only. Do not enable Tailscale Funnel on any node, and keep node daemons
and model-serving ports (4000, 8001, 8002, ...) bound to the tailnet interface,
not `0.0.0.0` — especially on a machine that also has a public IP.
