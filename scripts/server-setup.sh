#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server (Oracle Cloud Always Free ARM, or any
# VPS) for the RAPS bot. Safe to run again. Run from the repo folder:
#
#   sudo ./scripts/server-setup.sh
#
# Installs Docker, opens ports 80/443 in the server's own firewall (Oracle's
# Ubuntu images block them by default), sets the time zone, and schedules the
# nightly backup. Oracle's cloud firewall (Security List) is opened separately
# in the console: see docs/DEPLOY.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
OWNER=${SUDO_USER:-ubuntu}

echo "== Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$OWNER"
systemctl enable --now docker

echo "== Firewall on the machine: allow 80 and 443"
if command -v iptables >/dev/null && iptables -S INPUT | grep -q -- '-j REJECT'; then
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
      # just before the REJECT rule, so it takes effect
      line=$(iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
      iptables -I INPUT "$line" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi
fi
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp; ufw allow 443/tcp
fi

echo "== Time zone"
timedatectl set-timezone Asia/Kolkata || true

echo "== Automatic security updates"
apt-get install -y unattended-upgrades >/dev/null && dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "== Nightly backup at 03:15"
CRON="15 3 * * * cd $REPO_DIR && ./scripts/backup.sh >> $REPO_DIR/backups/backup.log 2>&1"
mkdir -p "$REPO_DIR/backups" && chown "$OWNER" "$REPO_DIR/backups"
( crontab -u "$OWNER" -l 2>/dev/null | grep -v 'scripts/backup.sh'; echo "$CRON" ) | crontab -u "$OWNER" -

echo
echo "Done. Log out and back in (so '$OWNER' can use docker), then continue with docs/DEPLOY.md step 5."
