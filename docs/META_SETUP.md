# Meta / WhatsApp setup runbook

How to connect the RAPS business number **9082201911** to the WhatsApp Cloud API
so the bot can answer, **while the owner keeps using the WhatsApp Business app on
the same number** (Meta calls this *onboarding WhatsApp Business app users*, or
*coexistence*). Written against Meta's developer docs as of November 2026; Meta
changes these screens often, so where a button has moved, search the App Dashboard
for the name used here.

Who does what: **Owner** = Vindy (owns the number, the Facebook account and the
business documents). **Dev** = whoever runs the server.

---

## The route, and why

Coexistence onboarding is only possible through Meta's **Embedded Signup** flow,
and Meta only lets a **Tech Provider** or a **Solution Partner** run Embedded
Signup. Three ways to get there:

| Route | Cost | Effort | Notes |
|---|---|---|---|
| **A. RAPS becomes its own Tech Provider** (recommended) | Meta's per-message charges only | Business verification + App Review (two screen recordings), then a 15-minute onboarding | Everything stays in RAPS's own Meta account; the workflows work as built |
| B. Go through a Solution Partner that supports coexistence (e.g. 360dialog) | Monthly partner fee + Meta charges | Fastest | The partner's API usually differs from Meta's (other URL and auth header), so WF1/WF2 need small changes; ask whether they give a webhook to our server |
| C. Move the number to the Cloud API without coexistence | Meta charges only | Simple | The owner **loses the WhatsApp Business app** on this number. Rejected in the design (Q-5) |

This runbook follows **route A**. If business verification or App Review stalls,
switch to B and the rest of this document (webhook, templates, tokens) still mostly
applies.

---

## Phase 0: checks before anything else (owner, 15 min)

1. **Who manages the number today?** The chats show "Your business uses a secure
   service from Meta to manage this chat". On the business phone open WhatsApp
   Business → **Settings → Account → Business Platform**. If it shows the number is
   connected to a provider, note the provider's name: it must be disconnected first,
   or onboarding fails with a credit-line error. If it is only Meta's own features
   (Meta AI / Business Suite inbox), that is fine.
2. **WhatsApp Business app version 2.24.17 or newer** (update from the app store).
3. **Which devices does the owner reply from?** Coexistence supports the phone and
   linked devices **except WhatsApp for Windows and WearOS**. Messages typed there
   do not reach the bot, so the bot would not pause and could talk over him. Use the
   phone, WhatsApp Web in a browser, or the Mac app. All linked devices are logged out
   once during onboarding and can be re-linked after.
4. **The phone must stay in use.** If the business phone does not open WhatsApp for
   about **14 days**, Meta disconnects the API (`PRIMARY_INACTIVITY`).
5. **Facebook account**: the owner's personal Facebook account, with 2-factor
   authentication on. It becomes the admin of everything below.
6. Know what changes in the app after onboarding: disappearing messages, view-once
   and live location are turned off in 1:1 chats; **broadcast lists become read-only**;
   groups, calls, catalog, labels, quick replies and the away/greeting messages keep
   working in the app. (If the owner relies on the app's away/greeting message, turn
   it off: the bot answers instead.)

## Phase 1: business portfolio and verification (owner, 30 min + Meta's review, days)

1. Go to <https://business.facebook.com> and create (or open) the business portfolio
   **RAPS Powerplay**. If the WhatsApp Business app number is already linked to a
   portfolio, use that one.
2. **Business verification**: Business settings → Security centre → *Start
   verification*. Use the legal business name exactly as on the documents, the
   business address and phone, and the website **rapspowerplay.com**. Accepted
   documents in India include the GST certificate, Udyam/MSME certificate, shop and
   establishment licence, or a utility bill / bank statement in the business name.
   Meta may ask to verify the domain (a DNS TXT record or a file on the website).
3. Add a **payment method** for WhatsApp: WhatsApp Manager → Payment methods (a card).
   Without it only the 1,000 free service messages a month are delivered.

## Phase 2: the Meta app (dev with the owner logged in, 20 min)

1. <https://developers.facebook.com/apps> → **Create app** → use case *Connect with
   customers through WhatsApp* → link the **RAPS Powerplay** portfolio.
2. App settings → Basic: app icon, **privacy policy URL**
   (`https://rapspowerplay.com/privacy` or wherever it lives), category *Business and
   pages*. Copy the **App ID** → `META_APP_ID` and **App secret** → `WA_APP_SECRET`.
3. Add the dev as a **Developer** on the app (App roles) so both can work on it.

## Phase 3: become a Tech Provider (dev, 1 hour + Meta's review, days)

App Dashboard → **Use cases** → WhatsApp → *Customize* → **Tech Provider onboarding**
→ *Onboard without a partner*.

1. Business verification shows as done once phase 1 is approved.
2. **App Review** for advanced access to `whatsapp_business_messaging` and
   `whatsapp_business_management`. Meta wants two screen recordings:
   - sending a message and seeing it arrive on WhatsApp: use **WhatsApp → API Setup**,
     add your own phone as a test recipient, and record the cURL send;
   - creating a message template: record creating `owner_alert` (phase 7) in
     WhatsApp Manager.

   Describe the use: "Our own business (RAPS Powerplay, PS5 rentals in Mumbai) uses
   this app to answer customer enquiries on our WhatsApp number with an automated
   assistant, and to send booking updates. We only onboard our own number."

> Meta's docs list Tech Provider status as a requirement for coexistence. While the
> app is still in development mode, app admins can already see the Embedded Signup
> permissions, so it is worth trying phase 5 before App Review finishes. If the
> "connect your existing WhatsApp Business app" option does not appear or the
> onboarding fails, wait for App Review.

## Phase 4: server and webhook live first (dev, 30 min)

The bot must be running **before** onboarding, because the contact and history sync
has to be started within 24 hours of it, and customer messages start arriving at once.

1. Host the stack (`docker compose up -d`; hosting decision in `docs/STATUS.md`) with a
   public HTTPS URL: `https://<NGROK_DOMAIN>` or your domain.
2. `.env`: `WA_VERIFY_TOKEN` (any long random string), `WA_APP_SECRET` (phase 2),
   `OWNER_PHONE`, `BUSINESS_PHONE=919082201911`, `LLM_MODELS`, Gemini key in n8n
   (`docs/E2E.md` step 2 shows the import; in production use the n8n UI → Credentials).
   **`ALERT_PUSH_URL`** (owner, 5 min): if Meta disconnects the number, the bot can no
   longer send WhatsApp messages, so that alert also goes out as a phone push. Install
   the **ntfy** app (Android/iPhone), tap *Subscribe to topic*, enter a long random
   name such as `raps-7f3k9q2m1x` (anyone who knows it can read the alerts), and set
   `ALERT_PUSH_URL=https://ntfy.sh/raps-7f3k9q2m1x`. Test it:
   `curl -d "test from RAPS" https://ntfy.sh/raps-7f3k9q2m1x`.
3. Import and **publish** the three workflows in n8n.
4. App Dashboard → WhatsApp → **Configuration** → Webhook:
   - Callback URL: `https://<NGROK_DOMAIN>/webhook/whatsapp`
   - Verify token: the same `WA_VERIFY_TOKEN`
   - Click *Verify and save* (WF1 answers Meta's check).
5. Subscribe these webhook fields:
   `messages`, `smb_message_echoes` (owner typing in the app → bot pauses),
   `account_update` (disconnections, bans, restrictions → owner alert), `history`,
   `smb_app_state_sync`. WF1 uses the first three; the last two are accepted and
   ignored for now.

## Phase 5: onboard the number with Embedded Signup (dev + owner together, 15 min)

Prepare (dev):

1. App Dashboard → **Facebook Login for Business** → Settings → Client OAuth settings:
   turn on *Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth
   Login, Use Strict Mode for redirect URIs, Login with the JavaScript SDK*.
2. Facebook Login for Business → **Configurations** → *Create from template* →
   **WhatsApp Embedded Signup Configuration**. Copy its ID → `META_CONFIG_ID`.
3. Start the onboarding page and an HTTPS tunnel to it (a separate URL from the webhook):

   ```bash
   META_APP_ID=... META_APP_SECRET=... META_CONFIG_ID=... node scripts/meta-onboard.mjs
   cloudflared tunnel --url http://localhost:8090     # prints https://<random>.trycloudflare.com
   ```

   Add that `trycloudflare.com` host to **Allowed domains** (Client OAuth settings and
   the JavaScript SDK domains) before opening the page.

Do it (owner, with the business phone in hand and WhatsApp Business open):

4. Open the tunnel URL, click **Connect with Facebook**, log in.
5. Choose **connect your existing WhatsApp Business app**, enter `9082201911`.
6. On the phone: a message from Facebook Business arrives → **Connect** →
   **Connect to the Business Platform** → **Confirm** (allow sharing chat history) →
   enter the code shown on screen.
7. Finish the flow and click **Finish** (closing the window loses the token code).

The script then, within seconds: exchanges the code for a token, subscribes the app
to the account's webhooks, checks `is_on_biz_app=true` and `platform_type=CLOUD_API`,
and starts the contacts and history sync (each can be done **only once**). It prints
`WA_PHONE_NUMBER_ID` and `WA_BUSINESS_ACCOUNT_ID` for `.env` and saves everything to
`meta-onboarding.json` (git-ignored; delete it once phase 6 is done).

Do **not** call the phone number *register* endpoint: a coexistence number is already
registered. Keep the WhatsApp Business app open until the app says the sync is complete.

## Phase 6: the permanent access token (owner, 10 min)

The workflows send with `WA_ACCESS_TOKEN`. Use a **System User** token that never
expires (the token from Embedded Signup is only for the onboarding):

1. Business settings → **Users → System users** → *Add* → name `raps-bot`, role **Admin**.
2. *Assign assets*: the app (**Manage app**), the **WhatsApp account** and the
   **Messaging account** (full control). Assign both accounts explicitly; Business
   Suite does not do it for you.
3. *Generate token* → the app → expiry **Never** → permissions `business_management`,
   `whatsapp_business_management`, `whatsapp_business_messaging`.
4. Put it in `.env` as `WA_ACCESS_TOKEN` (no spaces), restart n8n.

Check it:

```bash
curl "https://graph.facebook.com/v27.0/$WA_PHONE_NUMBER_ID?fields=verified_name,is_on_biz_app,platform_type,quality_rating" \
  -H "Authorization: Bearer $WA_ACCESS_TOKEN"
```

## Phase 7: message templates (dev, 10 min + approval, minutes to a day)

The bot replies with free text while the customer's 24-hour window is open. Messages
the system starts later (reminders, review asks, booking updates, owner alerts when
the owner has not messaged the bot in 24 hours) go out as one of two templates, with
the message flattened into the single variable (`api/src/services/outbox.js`).

| Name | Category | Language | Body |
|---|---|---|---|
| `owner_alert` | Utility | English (`en`) | `RAPS Powerplay team update: {{1}}. Reply HELP for the command list.` |
| `customer_update` | Utility | English (`en`) | `Hello from RAPS Powerplay! An update about your PS5 booking: {{1}}. Reply here if you have any questions.` |

Example values (Meta requires one per variable):
`owner_alert` → `📌 #12 complaint · Rohan (9876543210) · Controller not working`;
`customer_update` → `Reminder: booking RP-1042 is delivered tomorrow, 10 Nov, between 10am and 1pm`.

Create them in WhatsApp Manager → Message templates, or by API:

```bash
curl -X POST "https://graph.facebook.com/v27.0/$WA_BUSINESS_ACCOUNT_ID/message_templates" \
  -H "Authorization: Bearer $WA_ACCESS_TOKEN" -H "Content-Type: application/json" -d '{
  "name": "customer_update", "language": "en", "category": "utility",
  "components": [{ "type": "body",
    "text": "Hello from RAPS Powerplay! An update about your PS5 booking: {{1}}. Reply here if you have any questions.",
    "example": { "body_text": [["Reminder: booking RP-1042 is delivered tomorrow, 10 Nov, between 10am and 1pm"]] } }]
}'
```

`WA_TEMPLATE_LANG=en` must match the language the templates were approved in.

Risks to watch:
- Meta can **re-categorise a utility template as marketing** (higher price) if it
  looks promotional. The review ask ("We'd love a quick Google review") is the
  likeliest trigger. If `customer_update` is rejected or re-categorised, split it
  into specific templates (`booking_reminder`, `booking_update`, `review_request`);
  that is a small change in `outbox.js`.
- A template that is almost entirely one variable can be rejected as too generic.
  If so, add fixed wording around the variable and resubmit.

## Phase 8: go-live checks (owner + dev, 20 min)

From a third phone (not the business or owner number):

1. "Hi, PS5 for a week with 1 controller, how much?" → the bot answers with ₹2,750
   within a few seconds; the message and the reply show in the WhatsApp Business app.
2. Owner replies to that customer **from the WhatsApp Business app** → the owner's
   personal number gets "🤫 Bot paused for …"; the next customer message gets no bot reply.
3. Owner sends `RESUME <that number>` from his personal number → the bot answers again.
4. Owner sends `HELP` and `TODAY` → command replies.
5. In n8n → Executions, every run is green; in the API, `GET /outbox/pending` empties.
6. `GET /whatsapp/link` says `connected`, and within 3 hours WF3's health check has
   recorded a `HEALTH_OK` there.

Then tell regular customers nothing changes: same number, same app replies from Vindy.

---

## Costs (Meta, India)

Meta charges per delivered message (rates in INR on
<https://business.whatsapp.com/products/platform-pricing>; effective 1 Oct 2026):

- **Bot replies** (non-template, inside the 24h window) are *service* messages: the
  first **1,000 per month per number are free**, then charged at the service rate.
- **Templates** (`customer_update`, `owner_alert`) are charged at the utility rate,
  except when sent while the customer's window is open.
- Anything the owner types **in the WhatsApp Business app stays free**.
- A conversation that starts from a click-to-WhatsApp ad opens a free window
  where nothing is charged.

## Known gaps to close before or soon after go-live

1. **Usernames (business-scoped user IDs): handled.** A customer who adopts a
   WhatsApp username may arrive without a phone number, identified by a `user_id`
   such as `IN.1349…`. Leads store the phone, the user ID and the username; the bot
   answers by user ID (`recipient`) when there is no phone, and the two are merged
   when the phone appears later. The owner sees such customers as `@username` and
   can type `RESUME @username`. Tested in `api/test/usernames.test.js` and
   `scripts/e2e-wf1.mjs`.
2. **Chat history.** The history sync arrives as `history` webhooks, which WF1
   currently ignores. Importing it would give the bot memory of past chats; optional.
3. **Disconnection alert: handled.** Meta's `account_update` webhooks (disconnected,
   banned, restricted) and a health check every 3 hours (WF3 asks Meta whether the
   number is still on the Cloud API; also catches an expired token) alert the owner
   once per change, in plain words with the fix, by WhatsApp and by push
   (`ALERT_PUSH_URL`). The nightly digest leads with the problem until it is fixed,
   and recovery is announced. Status: `GET /whatsapp/link`.

## Offboarding (if ever needed)

In WhatsApp Business: **Settings → Account → Business Platform → Disconnect account**.
The app keeps working as before; the bot stops receiving messages.

## Sources (Meta developer docs)

- Onboard WhatsApp Business app users: `developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users`
- Become a Tech Provider: `…/whatsapp/solution-providers/get-started-for-tech-providers`
- Embedded Signup implementation / version 5: `…/whatsapp/embedded-signup/implementation`, `…/version-5`
- Access tokens (System User): `…/whatsapp/access-tokens`
- Business-scoped user IDs: `…/whatsapp/business-scoped-user-ids`
- Pricing: `…/whatsapp/pricing`; template categories: `…/whatsapp/templates/template-categorization`
