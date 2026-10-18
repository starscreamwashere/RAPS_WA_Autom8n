const { pool, withTx, lockBookings, EXCLUSION_VIOLATION } = require('../db');
const clock = require('../clock');
const { HttpError, notFound } = require('../errors');
const { getSettings } = require('../settings');
const { normalizePhone } = require('../phone');
const { istDate, istDateTime, addDays, addMinutes, fmtTime, fmtDate, hhmm, daysBetween } = require('../time');
const { rupees, bookingWhen, bookingWhat, who, plural } = require('../format');
const { loadCatalog, quote } = require('./pricing');
const { computeWindow, sweepExpiredHolds, capacity, fits, alternatives } = require('./availability');
const { upsertLead, getLeadByPhone } = require('./leads');
const { createHandoff, resolveHandoffs } = require('./handoffs');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// Turns a request into window parameters plus the setups/controllers it needs
function normalizeRequest(input, settings) {
  if (input.kind === 'birthday') {
    const setups = input.setups ?? (input.players ? Math.ceil(input.players / settings.controllers_per_setup_max) : null);
    if (!setups) throw new HttpError(400, 'VALIDATION', 'Give setups or players');
    return {
      kind: 'birthday',
      params: { date: input.date, start_time: input.start_time, hours: input.hours },
      setups,
      controllers: setups * settings.controllers_per_setup_max,
    };
  }
  if (input.kind === 'rental') {
    const days = input.days ?? (input.end_date && input.start_date ? daysBetween(input.start_date, input.end_date) : null);
    const setups = input.setups ?? 1;
    return {
      kind: 'rental',
      params: { start_date: input.start_date, days },
      setups,
      controllers: input.controllers ?? setups,
    };
  }
  throw new HttpError(400, 'VALIDATION', 'kind must be birthday or rental');
}

// Rebuilds window parameters from an existing booking, optionally moved
function paramsFromBooking(b, change = {}) {
  if (b.kind === 'birthday') {
    const hours = Math.round((new Date(b.event_end) - new Date(b.event_start)) / 3600000);
    return {
      date: change.date ?? istDate(new Date(b.event_start)),
      start_time: change.start_time ?? hhmm(new Date(b.event_start)),
      hours,
    };
  }
  return {
    start_date: change.start_date ?? b.rental_start_date,
    days: daysBetween(b.rental_start_date, b.rental_end_date),
  };
}

const dateStr = (d) => (d instanceof Date ? istDate(d) : d);

function normalizeBookingRow(b) {
  return { ...b, rental_start_date: dateStr(b.rental_start_date), rental_end_date: dateStr(b.rental_end_date) };
}

async function loadBooking(client, ref, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `SELECT b.*, l.phone, l.name FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE upper(b.ref) = upper($1) ${forUpdate ? 'FOR UPDATE OF b' : ''}`, [ref]);
  return rows[0] ? normalizeBookingRow(rows[0]) : null;
}

async function bookingOrThrow(client, ref, opts) {
  const b = await loadBooking(client, ref, opts);
  if (!b) throw notFound(`Booking ${ref}`);
  return b;
}

// Customer-side calls may only touch the caller's own bookings
function assertOwner(b, phone) {
  if (phone && normalizePhone(phone) !== b.phone) throw notFound(`Booking ${b.ref}`);
}

async function paidSoFar(client, bookingId) {
  const { rows } = await client.query('SELECT coalesce(sum(amount), 0)::int AS n FROM payments WHERE booking_id = $1', [bookingId]);
  return rows[0].n;
}

function holdText(b, settings) {
  const upi = settings.payment_upi_id ? ` to UPI ${settings.payment_upi_id}` : '';
  const pctLabel = b.kind === 'birthday' ? settings.advance_pct_birthday : settings.advance_pct_rental;
  const balanceWhen = b.kind === 'birthday' ? 'after the setup is installed' : 'on delivery';
  const lines = [
    `Your booking ${b.ref} (${bookingWhen(b)}, ${bookingWhat(b)}) is held until ${fmtTime(new Date(b.hold_expires_at))}.`,
    `Total ${rupees(b.price_total)}. To confirm, please pay the ${pctLabel}% advance of ${rupees(b.advance_due)}${upi} and share the payment screenshot here.`,
    `The balance ${rupees(b.price_total - b.advance_due)} is paid ${balanceWhen}.`,
  ];
  if (b.kind === 'rental') lines.push('We will also share a short form for your delivery address and Aadhaar for verification.');
  return lines.join(' ');
}

function publicBooking(b) {
  const keep = ['ref', 'kind', 'status', 'setups', 'controllers', 'event_start', 'event_end', 'rental_start_date',
    'rental_end_date', 'delivery_at', 'pickup_at', 'address', 'area', 'price_total', 'advance_due', 'decoration',
    'hold_expires_at', 'payment_claimed_at', 'id_proof_received', 'agreement_signed', 'reschedule_of', 'created_at'];
  const out = Object.fromEntries(keep.filter((k) => k in b).map((k) => [k, b[k]]));
  out.when = bookingWhen(b);
  out.what = bookingWhat(b);
  return out;
}

async function insertBooking(client, { leadId, kind, win, setups, controllers, priceTotal, advanceDue, extra = {} }, units, settings) {
  const now = clock.now();
  const { rows } = await client.query(
    `INSERT INTO bookings (lead_id, kind, status, setups, controllers, event_start, event_end,
        rental_start_date, rental_end_date, delivery_at, pickup_at, block_period,
        address, area, service_area_id, price_total, advance_due, decoration, hold_expires_at,
        idempotency_key, notes, reschedule_of, created_at)
     VALUES ($1, $2, 'held', $3, $4, $5, $6, $7, $8, $9, $10, tstzrange($11, $12),
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING *`,
    [leadId, kind, setups, controllers, win.event_start ?? null, win.event_end ?? null,
      win.rental_start_date ?? null, win.rental_end_date ?? null, win.delivery_at, win.pickup_at,
      win.block_start, win.block_end, extra.address ?? null, extra.area ?? null, extra.service_area_id ?? null,
      priceTotal, advanceDue, Boolean(extra.decoration), addMinutes(now, settings.hold_minutes),
      extra.idempotency_key ?? null, extra.notes ?? null, extra.reschedule_of ?? null, now],
  );
  const b = rows[0];
  for (const u of units.slice(0, setups)) {
    await client.query(
      `INSERT INTO booking_units (booking_id, unit_id, period, status) VALUES ($1, $2, tstzrange($3, $4), 'held')`,
      [b.id, u.id, win.block_start, win.block_end]);
  }
  return normalizeBookingRow(b);
}

// --------------------------------------------------------------------------
// Availability
// --------------------------------------------------------------------------

async function checkAvailability(input) {
  return withTx(async (client) => {
    const settings = await getSettings(client);
    await sweepExpiredHolds(client);
    const req = normalizeRequest(input, settings);
    const win = computeWindow(req.kind, req.params, settings);
    const cap = await capacity(client, win, settings);
    const ok = fits(cap, req.setups, req.controllers);
    return {
      available: ok,
      kind: req.kind,
      setups_needed: req.setups,
      controllers_needed: req.controllers,
      free_units: cap.units.length,
      free_controllers: cap.controllersFree,
      window: { delivery_at: win.delivery_at, pickup_at: win.pickup_at, event_start: win.event_start, event_end: win.event_end,
        rental_start_date: win.rental_start_date, rental_end_date: win.rental_end_date },
      alternatives: ok ? [] : await alternatives(client, req.kind, req.params, req.setups, req.controllers, settings),
    };
  });
}

// --------------------------------------------------------------------------
// Create (always a hold)
// --------------------------------------------------------------------------

async function createBooking(input) {
  try {
    return await withTx(async (client) => {
      if (input.idempotency_key) {
        const existing = await client.query('SELECT ref FROM bookings WHERE idempotency_key = $1', [input.idempotency_key]);
        if (existing.rows[0]) {
          const b = await loadBooking(client, existing.rows[0].ref);
          return { created: false, booking: publicBooking(b), summary_for_customer: holdText(b, await getSettings(client)) };
        }
      }
      await lockBookings(client);
      const cat = await loadCatalog(client);
      const { settings } = cat;
      if (input.kind === 'birthday' && !settings.birthday_bookings_enabled) {
        throw new HttpError(409, 'BIRTHDAY_NOT_LIVE',
          'Birthday bookings are not open for automatic booking yet; collect the details and flag_for_human (custom_quote)');
      }
      const req = normalizeRequest(input, settings);
      const q = quote({ ...input, ...req.params, setups: req.setups, controllers: req.controllers }, cat);
      if (!q.quotable) {
        throw new HttpError(422, 'NEEDS_OWNER_QUOTE', 'This request needs a quote from the owner', { reasons: q.reasons });
      }
      await sweepExpiredHolds(client);
      const win = computeWindow(req.kind, req.params, settings);
      const cap = await capacity(client, win, settings);
      if (!fits(cap, req.setups, req.controllers)) {
        throw new HttpError(409, 'UNAVAILABLE', 'Not enough free units or controllers for that time', {
          free_units: cap.units.length, free_controllers: cap.controllersFree,
          alternatives: await alternatives(client, req.kind, req.params, req.setups, req.controllers, settings),
        });
      }
      const lead = await upsertLead(client, input.phone, { name: input.name });
      const b = await insertBooking(client, {
        leadId: lead.id, kind: req.kind, win, setups: req.setups, controllers: req.controllers,
        priceTotal: q.total, advanceDue: q.advance_due,
        extra: { address: input.address, area: input.area ?? lead.area, service_area_id: lead.service_area_id,
          decoration: input.decoration, idempotency_key: input.idempotency_key, notes: input.notes },
      }, cap.units, settings);
      await client.query(`UPDATE leads SET stage = 'booking_held', intent = $2 WHERE id = $1`, [lead.id, req.kind]);
      const full = { ...b, phone: lead.phone, name: lead.name };
      return { created: true, booking: publicBooking(full), summary_for_customer: holdText(full, settings) };
    });
  } catch (err) {
    // Retries were exhausted on a real overlap: report it like any full slot
    if (err.code === EXCLUSION_VIOLATION) {
      throw new HttpError(409, 'UNAVAILABLE', 'That slot was just taken; please check availability again');
    }
    throw err;
  }
}

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------

async function getBooking(ref, phone) {
  const b = await bookingOrThrow(pool, ref);
  assertOwner(b, phone);
  return { ...publicBooking(b), paid: await paidSoFar(pool, b.id) };
}

async function findBookings(phone, status) {
  const lead = await getLeadByPhone(pool, phone);
  if (!lead) return [];
  const { rows } = await pool.query(
    `SELECT b.*, $2::text AS phone FROM bookings b
      WHERE lead_id = $1 AND reschedule_of IS NULL AND ($3::text IS NULL OR status = $3)
      ORDER BY delivery_at DESC`, [lead.id, lead.phone, status || null]);
  return rows.map((r) => publicBooking(normalizeBookingRow(r)));
}

// --------------------------------------------------------------------------
// Cancel
// --------------------------------------------------------------------------

async function cancelBooking(ref, { phone, by }) {
  return withTx(async (client) => {
    await lockBookings(client);
    await sweepExpiredHolds(client);
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    if (by === 'customer') assertOwner(b, phone);
    if (!['held', 'confirmed'].includes(b.status)) {
      throw new HttpError(409, 'NOT_ACTIVE', `${b.ref} is ${b.status}, nothing to cancel`);
    }

    // Paid bookings are never cancelled by the bot: the owner talks to them
    if (b.status === 'confirmed' && by === 'customer') {
      const paid = await paidSoFar(client, b.id);
      const lead = { id: b.lead_id, phone: b.phone, name: b.name };
      const h = await createHandoff(client, {
        lead, reason: 'cancellation_paid', priority: 'urgent', bookingId: b.id,
        summary: `${b.ref} (${bookingWhen(b)}, paid ${rupees(paid)}) wants to cancel. Please call them. Send CANCEL ${b.ref} if it is cancelled.`,
      });
      return {
        cancelled: false, handed_off: true, booking: publicBooking(b),
        summary_for_customer: 'I have passed this to our team; they will call you shortly to help.',
        notifications: h.notifications,
      };
    }

    const now = clock.now();
    await client.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = $2, hold_expires_at = NULL WHERE id = $1`, [b.id, now]);
    // A pending reschedule hold goes with it
    await client.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = $2 WHERE reschedule_of = $1 AND status = 'held'`, [b.id, now]);
    await resolveHandoffs(client, 'booking_id = $2', [b.id]);
    await client.query(`UPDATE leads SET stage = 'lost' WHERE id = $1 AND stage IN ('booking_held','booked')`, [b.lead_id]);

    const notifications = by === 'customer'
      ? [{ to: 'owner', text: `❌ ${b.ref} (${who(b)}, ${bookingWhen(b)}) was cancelled by the customer before payment.` }]
      : [{ to: 'customer', phone: b.phone, text: `Your booking ${b.ref} (${bookingWhen(b)}) has been cancelled. We hope to see you again soon 🧡` }];
    return {
      cancelled: true, handed_off: false, booking: publicBooking({ ...b, status: 'cancelled' }),
      summary_for_customer: `Your booking ${b.ref} is cancelled.`,
      notifications,
    };
  });
}

// --------------------------------------------------------------------------
// Payment screenshot from the customer (does not confirm anything)
// --------------------------------------------------------------------------

async function claimPayment(ref, { phone, amount, note }) {
  return withTx(async (client) => {
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    assertOwner(b, phone);
    if (!['held', 'expired'].includes(b.status)) {
      throw new HttpError(409, 'NOT_PENDING', `${b.ref} is ${b.status}; no advance is pending`);
    }
    await client.query('UPDATE bookings SET payment_claimed_at = coalesce(payment_claimed_at, $2) WHERE id = $1', [b.id, clock.now()]);
    const lead = { id: b.lead_id, phone: b.phone, name: b.name };
    const amt = amount ? rupees(amount) : 'the advance';
    const h = await createHandoff(client, {
      lead, reason: 'payment_claim', bookingId: b.id, details: { amount: amount ?? null, note: note ?? null },
      summary: `${b.ref} (${bookingWhen(b)}) says they paid ${amt} (advance due ${rupees(b.advance_due)}). Check your UPI, then send PAID ${b.ref} ${amount ?? b.advance_due}.`,
    });
    return {
      claimed: true,
      summary_for_customer: 'Thank you! Our team will verify the payment and confirm your booking shortly 🧡',
      notifications: h.notifications,
    };
  });
}

// --------------------------------------------------------------------------
// Payments recorded by the owner
// --------------------------------------------------------------------------

async function recordPayment(ref, { amount, method, kind }) {
  return withTx(async (client) => {
    await lockBookings(client);
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    if (['cancelled', 'no_show'].includes(b.status)) throw new HttpError(409, 'NOT_ACTIVE', `${b.ref} is ${b.status}`);
    if (b.reschedule_of) throw new HttpError(409, 'TENTATIVE', `${b.ref} is a reschedule hold; record payment on the original booking`);

    const pending = ['held', 'expired'].includes(b.status);
    const payKind = kind || (pending ? 'advance' : 'balance');
    const notifications = [];
    let reply;

    if (pending && payKind === 'advance') {
      try {
        await client.query('SAVEPOINT reinstate');
        await client.query(`UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [b.id]);
      } catch (err) {
        if (err.code !== EXCLUSION_VIOLATION) throw err;
        await client.query('ROLLBACK TO SAVEPOINT reinstate');
        throw new HttpError(409, 'SLOT_TAKEN',
          `${b.ref}'s hold had expired and the slot is now booked by someone else. Payment not recorded.`);
      }
      await client.query(`UPDATE leads SET stage = 'booked' WHERE id = $1`, [b.lead_id]);
    }
    await client.query(
      `INSERT INTO payments (booking_id, kind, amount, method, received_at) VALUES ($1, $2, $3, $4, $5)`,
      [b.id, payKind, amount, method || null, clock.now()]);
    await resolveHandoffs(client, `booking_id = $2 AND reason = 'payment_claim'`, [b.id]);
    const paid = await paidSoFar(client, b.id);
    const balance = Math.max(0, b.price_total - paid);

    if (pending && payKind === 'advance') {
      const short = amount < b.advance_due ? ` (advance due was ${rupees(b.advance_due)})` : '';
      reply = `✅ ${b.ref} confirmed (${who(b)}, ${bookingWhen(b)}, ${bookingWhat(b)}). ${rupees(amount)} received${short}. Customer notified.`;
      const balanceWhen = b.kind === 'birthday' ? 'after the setup is installed' : 'on delivery';
      notifications.push({
        to: 'customer', phone: b.phone, template: 'booking_confirmed',
        text: `🎉 Your advance of ${rupees(amount)} is received and booking ${b.ref} is confirmed for ${bookingWhen(b)}. Balance ${rupees(balance)} is payable ${balanceWhen}. See you soon! 🎮`,
      });
    } else {
      reply = `✅ ${rupees(amount)} recorded for ${b.ref}. Paid ${rupees(paid)} of ${rupees(b.price_total)}${balance ? `, ${rupees(balance)} left` : ', fully paid'}.`;
    }
    return { ok: true, reply, paid, balance, notifications };
  });
}

// --------------------------------------------------------------------------
// Owner status updates
// --------------------------------------------------------------------------

async function updateBooking(ref, patch) {
  return withTx(async (client) => {
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    const sets = {};
    if (patch.status) {
      if (!['completed', 'no_show'].includes(patch.status)) {
        throw new HttpError(400, 'VALIDATION', 'status may only be set to completed or no_show here');
      }
      if (b.status !== 'confirmed') throw new HttpError(409, 'NOT_CONFIRMED', `${b.ref} is ${b.status}, not confirmed`);
      sets.status = patch.status;
      if (patch.status === 'completed') sets.completed_at = clock.now();
    }
    for (const k of ['address', 'notes', 'id_proof_received', 'agreement_signed']) {
      if (patch[k] !== undefined) sets[k] = patch[k];
    }
    const keys = Object.keys(sets);
    if (!keys.length) return publicBooking(b);
    await client.query(`UPDATE bookings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [b.id, ...keys.map((k) => sets[k])]);
    if (sets.status === 'completed') await client.query(`UPDATE leads SET stage = 'completed' WHERE id = $1`, [b.lead_id]);
    return publicBooking({ ...b, ...sets });
  });
}

// --------------------------------------------------------------------------
// Schedule for one day
// --------------------------------------------------------------------------

async function daySchedule(client, date, { excludeIds = [] } = {}) {
  const from = istDateTime(date, '00:00');
  const to = istDateTime(addDays(date, 1), '00:00');
  const { rows } = await client.query(
    `SELECT b.*, l.phone, l.name FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE b.status IN ('held','confirmed') AND b.block_period && tstzrange($1, $2)
        AND NOT (b.id = ANY($3::bigint[]))
      ORDER BY lower(b.block_period)`, [from, to, excludeIds]);
  return rows.map(normalizeBookingRow);
}

function scheduleLine(b) {
  const tentative = b.reschedule_of ? ' (reschedule hold)' : b.status === 'held' ? ' (unpaid hold)' : '';
  const area = b.area ? ` · ${b.area}` : '';
  if (b.kind === 'birthday') {
    return `• ${b.ref} ${fmtTime(new Date(b.event_start))}–${fmtTime(new Date(b.event_end))} · ${plural(b.setups, 'setup')}${area}${tentative}`;
  }
  return `• ${b.ref} rental ${fmtDate(b.rental_start_date)} → ${fmtDate(b.rental_end_date)} · ${bookingWhat(b)}${area}${tentative}`;
}

async function schedule(date) {
  const client = pool;
  const items = await daySchedule(client, date);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM units WHERE status = 'active'`);
  const lines = items.length ? items.map(scheduleLine) : ['• Nothing booked'];
  return {
    date, bookings: items.map(publicBooking),
    text: `📅 ${fmtDate(date)}: ${plural(items.length, 'booking')}, ${rows[0].n} units\n${lines.join('\n')}`,
  };
}

// --------------------------------------------------------------------------
// Reschedule: request (customer), move / decline (owner)
// --------------------------------------------------------------------------

function changeFromInput(b, input) {
  if (b.kind === 'birthday') {
    if (!input.date) throw new HttpError(400, 'VALIDATION', 'New date is required');
    return { date: input.date, start_time: input.start_time ?? hhmm(new Date(b.event_start)) };
  }
  const start = input.start_date ?? input.date;
  if (!start) throw new HttpError(400, 'VALIDATION', 'New start date is required');
  return { start_date: start };
}

async function requestReschedule(ref, { phone, ...input }) {
  return withTx(async (client) => {
    await lockBookings(client);
    await sweepExpiredHolds(client);
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    assertOwner(b, phone);
    if (!['held', 'confirmed'].includes(b.status) || b.reschedule_of) {
      throw new HttpError(409, 'NOT_ACTIVE', `${b.ref} is ${b.status}; it cannot be rescheduled`);
    }
    const settings = await getSettings(client);
    // Only one pending request per booking: a new one replaces the old hold
    await client.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = $2 WHERE reschedule_of = $1 AND status = 'held'`, [b.id, clock.now()]);

    const change = changeFromInput(b, input);
    const params = paramsFromBooking(b, change);
    const win = computeWindow(b.kind, params, settings);
    // The booking being moved frees its own units, so it does not count against itself
    const cap = await capacity(client, win, settings, [b.id]);
    const ok = fits(cap, b.setups, b.controllers);

    // A new slot that overlaps the current one can't be held separately (the
    // units are the same); MOVE with an explicit date handles it atomically.
    const orig = await client.query('SELECT lower(block_period) AS s, upper(block_period) AS e FROM bookings WHERE id = $1', [b.id]);
    const overlaps = win.block_start < orig.rows[0].e && win.block_end > orig.rows[0].s;

    let tentative = null;
    if (ok && !overlaps) {
      tentative = await insertBooking(client, {
        leadId: b.lead_id, kind: b.kind, win, setups: b.setups, controllers: b.controllers,
        priceTotal: b.price_total, advanceDue: b.advance_due,
        extra: { address: b.address, area: b.area, service_area_id: b.service_area_id, decoration: b.decoration,
          reschedule_of: b.id, notes: `Reschedule hold for ${b.ref}` },
      }, cap.units, settings);
    }

    const newDate = b.kind === 'birthday' ? params.date : params.start_date;
    const day = await daySchedule(client, newDate, { excludeIds: [b.id, ...(tentative ? [tentative.id] : [])] });
    const paid = await paidSoFar(client, b.id);
    const { rows: [{ n: activeUnits }] } = await client.query(`SELECT count(*)::int AS n FROM units WHERE status = 'active'`);
    const target = { ...b, ...win, rental_start_date: win.rental_start_date, rental_end_date: win.rental_end_date };
    const lines = [
      `🔁 Reschedule request: ${b.ref}`,
      `${who(b)} · ${paid ? `paid ${rupees(paid)}` : 'unpaid hold'}`,
      `From: ${bookingWhen(b)}, ${bookingWhat(b)}`,
      `To:   ${bookingWhen(target)}, ${bookingWhat(b)}`,
      '',
      `${fmtDate(newDate)} bookings:`,
      ...(day.length ? day.map(scheduleLine) : ['• Nothing booked']),
      `Free for that slot: ${cap.units.length} of ${activeUnits} units, ${cap.controllersFree} controllers`,
      '',
    ];
    let alts = [];
    if (ok && tentative) {
      lines.push('✅ Can be accommodated.', `Reply: MOVE ${b.ref} (or DECLINE ${b.ref}). New slot held for ${Math.round(settings.hold_minutes / 60)}h.`);
    } else if (ok) {
      lines.push('✅ Can be accommodated (overlaps the current slot, so nothing extra is held).',
        `Reply: MOVE ${b.ref} ${b.kind === 'birthday' ? `${params.date} ${params.start_time}` : params.start_date} (or DECLINE ${b.ref}).`);
    } else {
      alts = await alternatives(client, b.kind, params, b.setups, b.controllers, settings, [b.id]);
      const altText = alts.map((a) => (a.start_time ? fmtTime(istDateTime(a.date, a.start_time)) : fmtDate(a.start_date))).join(', ');
      lines.push(`❌ Cannot be accommodated: only ${cap.units.length} unit(s) / ${cap.controllersFree} controllers free.`,
        alts.length ? `Nearest that fit: ${altText}` : 'No nearby slot fits.',
        `Reply: MOVE ${b.ref} <date> <time> to move elsewhere, or DECLINE ${b.ref}.`);
    }

    await createHandoff(client, {
      lead: { id: b.lead_id, phone: b.phone, name: b.name }, reason: 'reschedule', bookingId: b.id,
      summary: lines.join('\n'), details: { requested: change, fits: ok, tentative_ref: tentative?.ref ?? null },
    });
    return {
      fits: ok, held: Boolean(tentative), alternatives: alts,
      summary_for_customer: 'I have shared your reschedule request with our team. They will confirm the new date with you shortly.',
      // The full reschedule alert replaces the generic handoff ping
      notifications: [{ to: 'owner', text: lines.join('\n') }],
    };
  });
}

async function moveBooking(ref, change) {
  return withTx(async (client) => {
    await lockBookings(client);
    await sweepExpiredHolds(client);
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    if (!['held', 'confirmed'].includes(b.status) || b.reschedule_of) {
      throw new HttpError(409, 'NOT_ACTIVE', `${b.ref} is ${b.status}; it cannot be moved`);
    }
    const settings = await getSettings(client);
    const { rows: tentatives } = await client.query(
      `SELECT * FROM bookings WHERE reschedule_of = $1 AND status = 'held'`, [b.id]);
    const tentative = tentatives[0] ? normalizeBookingRow(tentatives[0]) : null;

    let params;
    if (change && (change.date || change.start_date)) {
      params = paramsFromBooking(b, changeFromInput(b, change));
    } else if (tentative) {
      params = paramsFromBooking(tentative);
    } else {
      throw new HttpError(404, 'NO_PENDING_RESCHEDULE',
        `No pending reschedule for ${b.ref}. Use MOVE ${b.ref} <date> <time> to move it directly.`);
    }

    // Release the tentative hold and the original's units, then re-block in one go
    if (tentative) await client.query('DELETE FROM bookings WHERE id = $1', [tentative.id]);
    const win = computeWindow(b.kind, params, settings);
    const cap = await capacity(client, win, settings, [b.id]);
    if (!fits(cap, b.setups, b.controllers)) {
      throw new HttpError(409, 'UNAVAILABLE', `❌ ${b.ref} cannot move there: only ${cap.units.length} unit(s) free.`);
    }
    await client.query('DELETE FROM booking_units WHERE booking_id = $1', [b.id]);
    await client.query(
      `UPDATE bookings SET event_start = $2, event_end = $3, rental_start_date = $4, rental_end_date = $5,
              delivery_at = $6, pickup_at = $7, block_period = tstzrange($8, $9),
              hold_expires_at = CASE WHEN status = 'held' THEN $10::timestamptz ELSE NULL END,
              reminder_sent_at = NULL, pickup_reminder_sent_at = NULL, hold_nudged_at = NULL
        WHERE id = $1`,
      [b.id, win.event_start ?? null, win.event_end ?? null, win.rental_start_date ?? null, win.rental_end_date ?? null,
        win.delivery_at, win.pickup_at, win.block_start, win.block_end, addMinutes(clock.now(), settings.hold_minutes)]);
    for (const u of cap.units.slice(0, b.setups)) {
      await client.query(`INSERT INTO booking_units (booking_id, unit_id, period, status) VALUES ($1, $2, tstzrange($3, $4), $5)`,
        [b.id, u.id, win.block_start, win.block_end, b.status]);
    }
    await resolveHandoffs(client, `booking_id = $2 AND reason = 'reschedule'`, [b.id]);
    const moved = await loadBooking(client, b.ref);
    return {
      ok: true,
      reply: `✅ ${b.ref} moved to ${bookingWhen(moved)} (${who(b)}). Customer notified.`,
      booking: publicBooking(moved),
      notifications: [{ to: 'customer', phone: b.phone,
        text: `✅ Your booking ${b.ref} has been moved to ${bookingWhen(moved)}. See you then! 🎮` }],
    };
  });
}

async function declineReschedule(ref) {
  return withTx(async (client) => {
    const b = await bookingOrThrow(client, ref, { forUpdate: true });
    const { rowCount } = await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = $2 WHERE reschedule_of = $1 AND status = 'held'`, [b.id, clock.now()]);
    await resolveHandoffs(client, `booking_id = $2 AND reason = 'reschedule'`, [b.id]);
    return {
      ok: true,
      reply: `✅ Reschedule for ${b.ref} declined${rowCount ? ', held slot released' : ''}. ${b.ref} stays on ${bookingWhen(b)}.`,
      notifications: [{ to: 'customer', phone: b.phone,
        text: `About your reschedule request for ${b.ref}: that date doesn't work for us, sorry. Your booking stays on ${bookingWhen(b)}; our team will call you to discuss other dates.` }],
    };
  });
}

module.exports = {
  checkAvailability, createBooking, getBooking, findBookings, cancelBooking, claimPayment, recordPayment,
  updateBooking, schedule, requestReschedule, moveBooking, declineReschedule, loadBooking, publicBooking,
  daySchedule, scheduleLine,
};
