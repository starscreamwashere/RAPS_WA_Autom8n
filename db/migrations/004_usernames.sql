-- WhatsApp usernames: a customer who adopts a username can message us without
-- their phone number showing. Meta then identifies them by a business-scoped
-- user ID (BSUID, e.g. 'IN.13491208655302741918'). A lead has a phone, a
-- BSUID, or both; the API calls whichever one it has the "contact key".
ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE leads ADD COLUMN user_id text UNIQUE;   -- BSUID, as Meta sends it
ALTER TABLE leads ADD COLUMN username text;         -- WhatsApp username, if the customer has one
ALTER TABLE leads ADD CONSTRAINT leads_contact_present CHECK (phone IS NOT NULL OR user_id IS NOT NULL);
