#!/usr/bin/env bash
# Stores the Gemini API key in n8n as the credential the workflows use
# ("Gemini (RAPS)", id raps-gemini). Asks for the key without echoing it, so
# it never lands in shell history or a file on disk. Run again to replace it.
#
#   ./scripts/n8n-add-gemini-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -s -p "Gemini API key (from aistudio.google.com/apikey): " KEY; echo
[ -n "$KEY" ] || { echo "no key given"; exit 1; }
# The credential file exists only inside the container, only while importing
printf '[{"id":"raps-gemini","name":"Gemini (RAPS)","type":"googlePalmApi","data":{"host":"https://generativelanguage.googleapis.com","apiKey":"%s"}}]' "$KEY" \
  | docker compose exec -T n8n sh -c 'umask 077; cat > /tmp/gemini.json && n8n import:credentials --input=/tmp/gemini.json; rc=$?; rm -f /tmp/gemini.json; exit $rc'
echo "Saved. Restart n8n if workflows were already running: docker compose restart n8n"
