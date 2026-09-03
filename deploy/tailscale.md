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

## No port forwards

Nothing here needs a router port forward or public DNS. The DO droplet
proxy (spec §4, §12) reaches the active control node over the tailnet the
same way; only the droplet itself needs a public listener. Keep node
daemons and model-serving ports (4000, 8001, 8002, ...) bound to the
tailnet interface, not `0.0.0.0` on a machine with a public IP.
