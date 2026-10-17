# RAPS Powerplay WhatsApp Assistant

WhatsApp assistant for **RAPS Powerplay**, a Mumbai service that runs PS5
Birthday Gaming Stations and weekly home rentals. *Everyone deserves to play.*

The assistant auto-replies to ad leads, qualifies them, quotes prices from the
API, checks availability across 6 PS5 kits, places booking holds, and hands
sponsorship requests and edge cases to the owner.

**Status:** scaffold + design proposal. See [`docs/DESIGN.md`](docs/DESIGN.md).

## Stack

- `api/`: Node 22 + Express 5 REST API (x-api-key auth) over PostgreSQL 16.
  Double-booking is prevented in the database by an `EXCLUDE USING gist` constraint.
- `n8n`: WF1 inbound → AI Agent → reply, WF2 reminders, WF3 review asks, WF4 owner digest.
- Meta WhatsApp Cloud API through an ngrok static domain.

## Run locally

```bash
cp .env.example .env   # fill in secrets
docker compose up -d --build
curl localhost:3000/health
```

n8n UI: http://localhost:5678
