# Setup checklist — what to gather

Everything the bot needs before the first run, in the order it's easiest to
collect. Each item says exactly where to get it and which `.env` line it goes
on (see README §1.2 for the full table). This is the checklist for the
primary path — the bot running 24/7 on a DigitalOcean droplet, with the
model reached over Tailscale on the Spark (README §1.0). If you'd rather run
everything on the Spark for free instead, see "Alternative: run everything
on the Spark" at the bottom.

1. **Telegram bot token.** Open [@BotFather](https://t.me/BotFather) in
   Telegram, send `/newbot`, answer the name and username prompts, and copy
   the token it prints (`123456789:AA...`). Create a new bot; don't reuse an
   existing one's token. → `TELEGRAM_BOT_TOKEN`

2. **Your Telegram user id.** Open [@userinfobot](https://t.me/userinfobot)
   and send it anything; it replies with your numeric id. The bot answers
   only this user. → `TELEGRAM_USER_ID`

3. **The private group with topics.** In Telegram: New Group → name it → add
   any placeholder member (you can remove them after) → open the group's
   settings → Edit → turn on **Topics**. Add your bot to the group and
   promote it to admin (group settings → Administrators → Add Admin)
   **first**, so it sees every topic get created. Then create one topic per
   course plus `Assignments`, `Exams` and `Review`, naming each as you go —
   the bot binds itself from the name and replies in the topic to confirm
   (README §7). Only a topic created before the bot joined needs `/bind` run
   inside it as a fallback. Nothing to put in `.env` — the bindings live in
   `knowledge/channels.md`. Telegram only lets a bot download files up to
   20 MB, so split anything bigger before sending it; the bot says so
   instead of ingesting it.

4. **Fireworks API key.** Sign in at
   [app.fireworks.ai](https://app.fireworks.ai) → click your account (top
   right) → **API Keys** → create a key and copy it once; it isn't shown
   again. → `FALLBACK_API_KEY` (with
   `FALLBACK_BASE_URL=https://api.fireworks.ai/inference/v1`) and
   `STT_API_KEY` (with `STT_BASE_URL=https://audio-prod.us-virginia-1.direct.fireworks.ai/v1`)
   — the same key works for both.

5. **Fireworks model ids.** At
   [app.fireworks.ai/models](https://app.fireworks.ai/models), filter for
   **function calling** support and pick a Qwen3 variant to stay closest to
   the local model. The id on the model's page looks like
   `accounts/fireworks/models/<name>` — copy it verbatim. →
   `FALLBACK_MODEL`; optionally also pick a vision-capable model (filter:
   vision) for `FALLBACK_VISION_MODEL`.

   Four roles share this one Fireworks account, each with its own id from
   [app.fireworks.ai/models](https://app.fireworks.ai/models): `FALLBACK_MODEL`
   is a Flash-sized model that keeps behavior closest to the Spark,
   `FALLBACK_VISION_MODEL` is a Flash-sized vision model (e.g. GLM 5.3
   Flash), `HARD_MODEL` is a strong model for `/hard` (e.g. GLM 5.3 or
   Kimi K3), and `STT_MODEL` is a Whisper model (e.g. `whisper-v3`) for
   voice transcription, since the droplet has no CPU budget to spare for
   faster-whisper — copy the exact id from that page for each, verbatim.

   **Thinking on Fireworks models.** The thinking switch differs per model
   family — open the model's page on
   [app.fireworks.ai](https://app.fireworks.ai), find its reasoning/thinking
   parameter, and paste it as JSON into the matching `*_EXTRA_BODY` variable
   (`FALLBACK_EXTRA_BODY`, `HARD_EXTRA_BODY`, `FALLBACK_VISION_EXTRA_BODY`).
   Recommended: thinking on for `HARD_MODEL`, off for `FALLBACK_MODEL`.
   `STT_MODEL` has no thinking switch.

6. **Digital Ocean droplet details.** From the droplet's page in the DO
   console: its public IPv4 address and the SSH user you created (usually
   `root` or your own user). A $6/month 1 vCPU / 1 GB droplet is enough —
   Whisper never runs on it (`STT_PROVIDER=api`, item 5), so there's no
   model to hold in memory; `lsb_release -a` (Ubuntu version; 24.04 LTS is
   what `deploy/install.sh` assumes) is worth a glance. Install Tailscale
   there with the one-liner from
   [tailscale.com/download/linux](https://tailscale.com/download/linux),
   then `sudo tailscale up` and follow the printed login URL. →
   `KNOWLEDGE_DIR`, `DATA_DIR`, `KOKORO_MODEL_DIR` all live under this
   user's home directory.

7. **The Spark's Tailscale hostname.** On the Spark, `tailscale status`
   prints its MagicDNS name and `100.x.y.z` address — either works. vLLM
   must listen on the Tailscale interface, not just localhost: publish the
   port as `-p 8888:8888` (not `-p 127.0.0.1:8888:8888`) and confirm from
   the droplet with `curl -s http://<spark-hostname>:8888/v1/models`. →
   `OPENAI_BASE_URL=http://<spark-hostname>:8888/v1`, `VISION_BASE_URL` the
   same, plus `CHAT_MODEL` / `VISION_MODEL` matching what the Spark serves.

8. **A GitHub deploy key for the droplet.** The repo is private, so the
   droplet needs its own read access to it. On the droplet:
   `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_telegrammanager -N ""`. On
   GitHub: repo → **Settings → Deploy keys → Add deploy key**, paste
   `~/.ssh/id_ed25519_telegrammanager.pub` (read-only is enough). Nothing to
   put in `.env` — this just lets `git clone git@github.com:...` work.
   Continue with README §1.4.

9. **The Spark and Mac bare repos.** On the Spark: `git init --bare
   ~/backups/knowledge.git`. On the Mac: the same, `git init --bare
   ~/backups/knowledge.git`. The Mac needs Tailscale running (install it,
   `tailscale up`) and Remote Login enabled (System Settings → General →
   Sharing → turn on Remote Login) so it accepts SSH over the tailnet. On
   the droplet, `ssh-keygen -t ed25519` (no passphrase — systemd runs the
   push unattended) if it doesn't already have a key, and append
   `~/.ssh/id_ed25519.pub` to `~/.ssh/authorized_keys` on both the Spark
   and the Mac. →
   `KNOWLEDGE_REMOTES=<spark-user>@<spark-hostname>:backups/knowledge.git,<mac-user>@<mac-hostname>:backups/knowledge.git`

   Why not GitHub? A private GitHub repo is still plaintext to GitHub, and
   this bundle holds home address, schedule, health and school data — so
   backups go only to machines the owner controls, over the tailnet.

10. **Backblaze B2 for the nightly `restic` backup.**
    [backblaze.com](https://www.backblaze.com) → **B2 Cloud Storage** →
    create a bucket (private) → **Application Keys** → create a new key
    scoped to that bucket. On the droplet, create
    `~/telegramManager/.restic.env` (mode 600) with:
    `RESTIC_REPOSITORY=b2:<bucket>:assistant`, `RESTIC_PASSWORD` (a new
    passphrase for the repo, or `RESTIC_PASSWORD_FILE` pointing at one),
    `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY` from the application key. Run
    `restic init` once (see `deploy/backup.sh` header), then add its cron
    line. Restore with `restic restore latest --target /path`.

11. **Google Maps key (optional).**
    [console.cloud.google.com](https://console.cloud.google.com) → pick or
    create a project → **APIs & Services** → **Library**: enable both the
    **Geocoding API** and the **Directions API** → **Credentials** →
    Create credentials → API key, and restrict it to those two APIs.
    Without it, travel time falls back to each event's stored
    `travel_minutes`. → `GOOGLE_MAPS_API_KEY`

Then copy `.env.example` to `.env`, fill those lines in, `chmod 600 .env`,
and follow README §1.4.

## Alternative: run everything on the Spark

Extra items needed only if you'd rather run the bot on the Spark itself
instead (README §1.5), free but down whenever the Spark is — voice input
also runs locally there (`STT_PROVIDER=local`) instead of through
Fireworks, so skip the `STT_*` lines from item 5 above.

12. **A GitHub deploy key for the Spark.** The repo is private, so the Spark
    needs its own read access to it. On the Spark (as `giospark1`):
    `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_telegrammanager -N ""`. On
    GitHub: repo → **Settings → Deploy keys → Add deploy key**, paste
    `~/.ssh/id_ed25519_telegrammanager.pub` (read-only is enough). Nothing
    to put in `.env` — this just lets `git clone git@github.com:...` work.
    Continue with README §1.5.

13. **The Mac bare repo.** On the Mac: `git init --bare
    ~/backups/knowledge.git`. The Mac needs Tailscale running (install it,
    `tailscale up`) and Remote Login enabled (System Settings → General →
    Sharing → turn on Remote Login) so it accepts SSH over the tailnet. On
    the Spark, install Tailscale too and join the same tailnet, then
    `ssh-keygen -t ed25519` (no passphrase — systemd runs the push
    unattended) if it doesn't already have a key, and append
    `~/.ssh/id_ed25519.pub` to `~/.ssh/authorized_keys` on the Mac. →
    `KNOWLEDGE_REMOTES=<mac-user>@<mac-hostname>:backups/knowledge.git`

Then follow README §1.5.
