const express = require('express');
const v = require('./validate');
const { pool } = require('./db');
const { notFound } = require('./errors');
const { loadCatalog, quote } = require('./services/pricing');
const { checkArea } = require('./services/serviceAreas');
const leads = require('./services/leads');
const { logMessage } = require('./services/messages');
const bookings = require('./services/bookings');
const handoffs = require('./services/handoffs');
const jobs = require('./services/jobs');
const { digest } = require('./services/digest');
const { runOwnerCommand } = require('./services/ownerCommands');
const outbox = require('./services/outbox');
const config = require('./config');
const clock = require('./clock');
const { normalizePhone } = require('./phone');
const { istDate } = require('./time');

const router = express.Router();

// Results that carry `notifications` have them queued in the outbox, which
// is the only path that sends them; they stay in the response for visibility.
async function queued(result) {
  await outbox.enqueue(result.notifications);
  return result;
}

// ---- Leads and messages ---------------------------------------------------
router.post('/messages', async (req, res) => {
  res.json(await logMessage(v.messageIn.parse(req.body)));
});

router.get('/leads/:phone', async (req, res) => {
  res.json(await leads.leadProfile(req.params.phone));
});

router.patch('/leads/:phone', async (req, res) => {
  res.json(await leads.updateProfile(req.params.phone, v.leadPatch.parse(v.clean(req.body))));
});

router.post('/leads/:phone/pause', async (req, res) => {
  res.json(await queued(await leads.pauseBot(req.params.phone)));
});

router.post('/leads/:phone/resume', async (req, res) => {
  const r = await leads.resumeBot(req.params.phone);
  res.json({ paused: r.paused });
});

// ---- Catalogue -------------------------------------------------------------
router.get('/rates', async (req, res) => {
  const { settings, rates, rentalRates } = await loadCatalog();
  res.json({
    birthday: {
      ...rates.birthday_station,
      bookings_open: settings.birthday_bookings_enabled,
      hours: settings.birthday_default_hours,
      advance_pct: settings.advance_pct_birthday,
      balance_when: 'after the setup is installed',
      id_proof_needed: false,
      decoration: { available: true, amount: rates.decoration?.amount ?? null, note: rates.decoration?.amount == null ? 'price on request' : null },
    },
    rental: {
      rate_card: rentalRates.map(({ package: p, days, controllers, amount }) => ({ package: p, days, controllers, amount })),
      other_durations: 'quoted by the owner',
      includes: ['PS5', '1–4 controllers (customer chooses)', 'HDMI + cables + stands',
        'PS Plus Deluxe + EA Play memberships (100+ games, ~1TB pre-installed)', 'Delivery and pickup'],
      advance_pct: settings.advance_pct_rental,
      balance_when: 'on delivery (cash or UPI); not at pickup',
      id_proof_needed: 'Aadhaar + delivery address via a short Google Form; delivery person verifies',
      id_form_url: settings.rental_id_form_url,
    },
    delivery: 'included',
    security_deposit: 'none',
    peak_pricing: 'none',
    business_hours: `${settings.business_open}–${settings.business_close}, every day`,
    payment: { upi_id: settings.payment_upi_id, name: settings.payment_upi_name },
    policies: [
      'Advance is not refunded on cancellation.',
      'Damage: the customer pays the assessed cost, which we communicate.',
      'No water on the equipment, no smoking around it, no sub-renting, do not take the console out of the delivery address.',
    ],
  });
});

router.get('/service-areas/check', async (req, res) => {
  res.json(await checkArea(String(req.query.q || '')));
});

router.post('/quotes', async (req, res) => {
  res.json(quote(v.quoteRequest.parse(v.clean(req.body)), await loadCatalog()));
});

// ---- Availability and bookings ---------------------------------------------
router.get('/availability', async (req, res) => {
  res.json(await bookings.checkAvailability(v.bookingRequest.parse(v.clean({ ...req.query }))));
});

router.post('/bookings', async (req, res) => {
  const body = v.createBooking.parse(v.clean({ ...req.body, idempotency_key: req.get('Idempotency-Key') ?? req.body.idempotency_key }));
  const r = await bookings.createBooking(body);
  res.status(r.created ? 201 : 200).json(r);
});

router.get('/bookings', async (req, res) => {
  const phone = v.phone.parse(req.query.phone);
  res.json(await bookings.findBookings(phone, req.query.status || undefined));
});

router.get('/bookings/:ref', async (req, res) => {
  res.json(await bookings.getBooking(req.params.ref, req.query.phone));
});

router.post('/bookings/:ref/cancel', async (req, res) => {
  const { phone } = v.z.object({ phone: v.phone }).parse(req.body);
  res.json(await queued(await bookings.cancelBooking(req.params.ref, { phone, by: 'customer' })));
});

router.post('/bookings/:ref/payment-claim', async (req, res) => {
  res.json(await queued(await bookings.claimPayment(req.params.ref, v.paymentClaim.parse(v.clean(req.body)))));
});

router.post('/bookings/:ref/reschedule-request', async (req, res) => {
  res.json(await queued(await bookings.requestReschedule(req.params.ref, v.reschedule.parse(v.clean(req.body)))));
});

router.post('/bookings/:ref/move', async (req, res) => {
  const change = v.z.object({ date: v.date.optional(), start_date: v.date.optional(), start_time: v.z.string().optional() }).parse(req.body);
  res.json(await queued(await bookings.moveBooking(req.params.ref, change)));
});

router.post('/bookings/:ref/decline-reschedule', async (req, res) => {
  res.json(await queued(await bookings.declineReschedule(req.params.ref)));
});

router.post('/bookings/:ref/payments', async (req, res) => {
  res.status(201).json(await queued(await bookings.recordPayment(req.params.ref, v.payment.parse(req.body))));
});

router.patch('/bookings/:ref', async (req, res) => {
  res.json(await bookings.updateBooking(req.params.ref, v.bookingPatch.parse(req.body)));
});

router.get('/schedule', async (req, res) => {
  res.json(await bookings.schedule(req.query.date ? v.date.parse(req.query.date) : istDate(clock.now())));
});

// ---- Handoffs ----------------------------------------------------------------
router.post('/handoffs', async (req, res) => {
  res.status(201).json(await queued(await handoffs.flagForHuman(v.handoff.parse(v.clean(req.body)))));
});

router.get('/handoffs', async (req, res) => {
  res.json(await handoffs.listHandoffs(req.query.status === 'resolved' ? 'resolved' : 'open'));
});

router.post('/handoffs/:id/resolve', async (req, res) => {
  res.json(await handoffs.resolveHandoff(Number(req.params.id)));
});

// ---- Owner commands ----------------------------------------------------------
// WF1 calls this only for messages from OWNER_PHONE; the check is repeated
// here so a misrouted customer message can never run a command.
router.post('/owner/command', async (req, res) => {
  const { phone, text } = v.z.object({ phone: v.phone, text: v.z.string().max(1000) }).parse(req.body);
  if (!config.ownerPhone || normalizePhone(phone) !== config.ownerPhone) throw notFound('Owner');
  await outbox.noteOwnerInbound();
  res.json(await queued(await runOwnerCommand(text)));
});

// ---- Jobs and reports ----------------------------------------------------------
router.get('/jobs/reminders-due', async (req, res) => res.json(await jobs.remindersDue()));
router.get('/jobs/reviews-due', async (req, res) => res.json(await jobs.reviewsDue()));
router.post('/jobs/sweep', async (req, res) => res.json(await queued(await jobs.sweep())));
router.post('/jobs/mark', async (req, res) => {
  const { booking_ref, field } = v.z.object({ booking_ref: v.z.string(), field: v.z.string() }).parse(req.body);
  res.json(await jobs.mark(booking_ref, field));
});

router.get('/reports/digest', async (req, res) => {
  res.json(await digest(req.query.date ? v.date.parse(req.query.date) : undefined));
});

// ---- Outbox (sent by the n8n outbox loop) ---------------------------------------
router.get('/outbox/pending', async (req, res) => res.json(await outbox.pending()));
router.post('/outbox/:id/sent', async (req, res) => res.json(await outbox.markSent(Number(req.params.id))));
router.post('/outbox/:id/failed', async (req, res) => {
  const { error } = v.z.object({ error: v.z.string().optional() }).parse(req.body ?? {});
  res.json(await outbox.markFailed(Number(req.params.id), error));
});

router.get('/units', async (req, res) => {
  const { rows } = await pool.query('SELECT code, status, notes FROM units ORDER BY code');
  res.json(rows);
});

module.exports = router;
