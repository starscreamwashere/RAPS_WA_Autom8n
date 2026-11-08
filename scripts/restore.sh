#!/usr/bin/env bash
# Restores one database from a dump made by scripts/backup.sh. Stops the API
# and n8n while it runs, replaces the database, then starts them again.
#
#   ./scripts/restore.sh backups/raps-2026-11-09_0315.dump raps
#   ./scripts/restore.sh backups/n8n-2026-11-09_0315.dump n8n
set -euo pipefail
cd "$(dirname "$0")/.."
file=${1:?usage: restore.sh <dump file> <database>}
db=${2:?usage: restore.sh <dump file> <database>}
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
PGUSER=$(env_get POSTGRES_USER)

read -r -p "Replace database '$db' with $file? Everything in it now is lost. [y/N] " ok
[ "$ok" = "y" ] || { echo "cancelled"; exit 1; }

docker compose stop api n8n
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\""
docker compose exec -T postgres pg_restore -U "$PGUSER" -d "$db" --no-owner --exit-on-error < "$file"
docker compose start api n8n
echo "restored $db from $file"
