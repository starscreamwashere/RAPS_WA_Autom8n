# RAPS Powerplay: business facts for the bot

Source: the owner's intake form (14 Oct 2026) plus 42 screenshots of real
customer chats (Feb–Jul 2026, all normal rentals). Customer names and numbers
are left out on purpose. Items marked **CONFIRM** came from chats, not from
the owner directly, so they need a yes from him before the bot uses them.

## Inventory
- 6 × PS5, 20 controllers in total (`controllers_total=20`).
- A birthday setup uses 4 controllers, so at most 5 birthday setups can run
  at the same time (20 / 4) before rentals take any.
- No Xbox, PS4 or VR. "Do you have Xbox?" → "No, we're PS5 only."

## Normal rental: what customers actually get
- PS5 + 1 or 2 controllers (the customer chooses; price depends on it), with
  HDMI, cables, stands, delivery and pickup.
- Games: **PS Plus Deluxe + EA Play memberships** ("100+ games"), logged in on
  the console. Popular: GTA V, FC 25 / FIFA, WWE 2K25, God of War, Cricket 24,
  The Last of Us, It Takes Two, A Way Out, F1, Spider-Man. **Forza is not
  included.** About 1 TB of games comes pre-installed; customers can delete and
  download others.
- Customers log in with the RAPS account and must always play from the given
  user (the owner sends "steps after login" on delivery; this stays manual).

## Normal rental pricing seen in chats (**CONFIRM**: a rate card is needed)
| Duration | Price quoted | Notes |
|---|---|---|
| 1 day, 1 controller | ₹950 | |
| 2 days | ₹1,620? | a payment of ₹1,620 appears after a 2-day order; unclear whether it was the full amount |
| 3 days | ₹1,999 | "3 days will be 1999/-" |
| 7 days, 1 controller | ₹2,749 | "1 week is my best selling" |
| 7 days with review offer | ₹2,499 | ₹250 off for an Instagram story + a Google review |
| Extension | ~₹250–375/day | +1 day quoted at ₹250; +4 days at ₹1,500 |
| 2nd controller | ? | price changes with controller count; amount not shown |

The brief's "₹3,000/week" does not match these chats.

## Normal rental: booking process today
1. Customer gives duration, number of controllers, date and area.
2. Owner quotes, then sends a **Google Form** for address + ID proof
   (Aadhaar). If the Aadhaar address is old: rental agreement / electricity
   bill, or a verification call with the landlord. The delivery person can
   also verify the documents at the door.
3. **10% token advance** to confirm the slot (UPI), **rest on delivery**. Cash
   on delivery is accepted. Payment is **not** accepted at pickup.
4. Owner shares the delivery person's contact. Same-day delivery happens.
5. On the end date: "Pick up / Extension reminder". Extension is allowed if
   no other order needs the unit; otherwise pickup is next morning (~9am).
- "Is the PS new or old?" and "Are games pre-installed?" come up.
- Privacy worries about Aadhaar: the owner points to rapspowerplay.com's
  privacy policy and explains it is for verifying the delivery address.
- Work proof: Instagram (Raps Powerplay page).

## Payments
- UPI QR "rapspowerplay", UPI ID `vindyreddy3011@oksbi` (account name Nuka
  Vinay Ganesh Reddy), linked to +91 90822 01911. **CONFIRM** that the bot may
  send this with every hold.

## Birthday events (from the form; no chat screenshots)
- ₹9,000 per setup: PS5 + 4 controllers, TV + stand, 3 hours, delivery,
  setup, teardown, on-site support. 50% advance, 50% after install.
- Qualifying order: in service area? → date → number of players → setups
  (ceil(players/4)) → price → decoration (paid extra, **price not given**).
- Team reaches ~3:30pm, done ~6pm, same-day pickup (an example, not a fixed
  slot). Setup 30–45 min.
- No ID proof needed, just the address.

## Not answered in the form
- Decoration price.
- Age restrictions (left blank).

## Tone seen in real chats
- Short, quick, warm. Mixes English and Hinglish ("agar me aapko mera 1 lac de
  raha hu toh thoda verify karna padega na!"). "Yessir", "sir", "bro" with
  young customers.
- Many rental leads are **teenagers asking their parents**; birthdays are
  parents. The bot stays professional and warm, and mirrors the customer's
  language and register.
- Sales habits: suggests pre-booking, mentions real demand ("Valentine's week,
  lots of orders"), follows up after silence ("What's the scene?"), offers the
  review discount when customers haggle. The bot may only state scarcity that
  the availability API confirms, never invented urgency.

## WhatsApp setup observations
- Chats show "Your business uses a secure service from Meta to manage this
  chat", an "Automated greeting", and Instagram-ad referrals with data sharing
  on. Something already manages this number (Meta Business Suite / an inbox
  tool / Meta AI). This must be checked before onboarding the Cloud API.
