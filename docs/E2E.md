# End-to-end test of the WhatsApp workflow (no WhatsApp needed)

This runs the real stack (Postgres, API, n8n) with Meta's Graph API replaced
by a small mock (`scripts/mock-graph.mjs`). A script then sends webhooks the
way Meta does, signed with the app secret, and checks what n8n sent back
and what the database recorded. Gemini is real, so it uses a few requests
of the daily quota.

## 1. Start the test stack

`.env` needs at least: `POSTGRES_*`, `API_KEY`, `N8N_ENCRYPTION_KEY`,
`WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `OWNER_PHONE`, `LLM_MODELS`. WhatsApp
tokens and ngrok can stay empty: the override points n8n at the mock.

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml \
  up -d --build postgres api n8n mock-graph
```

The test stack has its own volumes (`pgdata-e2e`, `n8ndata-e2e`), so it
never touches real data. Remove it afterwards with the same `-f` flags and
`down -v`.

## 2. Load the Gemini key and the workflows into n8n

```bash
# credential file (keep it out of git; delete it after)
cat > /tmp/cred.json <<EOF
[{"id":"raps-gemini","name":"Gemini (RAPS)","type":"googlePalmApi",
  "data":{"host":"https://generativelanguage.googleapis.com","apiKey":"$GEMINI_API_KEY"}}]
EOF
docker cp /tmp/cred.json raps-powerplay-n8n-1:/tmp/cred.json && rm /tmp/cred.json
docker exec raps-powerplay-n8n-1 sh -c 'n8n import:credentials --input=/tmp/cred.json && rm /tmp/cred.json'
docker exec raps-powerplay-n8n-1 n8n import:workflow --separate --input=/workflows
docker exec raps-powerplay-n8n-1 n8n publish:workflow --id=raps-1-inbound
docker exec raps-powerplay-n8n-1 n8n publish:workflow --id=raps-2-outbox-sender   # optional
docker compose -f docker-compose.yml -f docker-compose.e2e.yml restart n8n
```

## 3. Run the checks

```bash
RAPS_API_KEY=<API_KEY> OWNER_PHONE=<OWNER_PHONE> \
WA_APP_SECRET=<WA_APP_SECRET> WA_VERIFY_TOKEN=<WA_VERIFY_TOKEN> \
node scripts/e2e-wf1.mjs
```

| Check | What it proves |
|---|---|
| webhook verify | Meta's setup handshake: right token gets the challenge, wrong one 403 |
| bad signature | a forged webhook is ignored: nothing logged, nothing sent |
| owner command | a message from `OWNER_PHONE` goes to the command parser, not the AI |
| customer message | log → profile → Gemini agent with tools → reply sent to Meta and logged; price comes from the rate card |
| duplicate delivery | Meta retrying the same message does not produce a second reply |
| echo → pause | the owner typing from the WhatsApp Business app pauses the bot for that customer and queues a note for the owner |
| while paused | customer messages are logged, the bot stays quiet |
| RESUME | the owner's `RESUME <phone>` hands the customer back to the bot |
| WhatsApp username | a customer with no phone in the webhook (only a user ID) is answered by `recipient` and gets a lead |

With WF2 published, the "bot paused" notes in the outbox reach the mock
within 30 s: `curl localhost:4010/__sent`.

**Safety net (AI down):** restart n8n with `LLM_MODELS=no-such-model-a,no-such-model-b`
and run `node scripts/e2e-wf1.mjs --ai-down`. The customer must still get
"Thanks for your message! Our team will get back to you shortly 🧡" and the
owner an urgent handoff.

Looking at it in the n8n UI: http://localhost:5678 → Executions shows each
run node by node. The mock's record: `curl localhost:4010/__sent`.
