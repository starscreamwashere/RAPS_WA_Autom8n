#!/usr/bin/env bash
# Backs up both databases (the bot's and n8n's: leads, bookings, messages,
# workflows, credentials) as compressed pg_dump files in ./backups, keeps
# BACKUP_KEEP_DAYS (default 14) of them, and, if RCLONE_REMOTE is set in .env,
# copies them off this machine (e.g. to Google Drive). See docs/DEPLOY.md.
#
#   ./scripts/backup.sh          # run by cron every night
set -euo pipefail
cd "$(dirname "$0")/.."

env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
PGUSER=$(env_get POSTGRES_USER)
APPDB=$(env_get POSTGRES_DB)
N8NDB=$(env_get N8N_DB); N8NDB=${N8NDB:-n8n}
DIR=$(env_get BACKUP_DIR); DIR=${DIR:-backups}
KEEP=$(env_get BACKUP_KEEP_DAYS); KEEP=${KEEP:-14}
REMOTE=$(env_get RCLONE_REMOTE)

mkdir -p "$DIR"
stamp=$(date +%Y-%m-%d_%H%M)
for db in "$APPDB" "$N8NDB"; do
  out="$DIR/$db-$stamp.dump"
  docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$db" --format=custom > "$out.part"
  mv "$out.part" "$out"
  echo "backed up $db → $out ($(du -h "$out" | cut -f1))"
done
find "$DIR" -name '*.dump' -mtime +"$KEEP" -delete

if [ -n "$REMOTE" ]; then
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$PWD/$DIR:/data:ro" -v "$HOME/.config/rclone:/config/rclone" \
    rclone/rclone:1.71 copy /data "$REMOTE" --max-age 3d
  echo "copied to $REMOTE"
fi
