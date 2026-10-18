// Polled by the scheduled workflows (WF2 reminders, WF3 reviews). Each item
// says who to message and with what; n8n just sends it and calls /jobs/mark.
const { pool, withTx } = require('../db');
const clock = require('../clock');
const { HttpError } = require('../errors');
const { getSettings } = require('../settings');
const { istDate, addMinutes, fmtTime, fmtDate } = require('../time');
const { rupees, bookingWhen, bookingWhat, who } = require('../format');
const { sweepExpiredHolds } = require('./availability');

const MARKABLE = ['hold_nudged_at', 'reminder_sent_at', 'pickup_reminder_sent_at', 'review_asked_at'];

const firstName = (name) => (name ? name.split(/\s+/)[0] : 'there');

async function query(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Unpaid holds about to lapse: nudge the customer (inside their 24h window)
async function holdNudges(now, settings) {
  const rows = await query(
    `SELECT b.*, l.phone, l.name FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE b.status = 'held' AND b.reschedule_of IS NULL AND b.payment_claimed_at IS NULL
        AND b.hold_nudged_at IS NULL AND b.hold_expires_at > $1 AND b.hold_expires_at <= $2`,
    [now, addMinutes(now, settings.hold_nudge_before_min)]);
  return rows.map((b) => ({
    type: 'hold_nudge', booking_ref: b.ref, phone: b.phone, mark: 'hold_nudged_at',
    text: `Hi ${firstName(b.name)}! Your slot ${b.ref} (${bookingWhen(b)}) is held until ${fmtTime(b.hold_expires_at)}. `
      + `Please pay the advance of ${rupees(b.advance_due)} and share the screenshot to confirm it 🧡`,
  }));
}

// Day-before reminders for confirmed bookings (business-initiated: template)
async function startReminders(now, settings) {
  const rows = await query(
    `SELECT b.*, l.phone, l.name FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE b.status = 'confirmed' AND b.reminder_sent_at IS NULL
        AND b.delivery_at > $1 AND b.delivery_at <= $2`,
    [now, addMinutes(now, settings.reminder_hours_before * 60)]);
  return rows.map((b) => {
    const what = b.kind === 'birthday' ? `Birthday Gaming Station (${bookingWhat(b)})` : `PS5 rental (${bookingWhat(b)})`;
    const when = b.kind === 'birthday'
      ? `${fmtDate(b.event_start)}; our team arrives around ${fmtTime(b.delivery_at)}`
      : `delivery on ${fmtDate(b.rental_start_date)}`;
    return {
      type: 'booking_reminder', booking_ref: b.ref, phone: b.phone, mark: 'reminder_sent_at',
      template: 'booking_reminder', variables: [firstName(b.name), what, when, b.ref],
      text: `Hi ${firstName(b.name)}! Reminder: your ${what} is on ${when}. Booking ${b.ref}. Reply here if anything changes.`,
    };
  });
}

// Rental pickup day: "your session ends today, want to extend?"
async function pickupReminders(now) {
  const rows = await query(
    `SELECT b.*, l.phone, l.name FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE b.kind = 'rental' AND b.status = 'confirmed' AND b.pickup_reminder_sent_at IS NULL
        AND b.rental_end_date = $1::date`,
    [istDate(now)]);
  return rows.map((b) => ({
    type: 'pickup_reminder', booking_ref: b.ref, phone: b.phone, mark: 'pickup_reminder_sent_at',
    template: 'pickup_reminder', variables: [firstName(b.name), bookingWhat(b), b.ref],
    text: `Hi ${firstName(b.name)}! Your PS5 rental ${b.ref} (${bookingWhat(b)}) is scheduled for pickup today. `
      + 'Want to keep it longer? Reply EXTEND and we will check availability for you 🎮',
  }));
}

async function reviewAsks(now) {
  const rows = await query(
    `SELECT b.*, l.phone, l.name FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE b.status = 'completed' AND b.review_asked_at IS NULL
        AND b.completed_at <= $1 AND b.completed_at > $2`,
    [addMinutes(now, -60), addMinutes(now, -72 * 60)]);
  return rows.map((b) => ({
    type: 'review_request', booking_ref: b.ref, phone: b.phone, mark: 'review_asked_at',
    template: 'review_request', variables: [firstName(b.name)],
    text: `Hi ${firstName(b.name)}! Thank you for playing with RAPS Powerplay 🎮 We'd love a quick Google review. It really helps us. Everyone deserves to play! 🧡`,
  }));
}

async function remindersDue() {
  const now = clock.now();
  const settings = await getSettings();
  return [...await holdNudges(now, settings), ...await startReminders(now, settings), ...await pickupReminders(now)];
}

const reviewsDue = () => reviewAsks(clock.now());

// Releases lapsed holds. Lapsed reschedule holds are reported to the owner;
// ordinary unpaid holds just show up in the nightly digest.
async function sweep() {
  return withTx(async (client) => {
    const expired = await sweepExpiredHolds(client);
    const notifications = [];
    for (const e of expired.filter((x) => x.reschedule_of)) {
      const { rows } = await client.query(
        `SELECT b.ref, l.name, l.phone FROM bookings b JOIN leads l ON l.id = b.lead_id WHERE b.id = $1`, [e.reschedule_of]);
      if (rows[0]) {
        notifications.push({ to: 'owner',
          text: `⌛ The held reschedule slot for ${rows[0].ref} (${who(rows[0])}) lapsed without MOVE/DECLINE and was released.` });
      }
    }
    return { expired: expired.length, notifications };
  });
}

async function mark(ref, field) {
  if (!MARKABLE.includes(field)) throw new HttpError(400, 'VALIDATION', `field must be one of ${MARKABLE.join(', ')}`);
  const { rowCount } = await pool.query(`UPDATE bookings SET ${field} = $2 WHERE upper(ref) = upper($1)`, [ref, clock.now()]);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', `Booking ${ref} not found`);
  return { ok: true };
}

module.exports = { remindersDue, reviewsDue, sweep, mark, MARKABLE };
