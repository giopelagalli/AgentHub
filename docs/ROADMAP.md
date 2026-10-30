# AgentHub — roadmap

Now and Next only; what shipped is in `docs/CHANGELOG.md`, the *why* in `docs/decisions/`. The
*what* is `docs/prd-agenthub-v2.md`; phases and estimates are `docs/plan-agenthub-v2.md`.

## Now

- Dogfooding `pomodoro-cli` (m1–m3 done, m4 next); the PC joining via the installer when it is on.
- The public site on the droplet (`rosenroot.com`, 0025): the owner's droplet, DNS and Caddy steps.
- JD drives projects and talks in the hub (FR-C1–C4): merged to JD's main, off until configured.
  Waiting on the owner: an *assistant* token labelled `JD` and one shared `JD_WEB_TOKEN` in the
  two env files, then `deploy/spark/deploy.sh`.
- Generation on Fireworks (0074): waiting on the owner to turn on **Pause models** for the Spark
  on the Machines page (or keep its node daemon stopped).

## Next (in order)

1. Recipe catalog entries verified on real hardware (Spark attach, AMD llama.cpp HIP, Apple
   Silicon 48 GB).
2. Harnesses, the rest: pi becomes the default and `HARNESS_REVIEWER_PI` defaults on once the
   sandbox (0055) is verified on real hardware on both platforms — macOS is; the Linux `bwrap` path
   (AppArmor's user-namespace rule, the door bridge) must be run on the Spark by the owner. Then:
   claude-code on Linux once its egress can be narrowed to HTTPS (a proxy over a socket or a
   filtered namespace, 0064), and the installer putting pi (and `bubblewrap`) on a node.
3. FR-C5 (JD's model through the hub's door) when the owner wants it; call mode (plan Phase 3).
4. Media on the real 7900 XTX: ComfyUI on ROCm, the owner's by-hand test, the templates exported
   over the placeholders (`deploy/amd/comfy/README.md`); then FR-E4 (JD → a render → Telegram).
5. Accounts, grants, per-member JD, the public site (FR-F1–F6).
