-- RAPS Powerplay core schema. See docs/DESIGN.md §2.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Generic updated_at maintenance
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

CREATE TABLE rates (
  code      text PRIMARY KEY,             -- 'birthday_station' | 'decoration'
  label     text NOT NULL,
  amount    int,                          -- INR; NULL = price on request
  unit      text NOT NULL,                -- 'per_setup' | 'per_event'
  includes  text[] NOT NULL DEFAULT '{}',
  active    boolean NOT NULL DEFAULT true
);

-- Normal rental rate card: one row per (package, controllers per console)
CREATE TABLE rental_rates (
  package      text NOT NULL CHECK (package IN ('day','week','month')),
  days         int  NOT NULL CHECK (days > 0),
  controllers  int  NOT NULL CHECK (controllers BETWEEN 1 AND 4),
  amount       int  NOT NULL CHECK (amount > 0),
  PRIMARY KEY (package, controllers)
);

-- ---------------------------------------------------------------------------
-- Inventory and service area
-- ---------------------------------------------------------------------------
CREATE TABLE units (
  id      serial PRIMARY KEY,
  code    text UNIQUE NOT NULL,           -- 'PS5-01' … 'PS5-06'
  status  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  notes   text
);

CREATE TABLE service_areas (
  id        serial PRIMARY KEY,
  region    text NOT NULL,                -- 'Mumbai' | 'Navi Mumbai' | 'Thane West' | 'Vasai'
  locality  text NOT NULL,
  aliases   text[] NOT NULL DEFAULT '{}', -- lower-case alternate spellings
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (region, locality)
);

CREATE TABLE service_pincode_ranges (
  id         serial PRIMARY KEY,
  region     text NOT NULL,
  pin_range  int4range NOT NULL
);

-- ---------------------------------------------------------------------------
-- Leads and conversation log
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id                 bigserial PRIMARY KEY,
  phone              text UNIQUE NOT NULL,   -- digits only with country code, as Meta sends it
  name               text,
  language           text,
  source             text,                   -- 'ad' | 'organic' | 'referral'
  ad_ref             jsonb,                  -- click-to-WhatsApp referral payload

  intent             text NOT NULL DEFAULT 'unknown'
                     CHECK (intent IN ('birthday','rental','general','sponsorship','unknown')),
  stage              text NOT NULL DEFAULT 'new'
                     CHECK (stage IN ('new','qualifying','quoted','booking_held',
                                      'booked','completed','lost','handed_off')),

  -- Birthday qualifiers
  occasion           text,
  event_date         date,
  preferred_start    time,
  venue_type         text,
  num_kids           int CHECK (num_kids > 0),
  num_guests         int CHECK (num_guests > 0),
  child_age          int,
  setups_needed      int CHECK (setups_needed > 0),
  decoration_wanted  boolean,

  -- Rental qualifiers
  rental_start_date  date,
  rental_days        int CHECK (rental_days > 0),
  controllers_wanted int CHECK (controllers_wanted BETWEEN 1 AND 4),

  -- Shared
  area               text,
  service_area_id    int REFERENCES service_areas(id),
  in_service_area    boolean,                -- null = unknown locality / not checked
  games_interest     text[],
  notes              text,

  needs_human        boolean NOT NULL DEFAULT false,
  bot_paused_at      timestamptz,            -- owner took over from the app; silent until RESUME
  opted_out          boolean NOT NULL DEFAULT false,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER leads_touch BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  lead_id        bigint NOT NULL REFERENCES leads(id),
  direction      text NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id  text UNIQUE,              -- Meta retries webhooks; this dedupes them
  kind           text NOT NULL DEFAULT 'text',
  template_name  text,
  body           text,
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_lead_idx ON messages (lead_id, created_at);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
CREATE SEQUENCE booking_ref_seq START 1001;

CREATE TABLE bookings (
  id                       bigserial PRIMARY KEY,
  ref                      text UNIQUE NOT NULL DEFAULT ('RP-' || nextval('booking_ref_seq')),
  lead_id                  bigint NOT NULL REFERENCES leads(id),
  kind                     text NOT NULL CHECK (kind IN ('birthday','rental')),
  status                   text NOT NULL DEFAULT 'held'
                           CHECK (status IN ('held','confirmed','completed','cancelled','expired','no_show')),
  reschedule_of            bigint REFERENCES bookings(id) ON DELETE CASCADE,  -- tentative hold for a reschedule

  setups                   int NOT NULL CHECK (setups BETWEEN 1 AND 6),       -- consoles
  controllers              int NOT NULL CHECK (controllers BETWEEN setups AND setups * 4),

  event_start              timestamptz,  -- birthday: gaming starts
  event_end                timestamptz,  -- birthday: gaming ends
  rental_start_date        date,         -- rental: delivery day
  rental_end_date          date,         -- rental: pickup day

  delivery_at              timestamptz NOT NULL,
  pickup_at                timestamptz NOT NULL,
  block_period             tstzrange NOT NULL,   -- what the units are blocked for, travel included

  address                  text,
  area                     text,
  service_area_id          int REFERENCES service_areas(id),

  price_total              int NOT NULL CHECK (price_total >= 0),
  advance_due              int NOT NULL CHECK (advance_due >= 0),
  decoration               boolean NOT NULL DEFAULT false,
  decoration_price         int,

  id_proof_received        boolean NOT NULL DEFAULT false,
  agreement_signed         boolean NOT NULL DEFAULT false,

  hold_expires_at          timestamptz,
  payment_claimed_at       timestamptz,
  hold_nudged_at           timestamptz,
  reminder_sent_at         timestamptz,
  pickup_reminder_sent_at  timestamptz,
  review_asked_at          timestamptz,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  idempotency_key          text UNIQUE,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CHECK (pickup_at > delivery_at),
  CHECK ((kind = 'birthday' AND event_start IS NOT NULL AND event_end IS NOT NULL)
      OR (kind = 'rental'   AND rental_start_date IS NOT NULL AND rental_end_date > rental_start_date))
);
CREATE INDEX bookings_lead_idx ON bookings (lead_id);
CREATE INDEX bookings_status_idx ON bookings (status);
CREATE INDEX bookings_block_idx ON bookings USING gist (block_period);
CREATE TRIGGER bookings_touch BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE booking_units (
  booking_id  bigint NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  unit_id     int    NOT NULL REFERENCES units(id),
  period      tstzrange NOT NULL,
  status      text NOT NULL,           -- mirrors bookings.status (trigger below)
  PRIMARY KEY (booking_id, unit_id),

  -- The database itself guarantees a unit is never double-booked, even
  -- under concurrent requests. Only live bookings (held or paid) block.
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    unit_id WITH =,
    period  WITH &&
  ) WHERE (status IN ('held','confirmed'))
);

-- Keep booking_units.status in step with bookings.status inside the same
-- statement, so a status change that would double-book (e.g. reinstating an
-- expired hold) fails with 23P01 instead of slipping through.
CREATE OR REPLACE FUNCTION sync_booking_unit_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE booking_units SET status = NEW.status WHERE booking_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bookings_sync_units AFTER UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_booking_unit_status();

CREATE TABLE payments (
  id           bigserial PRIMARY KEY,
  booking_id   bigint NOT NULL REFERENCES bookings(id),
  kind         text NOT NULL CHECK (kind IN ('advance','balance','damage','other')),
  amount       int NOT NULL CHECK (amount > 0),
  method       text CHECK (method IN ('upi','cash','bank')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  note         text
);
CREATE INDEX payments_booking_idx ON payments (booking_id);

-- ---------------------------------------------------------------------------
-- Handoffs to the owner
-- ---------------------------------------------------------------------------
CREATE TABLE handoffs (
  id           bigserial PRIMARY KEY,
  lead_id      bigint NOT NULL REFERENCES leads(id),
  booking_id   bigint REFERENCES bookings(id) ON DELETE SET NULL,
  reason       text NOT NULL CHECK (reason IN (
                 'sponsorship','human_requested','complaint','custom_quote',
                 'out_of_area','unknown_area','cancellation_paid','reschedule',
                 'payment_claim','damage','other')),
  priority     text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','urgent')),
  summary      text NOT NULL,
  details      jsonb,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX handoffs_open_idx ON handoffs (status) WHERE status = 'open';
