-- Outgoing WhatsApp messages the API wants sent (owner alerts, customer
-- updates). The API queues them; an n8n loop sends each one once. This keeps
-- alerts from being lost when they come out of an AI tool call, whose result
-- goes to the model and not to the workflow.
CREATE TABLE outbox (
  id          bigserial PRIMARY KEY,
  recipient   text NOT NULL CHECK (recipient IN ('owner','customer')),
  phone       text NOT NULL,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    int  NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE status = 'pending';

INSERT INTO settings (key, value) VALUES
  -- Google Form the owner already uses for rental address + Aadhaar
  ('rental_id_form_url', '"https://docs.google.com/forms/d/e/1FAIpQLSeYNynNZMBN3aH3DEK0XbCsgz3aEGtgLFx5QK2bxRj7VyottA/viewform"'),
  -- Last time the owner messaged the business number; free-form messages to
  -- him only work within 24h of it, otherwise the owner_alert template is used
  ('owner_last_inbound_at', 'null');
