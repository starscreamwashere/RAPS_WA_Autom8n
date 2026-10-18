const { z } = require('zod');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24h)');
const phone = z.string().min(10).max(15);
const int = (min, max) => z.coerce.number().int().min(min).max(max);

const messageIn = z.object({
  phone,
  direction: z.enum(['in', 'out']),
  wa_message_id: z.string().optional(),
  kind: z.string().max(30).optional(),
  template_name: z.string().optional(),
  body: z.string().max(10000).optional(),
  name: z.string().max(200).optional(),
  referral: z.record(z.any()).optional(),
  raw: z.any().optional(),
});

const leadPatch = z.object({
  name: z.string().max(200),
  language: z.string().max(20),
  intent: z.enum(['birthday', 'rental', 'general', 'sponsorship', 'unknown']),
  stage: z.enum(['new', 'qualifying', 'quoted', 'booking_held', 'booked', 'completed', 'lost', 'handed_off']),
  occasion: z.string().max(50),
  event_date: date,
  preferred_start: time,
  venue_type: z.string().max(50),
  num_kids: int(1, 500),
  num_guests: int(1, 1000),
  child_age: int(0, 100),
  setups_needed: int(1, 20),
  decoration_wanted: z.boolean(),
  rental_start_date: date,
  rental_days: int(1, 365),
  controllers_wanted: int(1, 4),
  area: z.string().max(200),
  games_interest: z.array(z.string().max(100)).max(20),
  notes: z.string().max(2000),
}).partial().strict();

const bookingRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('birthday'),
    date, start_time: time,
    setups: int(1, 20).optional(),
    players: int(1, 500).optional(),
    hours: int(1, 8).optional(),
    decoration: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('rental'),
    start_date: date,
    days: int(1, 365).optional(),
    end_date: date.optional(),
    setups: int(1, 6).optional(),
    controllers: int(1, 24).optional(),
  }),
]);

const quoteRequest = z.object({
  kind: z.enum(['birthday', 'rental']),
  setups: int(1, 20).optional(),
  players: int(1, 500).optional(),
  decoration: z.boolean().optional(),
  days: int(1, 365).optional(),
  start_date: date.optional(),
  end_date: date.optional(),
  controllers: int(1, 24).optional(),
});

const createBooking = z.intersection(bookingRequest, z.object({
  phone,
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  area: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  idempotency_key: z.string().max(200).optional(),
}));

const reschedule = z.object({
  phone,
  date: date.optional(),
  start_time: time.optional(),
  start_date: date.optional(),
}).refine((v) => v.date || v.start_date, 'give date (birthday) or start_date (rental)');

const handoff = z.object({
  phone,
  reason: z.enum(['sponsorship', 'human_requested', 'complaint', 'custom_quote', 'out_of_area', 'unknown_area',
    'cancellation_paid', 'reschedule', 'payment_claim', 'damage', 'other']),
  priority: z.enum(['low', 'normal', 'urgent']).optional(),
  summary: z.string().min(3).max(2000),
  details: z.record(z.any()).optional(),
  booking_ref: z.string().optional(),
  pause_bot: z.boolean().optional(),
});

const payment = z.object({
  amount: int(1, 10000000),
  method: z.enum(['upi', 'cash', 'bank']).optional(),
  kind: z.enum(['advance', 'balance', 'damage', 'other']).optional(),
});

const bookingPatch = z.object({
  status: z.enum(['completed', 'no_show']),
  address: z.string().max(500),
  notes: z.string().max(2000),
  id_proof_received: z.boolean(),
  agreement_signed: z.boolean(),
}).partial().strict();

const paymentClaim = z.object({ phone, amount: int(1, 10000000).optional(), note: z.string().max(500).optional() });

module.exports = {
  z, date, messageIn, leadPatch, bookingRequest, quoteRequest, createBooking, reschedule, handoff, payment,
  bookingPatch, paymentClaim, phone,
};
