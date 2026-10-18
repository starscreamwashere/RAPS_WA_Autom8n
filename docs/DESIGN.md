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
        → AI Agent (Gemini; Claude later) with Postgres chat memory keyed by phone
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

For v1 a **unit means a full kit**: PS5, TV, TV stand, cables, and stands.
TVs are not tracked separately.

**Setups and controllers (decided: Q-H).** One PS5 takes up to **4
controllers**, so `suggested_setups = ceil(players / 4)` (4 people → 1 PS5 +
4 controllers; 10 people → 3 setups). Each booking stores `controllers`.
If the request needs more consoles than are free, or more controllers than
the `controllers_total` stock, the bot does **not** quote. It tells the parent
the team will work out the best setup with them and opens a `custom_quote`
handoff with the numbers; the owner agrees "n controllers and m consoles"
directly with them. Controllers are a pooled stock, so the booking
transaction also checks that controllers in overlapping held/confirmed
bookings + this booking ≤ `controllers_total`. That check runs under a
transaction-level advisory lock, because an EXCLUDE constraint cannot sum.

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
                                       'cancelled','expired','no_show','moved')),
  reschedule_of      bigint REFERENCES bookings(id),  -- tentative hold for a reschedule request
  setups             int  NOT NULL CHECK (setups BETWEEN 1 AND 6),
  controllers        int  NOT NULL CHECK (controllers >= setups),  -- ≤ 4 per setup

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
  Defaults: setup 45 min, teardown 30 min, travel **90 min each way, same
  for every area** (decided: Q-6, the owner tunes later). All are configurable
  in `settings`. A 3:30–6:30pm party blocks its kit from 1:15pm to 8:30pm. A unit can then do a morning and an evening party
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
  bot_paused_at      timestamptz,             -- owner typed from the app: WF1 logs but doesn't reply until RESUME
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
-- hold_minutes=120, hold_nudge_before_min=30, setup_buffer_min=45, teardown_buffer_min=30, travel_buffer_min=90,
-- birthday_default_hours=3, business_open='09:00', business_close='20:00',
-- controllers_per_setup_max=4, controllers_total=20,
-- same_day_allowed=true (must fit inside business hours incl. buffers),
-- advance_pct_rental=10 (90% on delivery), advance_pct_birthday=50 (50% after install)
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
| `POST /handoffs/:id/resolve` | owner command | Resolve the handoff |
| `POST /leads/:phone/pause` / `POST /leads/:phone/resume` | WF1 (app echo) / owner `RESUME` | Owner takeover on/off for one customer |
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
Reply: MOVE RP-1042 (or DECLINE RP-1042). New slot held for 2h.
```

When the move does not fit, the last lines read "❌ Cannot be accommodated:
only 1 unit free at 4:00pm" and list the nearest times that do fit that day.

The customer is told only that the request has gone to the team; the bot never
promises the new date.

**The requested new slot is held while the owner decides (decided).** If it
fits, `request_reschedule` places a tentative hold on it: a `held` booking with
`reschedule_of = <original id>`. It blocks units like any hold, for
`hold_minutes` (2h), and the owner is reminded 30 minutes before it lapses.
* `MOVE RP-1042` → in one transaction, the tentative booking takes over the
  original's status and payments, and the original is marked `moved`. The
  customer is told the new date and time.
* `DECLINE RP-1042` → the tentative hold is released and the original booking
  is untouched. The bot tells the customer the team will call them about
  other dates.
* If the hold lapses with no answer, it is released and the owner is told.
* If the requested slot does not fit, nothing is held; the alert shows the
  nearest times that do fit.

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
RESOLVE 17                        → resolve handoff 17
RESUME 98XXXXXXXX                 → bot takes over that customer's chat again (also: RESUME RP-1042)
PAUSED                            → list customers the bot is currently silent for
MOVE RP-1042                      → accept the held reschedule
MOVE RP-1042 2026-10-26 16:00     → move to a different date/time the owner agreed by phone
DECLINE RP-1042                   → reject the reschedule, release the held new slot
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
  callbacks → **app echo** (owner typed to a customer from the Business app)?
  → log it, `POST /leads/:phone/pause`, stop (§4.1) → owner? → command parser : (`POST /messages` → duplicate/opted-out/paused?
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

### 4.1 Coexistence and owner takeover (decided: Q-5)

The business number 9082201911 is onboarded to the Cloud API with Meta's
**coexistence** option, so it keeps working in the owner's WhatsApp Business
app alongside the bot. Meta sends a webhook echo for every message the owner
types from the app.

* When the owner types to a customer from the app, the bot **pauses for that
  customer** (`leads.bot_paused_at`) and stays silent **until the owner sends
  `RESUME <phone | booking ref>`** from his personal number. There is no
  timeout.
* Inbound messages from a paused customer are still logged, and profile facts
  still update, but the bot sends no reply.
* On first pause, the owner's personal number gets one line: "🤫 Bot paused for
  Priya (98XXXXXXXX). Send RESUME 98XXXXXXXX to hand back."
* The nightly digest lists every paused chat, so none is forgotten.
* Reminders (WF2) and review asks (WF3) for a paused customer still go out.
  They are templates about a booking, not conversation.
* The exact coexistence limits (features disabled in the app, history sync)
  are checked against Meta's current docs during setup.

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

### 5.1 Model evaluation before launch

`prompts/evals/` holds scripted test conversations, each with pass/fail checks:

* New birthday lead asks "what's the package?" → asks area/date/kids **before** quoting.
* Lead that already gave area/date/kids → quotes straight away, correct ₹ from `get_quote`.
* Returning lead days later → remembers the profile, doesn't re-ask.
* Hindi / Hinglish message → replies in kind.
* Out-of-area locality → polite decline or handoff, no booking.
* Rental request → 10% advance, 90% on delivery, mentions ID proof + agreement.
* Sponsorship ask → branded intro, collects details, `flag_for_human`.
* Cancel unpaid → cancels. Cancel paid → hands off, no refund argument.
* Reschedule → `request_reschedule`, never promises the new date.
* "Cancel the booking for 98xxxxxx" from another number → refused.
* Price haggling / invented discount → never invents prices.

The same set is used to accept the launch model (Gemini Flash) and, later, to
compare it against Claude Haiku 5.5 / Sonnet 5.5. The model is one setting in
the AI Agent node, so switching needs no rebuild.

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
* **Q-4 LLM: DECIDED.** **Google Gemini (Flash, free tier via Google AI
  Studio) for launch.** Claude (Haiku 5.5 → Sonnet 5.5) is added when lead
  volume grows. Known free-tier trade-offs, accepted: daily rate limits, no
  production guarantees, and Google may use free-tier data to improve its
  products. Safeguard: if the model call fails (quota, outage), WF1 sends a
  fixed holding reply ("Thanks! Our team will get back to you shortly 🧡"),
  logs it, and alerts the owner, so a lead is never left unanswered.
  **Model selection is discovered, not hard-coded**: `scripts/gemini-models.mjs`
  lists the models the key can see (`models.list`) and, with `--probe`, sends
  each one a tiny text request and a function-calling request. `models.list`
  does not say which models are free, so the probe is the only reliable check.
  The passing models go into `LLM_MODELS` in fallback order, stable before
  preview. Free quotas are per model, so the fallback order also stretches the
  free capacity. WF1 tries them in order on quota (429), not-found (404) or 5xx
  errors. A weekly WF4 check re-runs the probe and tells the owner/dev when a
  listed model stops working. It never switches models silently, because a new
  model must pass the §5.1 test set first.
* **Q-5 WhatsApp number: DECIDED** (§4.1). Coexistence; the bot stays silent
  for a customer after the owner types to them, until `RESUME`.
* **Q-6 Travel buffer: DECIDED.** 90 min each way for every area to start.
  The owner tunes it later via `settings` (per-region values can be added if
  needed).

Owner facts still open (from the brief, plus two new ones):

* **Q-A** Rental rate card. The chats show 1 day ₹950, 3 days ₹1,999, 7 days
  ₹2,749 (₹2,499 with story + Google review), plus extensions and a
  per-controller difference. The owner must confirm the table (OWNER_FACTS.md).
* **Q-B** Decoration price(s).
* **Q-C Controllers: DECIDED.** 20 in total. Normal rentals take 1 or 2
  (price depends on it); birthday setups take 4. Facts gathered from the
  owner's form and chat screenshots are in `docs/OWNER_FACTS.md`.
* **Q-D** Birthday slot: is 3:30–6:00 fixed, or chosen per booking within
  9am–8pm?
* **Q-E** Age restrictions.
* **Q-F** Ads: not required for the bot to work. Click-to-WhatsApp ads send a
  `referral` (ad id, headline, body) with the first message, which is stored on
  the lead automatically (`leads.ad_ref`) for intent and for "leads/bookings
  per ad" in the digest. What we do need: **any offer or price an ad
  promises**, so the bot honours it instead of contradicting it.
* **Q-G** Real chat screenshots for tone.
* **Q-H Setups: DECIDED.** ceil(players / 4); anything beyond free consoles or
  controller stock → owner handles it as a custom quote.
* **Q-K Advance amounts: DECIDED.** Normal rental: 10% advance to book,
  90% on delivery. Birthday: 50% advance, 50% after install. The advance is
  non-refundable on cancellation for both (existing policy, assumed unchanged).
* **Q-J (new, needed for the hold)** The UPI ID and/or QR image the bot
  sends with every hold, so the parent can actually pay within the hour.
* **Q-I Same-day: DECIDED.** Allowed when the whole job fits inside 9am–8pm:
  travel + setup must be able to start no earlier than now, and teardown +
  travel must end by 8pm.
* **Owner's personal number:** provided. It is set as `OWNER_PHONE` in the
  deployed `.env` only and kept out of git.
