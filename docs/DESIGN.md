# RAPS Powerplay WhatsApp Assistant: Design (v1 proposal)

Status: **proposal, awaiting confirmation**. No implementation code until the
decisions in §8 are confirmed.

## 1. Shape of the system

```
Customer WhatsApp ──► Meta Cloud API ──► ngrok (static domain) ──► n8n WF1 webhook
                                                                     │
                     ┌───────────────────────────────────────────────┘
                     ▼
   WF1: verify signature → POST /messages (log + dedupe + upsert lead)
        → GET /leads/:phone (structured profile)
        → AI Agent (Claude) with Postgres chat memory keyed by phone
             tools ──HTTP──► RAPS API  (never SQL)
        → send reply via Cloud API → POST /messages (log outbound)

   WF2 reminders (cron) ─┐
   WF3 review asks (cron)├──► RAPS API job endpoints ──► approved templates
   WF4 owner digest     ─┘
```

* **RAPS API** (Node 22, Express 5, `pg`, `zod`) is the only thing that touches
  the app database. Express 5 forwards rejected promises to the error handler,
  so one central handler maps errors to JSON responses.
* **Auth**: every route except `/health` requires `x-api-key`. The key lives in
  the n8n env, never in prompts.
* **n8n** uses its own database (`n8n`) on the same Postgres server. The agent's
  transcript memory (`n8n_chat_histories`) lives there.
* **Timezone**: all business logic runs in `Asia/Kolkata`. Columns are
  `timestamptz`; the API accepts and returns local ISO strings with `+05:30`.

## 2. Data model

### 2.1 Inventory

```sql
CREATE TABLE units (
  id          serial PRIMARY KEY,
  code        text UNIQUE NOT NULL,          -- 'PS5-01' … 'PS5-06'
  status      text NOT NULL DEFAULT 'active' -- active | maintenance | retired
              CHECK (status IN ('active','maintenance','retired')),
  notes       text
);
```

For v1 a **unit means a full kit**: PS5, TV, TV stand, cables, stands, and
controllers. Controllers and TVs are not tracked separately (§8, Q-C).

### 2.2 Bookings

A booking is a header row plus one row per unit. The overlap guarantee sits on
the per-unit rows, because the EXCLUDE constraint has to compare one unit at a
time.

```sql
CREATE TABLE bookings (
  id                 bigserial PRIMARY KEY,
  ref                text UNIQUE NOT NULL,         -- 'RP-1042', said to customers
  lead_id            bigint NOT NULL REFERENCES leads(id),
  kind               text NOT NULL CHECK (kind IN ('birthday','rental')),
  status             text NOT NULL DEFAULT 'held'
                     CHECK (status IN ('held','confirmed','completed',
                                       'cancelled','expired','no_show')),
  setups             int  NOT NULL CHECK (setups BETWEEN 1 AND 6),

  -- What the customer sees
  event_start        timestamptz,   -- birthday only: gaming starts
  event_end          timestamptz,   -- birthday only: gaming ends (start + 3h default)
  rental_start_date  date,          -- rental only: delivery day
  rental_end_date    date,          -- rental only: pickup day

  -- Logistics (derived, owner can override)
  delivery_at        timestamptz NOT NULL,  -- team arrives / drop-off
  pickup_at          timestamptz NOT NULL,  -- teardown done / collected
  address            text,
  area               text,
  service_area_id    int REFERENCES service_areas(id),

  -- Money (quoted, not collected)
  price_total        int NOT NULL,          -- INR, whole rupees
  advance_due        int NOT NULL,          -- total × advance_pct for this kind (see settings)
  decoration         boolean NOT NULL DEFAULT false,
  decoration_price   int,                   -- null until the owner prices it

  -- Rental-only compliance
  id_proof_received  boolean NOT NULL DEFAULT false,
  agreement_signed   boolean NOT NULL DEFAULT false,

  hold_expires_at    timestamptz,           -- set while status = 'held'
  payment_claimed_at timestamptz,           -- customer says they paid (screenshot); pauses expiry
  hold_nudged_at     timestamptz,           -- customer reminded that the hold is about to expire
  reminder_sent_at   timestamptz,
  review_asked_at    timestamptz,
  idempotency_key    text UNIQUE,           -- dedupes agent retries
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CHECK (pickup_at > delivery_at),
  CHECK ((kind = 'birthday' AND event_start IS NOT NULL AND event_end IS NOT NULL)
      OR (kind = 'rental'   AND rental_start_date IS NOT NULL AND rental_end_date IS NOT NULL))
);

CREATE TABLE booking_units (
  booking_id  bigint NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  unit_id     int    NOT NULL REFERENCES units(id),
  period      tstzrange NOT NULL,     -- [delivery_at - travel buffer, pickup_at + travel buffer)
  status      text NOT NULL,          -- copy of bookings.status, kept in sync in the same txn
  PRIMARY KEY (booking_id, unit_id),

  CONSTRAINT no_double_booking EXCLUDE USING gist (
    unit_id WITH =,
    period  WITH &&
  ) WHERE (status IN ('held','confirmed'))
);
```

**Blocked period per unit**
* *Birthday*: `[event_start − setup_buffer − travel_buffer, event_end + teardown_buffer + travel_buffer)`.
  Defaults: setup 45 min, teardown 30 min, travel 60 min each way. All are
  configurable in `settings`. A unit can then do a morning and an evening party
  only when the gap allows it.
* *Rental*: `[rental_start_date 09:00, rental_end_date 20:00)` IST. Delivery and
  pickup happen inside business hours on those days.

**Holds vs confirmed (decided: Q-1).** A booking only becomes confirmed after
the advance, which can take hours. If unpaid requests did not block units,
two parents could both be told "you're booked" for the same slot. So a
bot-created booking starts as `held`, which **also blocks** units, and expires
after `hold_hours`. Expired holds are swept to `expired` at the start of every
availability check and booking transaction, so a stale hold never blocks a real
customer.

*How payment becomes known:* the bot cannot see the owner's UPI or bank
account. The owner confirms each payment himself with a `PAID` command from
his personal number (§3, Owner commands).
* If a customer sends a payment screenshot, the bot replies that the team will
  verify, forwards it to the owner, and sets `payment_claimed_at`. A claimed
  hold **does not auto-expire**; it waits for the owner. A screenshot alone
  never confirms a booking.
* **Hold duration is 2 hours** (owner's decision), stored as `hold_minutes=120`
  in `settings`. When the hold is placed, the bot sends the payment details
  (UPI ID / QR, see Q-J) and says the slot is held for 2 hours.
* About 30 minutes before an unclaimed hold expires, the **customer** gets a
  nudge ("Your slot is held until 4:15pm, share the payment screenshot once
  done"). This is free because it falls inside their 24h window. The owner is
  not pinged for every unpaid hold; expired holds appear in the nightly digest.

**Booking transaction**
1. `BEGIN`; sweep expired holds (`UPDATE … SET status='expired' WHERE status='held' AND hold_expires_at < now()`).
2. Compute the blocked period; pick N free active units, lowest code first.
3. Insert `bookings` and `booking_units`; `COMMIT`.
4. On SQLSTATE `23P01`, roll back and retry from step 1, up to 3 times. If
   there are still not enough units, return `409 { code: 'UNAVAILABLE', alternatives: [...] }`.

### 2.3 Leads (structured profile)

One row per WhatsApp number. The agent fills it in as facts arrive.

```sql
CREATE TABLE leads (
  id                 bigserial PRIMARY KEY,
  phone              text UNIQUE NOT NULL,    -- E.164 without '+', as Meta sends it: '9198…'
  name               text,
  language           text,                    -- 'en' | 'hi' | 'hinglish'
  source             text,                    -- ad / referral / organic (from Meta referral payload)
  ad_ref             jsonb,                   -- raw ctwa referral (ad id, headline) when present

  intent             text NOT NULL DEFAULT 'unknown'
                     CHECK (intent IN ('birthday','rental','general','sponsorship','unknown')),
  stage              text NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new','qualifying','quoted','booking_held',
                                      'booked','completed','lost','handed_off')),

  -- Birthday qualifiers (the owner's flow: area → date → kids → setups → price → decoration)
  occasion           text,                    -- 'birthday' | 'other'
  event_date         date,
  preferred_start    time,
  area               text,
  service_area_id    int REFERENCES service_areas(id),
  in_service_area    boolean,                 -- null = not yet checked / unknown locality
  venue_type         text,                    -- home | society clubhouse | banquet | other
  num_kids           int,
  num_guests         int,
  child_age          int,
  setups_needed      int,
  decoration_wanted  boolean,

  -- Rental qualifiers
  rental_start_date  date,
  rental_end_date    date,

  games_interest     text[],
  notes              text,

  needs_human        boolean NOT NULL DEFAULT false,
  bot_paused_until   timestamptz,             -- owner takeover: WF1 logs but doesn't reply
  opted_out          boolean NOT NULL DEFAULT false,
  last_inbound_at    timestamptz,             -- drives the 24h service-window check
  last_outbound_at   timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
```

The API returns the profile with a computed `missing_for_quote` array, for
example `["area","event_date","num_kids"]`. The prompt rule is simple: *if
`missing_for_quote` is non-empty, ask for those fields (one or two at a time);
otherwise quote.* This makes "ask before quoting, skip if already given" work
without the LLM inferring it from the transcript. A returning lead gets the
same profile back days later.

### 2.4 Messages (audit log + idempotency)

```sql
CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  lead_id        bigint NOT NULL REFERENCES leads(id),
  direction      text NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id  text UNIQUE,              -- Meta retries webhooks; this dedupes them
  kind           text NOT NULL DEFAULT 'text',  -- text | template | interactive | media | owner_command
  template_name  text,
  body           text,
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

This table is separate from n8n's chat memory on purpose. n8n memory is a
rolling window for the LLM. `messages` is the complete record, used for the
digest, the 24h window, and debugging.

### 2.5 Service areas

```sql
CREATE TABLE service_areas (
  id        serial PRIMARY KEY,
  region    text NOT NULL,           -- 'Mumbai' | 'Navi Mumbai' | 'Thane West' | 'Vasai'
  locality  text NOT NULL,           -- 'Andheri West', 'Vashi', 'Ghodbunder Road', …
  aliases   text[] NOT NULL DEFAULT '{}',  -- 'andheri w', 'lokhandwala', …
  pincodes  text[] NOT NULL DEFAULT '{}',
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (region, locality)
);
```

The check returns `in_area: true | false | null`. `null` means an unknown
locality. In that case the bot says it will confirm, and a low-priority
handoff is opened. I will seed this table with a curated locality list and the
owner can correct it.

### 2.6 Rates and settings

```sql
CREATE TABLE rates (
  code        text PRIMARY KEY,       -- 'birthday_station' | 'rental_week' | 'decoration'
  label       text NOT NULL,
  amount      int,                    -- INR; NULL = "price on request" (decoration today)
  unit        text NOT NULL,          -- 'per_setup' | 'per_week' | 'per_event'
  includes    text[] NOT NULL DEFAULT '{}',
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
-- hold_minutes=120, hold_nudge_before_min=30, setup_buffer_min=45, teardown_buffer_min=30, travel_buffer_min=60,
-- birthday_default_hours=3, business_open='09:00', business_close='20:00',
-- kids_per_setup=10 (TBD), min_lead_days=0,
-- advance_pct_rental=10, advance_pct_birthday=50 (pending Q-K)
```

The **API does all price arithmetic** (`POST /quotes`). The LLM never
multiplies rupees. For rental durations that are not whole weeks, the quote
returns `needs_owner_confirmation: true` until Q-A is answered.

### 2.7 Payments (recorded, not collected)

```sql
CREATE TABLE payments (
  id           bigserial PRIMARY KEY,
  booking_id   bigint NOT NULL REFERENCES bookings(id),
  kind         text NOT NULL CHECK (kind IN ('advance','balance','damage','other')),
  amount       int NOT NULL,
  method       text,                  -- upi | cash | bank
  received_at  timestamptz NOT NULL DEFAULT now(),
  note         text
);
```

Recording an `advance` payment moves the booking from `held` to `confirmed`.
The digest's revenue figure comes from this table.

### 2.8 Handoffs (human escalation and sponsorship)

```sql
CREATE TABLE handoffs (
  id           bigserial PRIMARY KEY,
  lead_id      bigint NOT NULL REFERENCES leads(id),
  booking_id   bigint REFERENCES bookings(id),
  reason       text NOT NULL CHECK (reason IN (
                 'sponsorship','human_requested','complaint','custom_quote',
                 'out_of_area','unknown_area','cancellation_paid','reschedule',
                 'damage','other')),
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','urgent')),
  summary      text NOT NULL,         -- agent-written one-liner for the owner
  details      jsonb,                 -- sponsorship: event, date, venue, footfall, ask (free/paid)
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
```

Creating a handoff sets `leads.needs_human = true` and sends the owner an
immediate template notification (urgent and sponsorship handoffs only; the
rest wait for the digest).

## 3. REST API

All bodies are JSON, all routes need `x-api-key`, and errors look like
`{ error: { code, message, details? } }`.

| Method & path | Used by | Purpose |
|---|---|---|
| `GET /health` | compose / ops | Liveness (no auth) |
| **Leads and messages** | | |
| `POST /messages` | WF1 (deterministic node) | Log in/out message; upsert lead; update `last_inbound_at`; returns `{ duplicate, lead, bot_paused }` |
| `GET /leads/:phone` | WF1, before the agent runs | Profile + `missing_for_quote` + active bookings + open handoffs |
| `PATCH /leads/:phone` | agent tool `update_lead_profile` | Partial update of profile fields (allow-listed) |
| **Catalogue** | | |
| `GET /rates` | agent `get_rates` | Rates, inclusions, policies blurb |
| `GET /service-areas/check?q=` | agent `check_service_area` | `{ in_area, region, locality, matched_on }` |
| `POST /quotes` | agent `get_quote` | `{ kind, setups, num_kids?, decoration?, start/end }` → `{ total, advance_due, balance_due, suggested_setups, line_items, needs_owner_confirmation }` |
| **Availability and bookings** | | |
| `GET /availability` | agent `check_availability` | birthday: `date, start_time, setups`; rental: `start_date, end_date, setups` → `{ available, free_units, alternatives[] }` (nearby slots/days) |
| `POST /bookings` | agent `create_booking` | Creates a **held** booking (transaction + 23P01 retry). Header `Idempotency-Key` |
| `GET /bookings?phone=&status=` | agent `find_bookings`, WF4 | Bookings for a phone |
| `GET /bookings/:ref` | owner / agent | One booking |
| `POST /bookings/:ref/cancel` | agent `cancel_booking` | `held` → cancelled now, owner gets a one-line note. `confirmed` → **not cancelled**; opens an urgent `cancellation_paid` handoff and the owner decides (§3.1) |
| `POST /bookings/:ref/reschedule-request` | agent `request_reschedule` | Any booking, paid or not. Never moves anything. Returns the requested day's schedule + an API-computed feasibility verdict, opens a `reschedule` handoff, alerts the owner (§3.1) |
| `POST /bookings/:ref/move` | owner command `MOVE` | Re-checks availability and moves the booking atomically (same EXCLUDE constraint, 23P01 retry) |
| `GET /schedule?date=` | owner `TODAY`/`TOMORROW`, reschedule alert | All held/confirmed bookings that day with times, setups, area, and free units per time window |
| `POST /bookings/:ref/payments` | owner command | Record payment; advance ⇒ `confirmed` |
| `PATCH /bookings/:ref` | owner command | Status (`completed`, `no_show`), address, time overrides, ID/agreement flags |
| **Handoffs** | | |
| `POST /handoffs` | agent `flag_for_human` | Create handoff; optionally pause the bot for this lead |
| `GET /handoffs?status=open` | WF4 | |
| `POST /handoffs/:id/resolve` | owner command | Resolve and un-pause the bot |
| **Jobs** | | |
| `GET /jobs/reminders-due` | WF2 | Confirmed bookings starting within N hours with no `reminder_sent_at` |
| `GET /jobs/reviews-due` | WF3 | Completed bookings from the last N hours with no `review_asked_at` |
| `POST /jobs/mark` | WF2/WF3 | `{ booking_ref, field: 'reminder_sent_at' \| 'review_asked_at' }` |
| `GET /reports/digest?date=` | WF4 | Bookings made, events tomorrow, revenue received, no-shows, holds expiring, open handoffs, and a pre-flattened `text` (newlines → ` · `) for the template variable |

### Agent tools (one HTTP Request Tool each)

`get_rates`, `check_service_area`, `get_quote`, `check_availability`,
`create_booking`, `find_bookings`, `cancel_booking`, `request_reschedule`,
`update_lead_profile`, `flag_for_human`.

### 3.1 Cancellations and reschedules (decided: Q-2)

| Customer asks to… | Unpaid (`held`) | Paid (`confirmed`) |
|---|---|---|
| **Cancel** | Bot cancels it itself; the unit is freed at once; owner gets a one-line note | Bot does **not** cancel. It replies kindly ("our team will call you shortly"), never argues refunds, and sends the owner an urgent alert. The owner decides and sends `CANCEL RP-…` if needed |
| **Reschedule** | Escalated to the owner | Escalated to the owner |

**Reschedule alert.** The bot never moves a booking itself. It collects the
new date (and time, for birthdays) and calls `request_reschedule`. The **API**,
not the LLM, works out the day's schedule and whether the move fits, applying
the same buffers and unit count as a new booking. The owner receives:

```
🔁 Reschedule request: RP-1042
Priya (98XXXXXXXX) · paid ₹9,000
From: Sat 18 Oct, 3:30–6:30pm, 2 setups
To:   Sun 26 Oct, 4:00–7:00pm, 2 setups

Sun 26 Oct bookings:
• RP-1051 11:00am–2:00pm · 1 setup · Andheri W
• RP-1057 3:30–6:30pm · 3 setups · Vashi
Free at 4:00pm: 2 of 6 units

✅ Can be accommodated.
Reply: MOVE RP-1042 2026-10-26 16:00
```

When the move does not fit, the last lines read "❌ Cannot be accommodated:
only 1 unit free at 4:00pm" and list the nearest times that do fit that day.

The customer is told only that the request has gone to the team; the bot never
promises the new date. The new slot is **not** held while the owner decides,
so `MOVE` re-checks at the moment he sends it. If it was taken in the meantime,
he gets "❌ No longer free" plus alternatives. On success the customer is told
the new date and time.

Two deliberate differences from the brief:
* **The agent does not log messages.** WF1 logs inbound and outbound messages
  in fixed nodes before and after the agent. A step the LLM can forget would
  leave holes in the audit log.
* **The customer's phone is never an LLM parameter.** Every tool that takes a
  phone gets it from the webhook payload (`{{$('Webhook').item.json…from}}`),
  not from `$fromAI()`. A message like "cancel the booking for 98xxxxxx" then
  cannot touch someone else's booking.

### Owner commands (no dashboard)

The bot runs on the business number (`BUSINESS_PHONE`, 9082201911). The owner
saves that number on his **personal** phone and chats with it like a customer
would. Every webhook carries the sender's number (`from`), verified by
WhatsApp, so it cannot be spoofed. WF1's first step is a single check:

* `from == OWNER_PHONE` → **owner mode**: no AI, no lead record, no sales
  reply. A strict, case-insensitive parser runs the command against the API.
* anything else → customer mode (the AI Agent flow).

Exactly one owner number in v1 (`OWNER_PHONE`, his personal number).

```
PAID RP-1042 4500 [upi|cash|bank] → record payment; the first one counts as the advance ⇒ confirmed
DONE RP-1042                      → status completed
NOSHOW RP-1042                    → status no_show
CANCEL RP-1042                    → cancel
RESOLVE 17                        → resolve handoff 17, un-pause the bot for that lead
MOVE RP-1042 2026-10-26 16:00     → move the booking (birthday: date + start time; rental: new start date)
TODAY / TOMORROW                  → short schedule
HELP (or anything unrecognised)   → list of commands
```

Every owner command gets a **one-line confirmation** reply, and mistakes get a
one-line error. The reply is free because it falls inside the owner's 24h
window.

```
PAID RP-1042 9000   → ✅ RP-1042 confirmed (Priya, Sat 18 Oct, 2 setups). Priya notified.
PAID RP-1024 9000   → ❌ No booking RP-1024. Did you mean RP-1042 (Priya)?
DONE RP-1042        → ✅ RP-1042 marked completed. Review request will go out.
```

When a `PAID` confirms a booking, the customer gets a separate confirmation
message (free-form if inside their 24h window, otherwise the
`booking_confirmed` template).

## 4. Workflows

* **WF1 inbound**: Webhook (GET returns `hub.challenge` after checking
  `hub.verify_token`; POST checks `X-Hub-Signature-256`) → ignore status
  callbacks → owner? → command parser : (`POST /messages` → duplicate/opted-out/paused?
  stop → `GET /leads/:phone` → AI Agent [system prompt + profile JSON + Postgres
  memory keyed by phone, last ~30 turns] → send text → `POST /messages` out).
* **WF2 reminders** (hourly): `reminders-due` → template `booking_reminder`
  (date, time, setups, ref) → mark.
* **WF3 review asks** (hourly, 9am–8pm only): `reviews-due` → template
  `review_request` → mark.
* **WF4 owner digest** (21:00 IST): `GET /reports/digest` → template
  `owner_digest` with the flattened text as a single mid-body variable.

Templates to submit for Meta approval: `booking_confirmed`, `booking_reminder`, `review_request`,
`owner_digest`, `owner_alert` (urgent handoff), and optionally `lead_followup`
(re-engage a quoted lead after 24h). Each variable is used once, never first
or last in the body, and contains no newlines.

## 5. Agent behaviour (prompt outline, `prompts/system.md`)

1. Identity and tone: RAPS Powerplay, "Everyone deserves to play." About 90%
   professional and 10% warm, written for parents. Reply in the customer's
   language (English, Hindi, or Hinglish). A few emojis are fine.
2. Routing by `intent` + `stage` + current message: birthday / rental /
   general Q&A / sponsorship.
3. Birthday flow: area (check) → date → kids → suggested setups → quote →
   decoration upsell → availability → hold → explain 50/50 terms and that the
   owner confirms once the advance is received.
4. Rental flow: area → dates → units → quote → availability → hold → explain
   ID proof + agreement.
5. Sponsorship: warm branded intro, collect event name/date/venue/footfall/ask,
   `flag_for_human(reason='sponsorship')`, give the escalation number.
6. Hard rules: never invent prices or availability (always call the tool),
   never promise refunds, hand off when unsure, and only quote what the API
   returns.
7. Curated knowledge: inclusions, games list, policies, service areas, hours.
   It lives in the prompt; no RAG.

## 6. Repo layout

```
api/            Express API (src/routes, src/db, src/services, test/)
db/init/        one-time Postgres init (n8n db, btree_gist)
db/migrations/  numbered SQL migrations + seed (units, rates, settings, areas)
n8n/workflows/  exported WF1–WF4 JSON
prompts/        agent system prompt + knowledge
docs/           this design, Meta setup runbook
```

Tests use `node:test` + `supertest` against a real Postgres from compose. The
double-booking test fires parallel `POST /bookings` for the last free unit and
asserts exactly one succeeds.

## 7. Build order once confirmed

1. Migrations + seed → 2. API (leads/messages, rates, areas, quotes,
availability, bookings with the concurrency test, handoffs, jobs/digest) →
3. System prompt → 4. WF1 → 5. Meta setup runbook + templates → 6. WF2–WF4.

## 8. Decisions for you to confirm

Design calls (my recommendation first):

* **Q-1 Held bookings: DECIDED.** Unpaid bot bookings are `held` for **2
  hours** and block units. The owner confirms payment with `PAID` from his
  personal number and gets a one-line reply. Only one owner number.
* **Q-2 Cancel / reschedule: DECIDED** (§3.1). The bot cancels unpaid
  bookings itself. Paid cancellations and all reschedules go to the owner,
  with the day's schedule and an accommodate yes/no.
* **Q-3 Owner commands over WhatsApp: DECIDED** (§3).
* **Q-4 LLM.** Recommended: Claude in the n8n AI Agent node (Anthropic
  credential).
* **Q-5 WhatsApp number migration.** Moving the current business number onto
  the Cloud API normally removes it from the WhatsApp Business app unless it is
  onboarded with Meta's *coexistence* option. Is the owner replying from the
  app today, and should we use coexistence or a fresh number?
* **Q-6 Travel buffer** of 60 min each side for birthdays. Is that realistic
  across Mumbai ↔ Vasai, or should it vary by region?

Owner facts still open (from the brief, plus two new ones):

* **Q-A** Rental pricing beyond ₹3,000/week (daily / multi-day tiers).
* **Q-B** Decoration price(s).
* **Q-C** Controllers for a normal rental (1 vs 4), and whether TVs and
  controllers ever run short independently of consoles.
* **Q-D** Birthday slot: is 3:30–6:00 fixed, or chosen per booking within
  9am–8pm?
* **Q-E** Age restrictions.
* **Q-F** Ads, hooks, and per-ad openers (the Meta referral payload lets us
  tailor the first reply).
* **Q-G** Real chat screenshots for tone.
* **Q-H (new)** Kids-per-setup rule of thumb for "suggest number of setups"
  (placeholder: 10 kids/setup with 4 controllers, rotating).
* **Q-K (new) Advance amounts.** Normal rentals: 10% advance to book the
  slot. Still to confirm: is the remaining 90% paid on delivery/after install?
  Do birthdays stay at 50% advance + 50% after install? Advance % is stored
  per booking kind in `settings`.
* **Q-J (new, needed for the hold)** The UPI ID and/or QR image the bot
  sends with every hold, so the parent can actually pay within the hour.
* **Q-I (new)** Minimum notice: is same-day booking allowed by the bot, or
  should same-day requests always go to the owner?
