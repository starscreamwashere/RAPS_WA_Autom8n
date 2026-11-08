-- Health of the link between the business number and the Cloud API. With
-- coexistence Meta can disconnect it (e.g. the business phone did not open
-- WhatsApp for ~14 days); then the bot can neither read nor send. Every
-- account_update webhook and health check is recorded; the current state is in
-- settings.whatsapp_link so the owner is alerted on changes, not repeats.
CREATE TABLE whatsapp_link_events (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('webhook', 'health_check')),
  event       text NOT NULL,              -- Meta's event name, or HEALTH_OK / HEALTH_ERROR
  reason      text,                       -- disconnection reason, restriction type, error
  state       text NOT NULL CHECK (state IN ('connected', 'disconnected', 'restricted', 'unchanged')),
  alerted     boolean NOT NULL DEFAULT false,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('whatsapp_link', '{"state": "connected", "since": null, "reason": null}')
ON CONFLICT (key) DO NOTHING;
