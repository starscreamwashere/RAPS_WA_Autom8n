# Deploying the bot

The bot is one Docker Compose stack (Postgres, API, n8n) plus a front door
that lets only Meta's webhook in. It runs anywhere Docker runs. Two setups,
both free:

- **A. Oracle Cloud "Always Free" server** (recommended): a real server in a
  data centre, always on. ~1–2 hours the first time.
- **B. A laptop or PC left on** (fallback, or while Oracle sign-up is pending):
  ~1 hour. Customers get no reply while it is off or offline.

Measured needs: about 1 GB of RAM idle (n8n ~800 MB), ~3 GB of disk for the
images, a few hundred MB for data. Both options have far more than that.

Public address: **bot.rapspowerplay.com** (one DNS record on the owner's domain).
Meta sends WhatsApp messages to `https://bot.rapspowerplay.com/webhook/whatsapp`.
Only `/webhook/…` is reachable from the internet; the n8n editor, the API and the
database are not.

Who does what: **Owner** = Vindy (accounts, card verification, DNS if he holds
it). **Dev** = whoever runs the commands.

---

## A. Oracle Cloud Always Free

### 1. Account (owner, 20 min)

1. Sign up at <https://www.oracle.com/cloud/free/>. Pick **India South (Hyderabad)**
   or **India West (Mumbai)** as the *home region*. It cannot be changed later, and
   Always Free servers exist only in the home region.
2. Oracle verifies identity with a card (a small temporary hold, refunded). Indian
   **debit cards are often refused**; a credit card usually works. If sign-up fails
   twice, use plan B for now and retry later.
3. **Upgrade to Pay As You Go** (☰ → Billing → *Upgrade and manage payment*).
   Without it, Oracle may stop a free server that looks idle for 7 days (our bot
   uses little CPU most of the time). After the upgrade, Always Free resources stay
   free; you pay only if you create something outside the free limits, which these
   steps never do.
4. Set a safety net: Billing → **Budgets** → create a budget of ₹100 with an email
   alert at 1%. Any charge at all then emails the owner.
5. Add the dev as a user (Identity → Users) or share the login, the owner's choice.

### 2. Create the server (dev, 15 min)

☰ → Compute → Instances → **Create instance**:

| Setting | Value |
|---|---|
| Name | `raps-bot` |
| Image | **Canonical Ubuntu 24.04** (the *aarch64* build) |
| Shape | Ampere → **VM.Standard.A1.Flex**, **2 OCPU, 12 GB** (free limit is 4 OCPU / 24 GB in total) |
| Networking | create a new virtual cloud network with a **public subnet**; *Assign a public IPv4 address*: yes |
| SSH keys | *Generate a key pair* and **download the private key** (keep it safe; it is the only way in) |
| Boot volume | 50 GB (free limit is 200 GB in total) |

"Out of capacity" is common for free ARM servers: try another *availability
domain* in the same screen, or again a few hours later.

Note the **public IP address** shown once it is running.

### 3. Open ports 80 and 443 in Oracle's cloud firewall (dev, 5 min)

Instance → Subnet → **Security List** → *Add ingress rules*, twice:
source `0.0.0.0/0`, TCP, destination port **80**; same for **443**.
(Port 22 for SSH is already open.)

### 4. DNS record (owner or whoever manages rapspowerplay.com, 5 min)

At the domain's DNS provider add an **A record**: name `bot`, value = the server's
public IP, TTL 5 minutes. Check from any computer: `nslookup bot.rapspowerplay.com`.

### 5. Install (dev, 30 min)

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<public IP>
```

On the server, get the code. If the repository is private, add a read-only
**deploy key** first:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# GitHub → repo Settings → Deploy keys → Add deploy key (read-only), paste it
git clone git@github.com:starscreamwashere/RAPS_WA_Autom8n.git raps
cd raps
sudo ./scripts/server-setup.sh     # Docker, firewall, time zone, nightly backup
exit                               # log out and back in so docker works without sudo
```

Then fill in the settings ([section C](#c-settings-env)) and start it:

```bash
cd raps
cp .env.example .env && nano .env
docker compose up -d --build       # first build takes a few minutes on ARM
curl https://bot.rapspowerplay.com/healthz      # → ok (certificate is automatic)
```

Continue with [section D](#d-first-start-both-setups).

---

## B. Laptop or PC left on (fallback)

Good enough to go live while Oracle is being sorted out. Rules: plugged in,
**sleep disabled** (Windows: Settings → System → Power → *Never*; lid closing →
*Do nothing*), on a reliable Wi-Fi or cable, Windows Update set to restart outside
9am–8pm. A laptop rides out short power cuts on its battery; a PC needs a small UPS.

1. Install **Docker Desktop** (Windows: it sets up WSL 2; tick *Start Docker Desktop
   when you sign in*) and **Git**. On Windows run the commands below in the
   *Ubuntu (WSL)* terminal, so the scripts work as written.
2. Get the code: `git clone https://github.com/starscreamwashere/RAPS_WA_Autom8n.git raps && cd raps`
   (private repository: sign in when Git asks, or use a deploy key as in A5).
3. Choose how Meta reaches the laptop:

   **Cloudflare Tunnel** (recommended: keeps bot.rapspowerplay.com, no open ports).
   Needs the domain's DNS on Cloudflare (free). Moving DNS to Cloudflare means
   changing the domain's nameservers at the registrar; Cloudflare copies the
   existing records (website, email), but check them before switching.
   - Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
     (type *Cloudflared*), name `raps-bot`, copy the **token**.
   - In the tunnel, **Public hostname**: subdomain `bot`, domain `rapspowerplay.com`,
     service type **HTTP**, URL **`caddy:80`**.
   - `.env`: `COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN=<token>`,
     `CADDY_SITE=:80`, `CADDY_BIND=127.0.0.1`, `BOT_DOMAIN=bot.rapspowerplay.com`.

   **ngrok** (if the DNS cannot be moved): sign up at ngrok.com, claim the free
   static domain, then `.env`: `COMPOSE_PROFILES=ngrok`,
   `NGROK_AUTHTOKEN=<token>`, `BOT_DOMAIN=<your-name>.ngrok-free.app`. Meta's
   callback URL then uses that domain instead of bot.rapspowerplay.com.
4. Fill in the rest of `.env` ([section C](#c-settings-env)), then
   `docker compose up -d --build`. Containers restart by themselves after a reboot
   once Docker Desktop is running.
5. Backups: in WSL run `crontab -e` and add
   `15 3 * * * cd ~/raps && ./scripts/backup.sh >> backups/backup.log 2>&1`
   (WSL must be running; the off-machine copy in section E matters more here).

Continue with [section D](#d-first-start-both-setups). Moving to Oracle later: back
up, set up A, restore the two dumps there ([section F](#f-updates-restore-moving)),
point the DNS (or the tunnel) at the new place, and update Meta's callback URL if
the domain changed.

---

## C. Settings (`.env`)

Start from `.env.example`. Generate each secret with `openssl rand -hex 32`.

| Setting | Value |
|---|---|
| `COMPOSE_PROFILES` | `caddy` (Oracle), `tunnel` or `ngrok` (laptop) |
| `BOT_DOMAIN` | `bot.rapspowerplay.com` (or the ngrok domain) |
| `POSTGRES_PASSWORD`, `API_KEY`, `N8N_ENCRYPTION_KEY`, `WA_VERIFY_TOKEN` | random secrets |
| `OWNER_PHONE` | Vindy's personal number, `91…` |
| `LLM_MODELS` | `gemini-3.5-flash-lite,gemini-3.1-flash-lite` |
| `WA_*`, `META_*` | from `docs/META_SETUP.md` as each step completes |
| `ALERT_PUSH_URL` | the owner's ntfy topic URL ([section E](#e-alerts-and-backups)) |
| `HEARTBEAT_URL` | healthchecks.io ping URL ([section E](#e-alerts-and-backups)) |

**Keep a copy of `.env`** somewhere safe (a password manager or a private note).
`N8N_ENCRYPTION_KEY` in particular: a restored n8n backup cannot read its
credentials without it.

## D. First start (both setups)

```bash
./scripts/n8n-add-gemini-key.sh     # paste the Gemini key (hidden)
./scripts/n8n-load-workflows.sh     # import + publish the three workflows
curl https://bot.rapspowerplay.com/healthz
```

To open the **n8n editor** (Executions, debugging), it is never public. From your
computer:

```bash
ssh -i <key> -L 5678:localhost:5678 ubuntu@<public IP>    # Oracle
# then open http://localhost:5678 (on the laptop setup just open it there)
```

The first visit asks you to create the n8n owner account; use a strong password.

Then go on with Meta: `docs/META_SETUP.md` phase 4 (callback URL
`https://bot.rapspowerplay.com/webhook/whatsapp`).

## E. Alerts and backups

**Push alerts (owner, 5 min).** Install the **ntfy** app, subscribe to a long random
topic (e.g. `raps-7f3k9q2m1x`), set `ALERT_PUSH_URL=https://ntfy.sh/<topic>`.
Used when Meta disconnects or restricts the number.

**"Is the bot alive?" (5 min).** If the server itself disappears (Oracle stops it, the
laptop is off, n8n crashed), nothing on it can raise the alarm, so an outside
service watches for a ping that WF3 sends every 15 minutes:
1. Free account at <https://healthchecks.io> → *Add check*: period **15 minutes**,
   grace **30 minutes**, name `RAPS bot`.
2. Integrations → **ntfy** → the same topic, so the alert lands in the same app.
3. Copy the check's ping URL into `HEARTBEAT_URL`, then `docker compose up -d`.

**Backups.** `scripts/backup.sh` runs every night at 03:15 (set up by
`server-setup.sh`) and keeps 14 days of dumps in `backups/`. A copy on the same
machine does not survive losing the machine, so also send them elsewhere with
rclone, e.g. Google Drive (15 GB free):

```bash
docker run -it --rm -v ~/.config/rclone:/config/rclone rclone/rclone:1.71 config
# n) new remote, name: gdrive, storage: drive, scope: drive.file,
# "Use auto config?" n → it prints a command to run on a computer with a browser
# (needs rclone installed there), paste the result back
```

then `RCLONE_REMOTE=gdrive:raps-backups` in `.env`. Test once:
`./scripts/backup.sh` → the files appear in Google Drive.

## F. Updates, restore, moving

**Update** after new code is merged:

```bash
git pull
docker compose up -d --build        # database migrations run on API start
./scripts/n8n-load-workflows.sh     # if n8n/workflows changed
```

**Restore** a database from a dump (asks before replacing anything):

```bash
./scripts/restore.sh backups/raps-2026-11-09_0315.dump raps
./scripts/restore.sh backups/n8n-2026-11-09_0315.dump n8n
```

**Move** to another machine: copy `.env` and the two newest dumps, set up the new
machine (A or B), `docker compose up -d`, restore both dumps, point DNS (or the
tunnel) at it.

## Checks

| What | How |
|---|---|
| Front door up | `curl https://bot.rapspowerplay.com/healthz` → `ok` |
| Only the webhook is public | `https://bot.rapspowerplay.com/` → 404 |
| Containers | `docker compose ps` (all *Up*), logs: `docker compose logs -f n8n` |
| WhatsApp link | `curl -H "x-api-key: $API_KEY" localhost:3000/whatsapp/link` |
| Backups | `ls -lh backups/`, `tail backups/backup.log` |

Tested in a rehearsal (Nov 2026): the stack with the `caddy` profile served HTTPS,
answered Meta's verification through Caddy, logged a signed message, returned 404
for the editor and n8n's REST API, redirected HTTP to HTTPS; `backup.sh` and
`restore.sh` round-tripped the database; the firewall step in `server-setup.sh`
was checked against Oracle's default rules. Not testable from here: Oracle sign-up,
the ARM build itself (all images publish arm64), a real certificate, Cloudflare Tunnel.
