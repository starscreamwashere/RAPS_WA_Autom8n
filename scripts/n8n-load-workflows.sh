#!/usr/bin/env bash
# Loads the three workflows from n8n/workflows into the running n8n, publishes
# them and restarts n8n so they take effect. Run after the first start and
# after every update that changes the workflows (git pull).
#
#   ./scripts/n8n-load-workflows.sh
#
# The Gemini key is NOT loaded here: add it once in the n8n editor
# (Credentials → "Gemini (RAPS)"), see docs/DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T n8n n8n import:workflow --separate --input=/workflows
for id in raps-1-inbound raps-2-outbox-sender raps-3-scheduled-jobs; do
  docker compose exec -T n8n n8n publish:workflow --id="$id"
done
docker compose restart n8n
echo "Workflows loaded and published. n8n is restarting (about 30 s)."
