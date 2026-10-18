# RAPS Powerplay WhatsApp Assistant

WhatsApp assistant for **RAPS Powerplay**, a Mumbai service that runs PS5
Birthday Gaming Stations and weekly home rentals. *Everyone deserves to play.*

The assistant auto-replies to ad leads, qualifies them, quotes prices from the
API, checks availability across 6 PS5 kits, places booking holds, and hands
sponsorship requests and edge cases to the owner.

**Status:** database + REST API built and tested. Design: [`docs/DESIGN.md`](docs/DESIGN.md);
business facts: [`docs/OWNER_FACTS.md`](docs/OWNER_FACTS.md).

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

The API applies `db/migrations/*.sql` on every start, then listens on :3000.

## Tests

The tests run against a real Postgres 16 with `btree_gist`. Each test file
starts from a fresh schema.

```bash
cd api
npm install
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/raps_test npm test
```

These cover pricing, service areas, holds and expiry, the parallel
double-booking race, the shared controller stock, cancellations, reschedules,
owner commands, reminder jobs and the digest.
