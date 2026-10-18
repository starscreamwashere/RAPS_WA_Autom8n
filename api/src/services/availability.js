// Time windows, free units and controller stock. The same functions serve
// availability checks, new bookings and reschedules, so they always agree.
const clock = require('../clock');
const { HttpError } = require('../errors');
const { istDateTime, istDate, addDays, addMinutes, hhmm } = require('../time');

const LIVE = `('held','confirmed')`;

// Works out when the team is on site and how long the units are blocked.
function computeWindow(kind, p, settings) {
  const now = clock.now();
  const today = istDate(now);
  const travel = settings.travel_buffer_min;

  if (kind === 'birthday') {
    if (!p.date || !p.start_time) throw new HttpError(400, 'VALIDATION', 'Birthday needs date and start_time');
    if (p.date < today) throw new HttpError(422, 'IN_PAST', 'That date has already passed');
    const hours = p.hours ?? settings.birthday_default_hours;
    const eventStart = istDateTime(p.date, p.start_time);
    const eventEnd = addMinutes(eventStart, hours * 60);
    const onSiteStart = addMinutes(eventStart, -settings.setup_buffer_min);
    const onSiteEnd = addMinutes(eventEnd, settings.teardown_buffer_min);
    const open = istDateTime(p.date, settings.business_open);
    const close = istDateTime(p.date, settings.business_close);
    if (onSiteStart < open || onSiteEnd > close) {
      throw new HttpError(422, 'OUTSIDE_HOURS',
        `Setup to teardown must fit within ${settings.business_open}–${settings.business_close}`,
        { on_site_from: hhmm(onSiteStart), on_site_until: hhmm(onSiteEnd) });
    }
    const blockStart = addMinutes(onSiteStart, -travel);
    if (blockStart < now) {
      throw new HttpError(422, 'TOO_SOON', 'Not enough time to travel and set up before that start time');
    }
    return {
      kind, hours,
      event_start: eventStart, event_end: eventEnd,
      delivery_at: onSiteStart, pickup_at: onSiteEnd,
      block_start: blockStart, block_end: addMinutes(onSiteEnd, travel),
    };
  }

  if (kind === 'rental') {
    if (!p.start_date || !p.days) throw new HttpError(400, 'VALIDATION', 'Rental needs start_date and days');
    if (p.start_date < today) throw new HttpError(422, 'IN_PAST', 'That date has already passed');
    const endDate = addDays(p.start_date, p.days);
    const open = istDateTime(p.start_date, settings.business_open);
    const close = istDateTime(p.start_date, settings.business_close);
    let deliveryAt = open;
    if (p.start_date === today) {
      const earliest = addMinutes(now, travel);
      if (earliest > close) throw new HttpError(422, 'TOO_SOON', 'Too late to deliver today; earliest is tomorrow');
      if (earliest > deliveryAt) deliveryAt = earliest;
    }
    return {
      kind, days: p.days,
      rental_start_date: p.start_date, rental_end_date: endDate,
      delivery_at: deliveryAt, pickup_at: istDateTime(endDate, settings.business_close),
      block_start: open, block_end: istDateTime(endDate, settings.business_close),
    };
  }
  throw new HttpError(400, 'VALIDATION', 'kind must be birthday or rental');
}

// Releases unpaid holds whose time is up. A hold where the customer says they
// have paid stays until the owner records (or rejects) the payment.
async function sweepExpiredHolds(client) {
  const { rows } = await client.query(
    `UPDATE bookings SET status = 'expired'
      WHERE status = 'held' AND hold_expires_at < $1 AND payment_claimed_at IS NULL
      RETURNING id, ref, reschedule_of, lead_id`,
    [clock.now()],
  );
  return rows;
}

async function freeUnits(client, blockStart, blockEnd, excludeBookingIds = []) {
  const { rows } = await client.query(
    `SELECT u.id, u.code FROM units u
      WHERE u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM booking_units bu
           WHERE bu.unit_id = u.id AND bu.status IN ${LIVE}
             AND bu.period && tstzrange($1, $2)
             AND NOT (bu.booking_id = ANY($3::bigint[])))
      ORDER BY u.code`,
    [blockStart, blockEnd, excludeBookingIds],
  );
  return rows;
}

// Conservative: counts every live booking that overlaps the window at all.
async function controllersInUse(client, blockStart, blockEnd, excludeBookingIds = []) {
  const { rows } = await client.query(
    `SELECT coalesce(sum(controllers), 0)::int AS n FROM bookings
      WHERE status IN ${LIVE} AND block_period && tstzrange($1, $2)
        AND NOT (id = ANY($3::bigint[]))`,
    [blockStart, blockEnd, excludeBookingIds],
  );
  return rows[0].n;
}

async function capacity(client, win, settings, exclude = []) {
  const units = await freeUnits(client, win.block_start, win.block_end, exclude);
  const used = await controllersInUse(client, win.block_start, win.block_end, exclude);
  return { units, controllersFree: Math.max(0, settings.controllers_total - used) };
}

const fits = (cap, setups, controllers) => cap.units.length >= setups && cap.controllersFree >= controllers;

// Nearby options when the requested slot is full: other start times that
// day for birthdays (30-minute steps), the next start days for rentals.
async function alternatives(client, kind, p, setups, controllers, settings, exclude = []) {
  const found = [];
  if (kind === 'birthday') {
    const candidates = [];
    for (let m = 9 * 60; m <= 20 * 60; m += 30) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      if (t !== p.start_time) candidates.push(t);
    }
    const [rh, rm] = p.start_time.split(':').map(Number);
    candidates.sort((a, b) => {
      const dist = (t) => Math.abs(Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) - (rh * 60 + rm));
      return dist(a) - dist(b);
    });
    for (const t of candidates) {
      if (found.length === 3) break;
      let win;
      try { win = computeWindow('birthday', { ...p, start_time: t }, settings); } catch { continue; }
      if (fits(await capacity(client, win, settings, exclude), setups, controllers)) {
        found.push({ date: p.date, start_time: t });
      }
    }
  } else {
    for (let i = 1; i <= 14 && found.length < 3; i++) {
      const start = addDays(p.start_date, i);
      const win = computeWindow('rental', { ...p, start_date: start }, settings);
      if (fits(await capacity(client, win, settings, exclude), setups, controllers)) {
        found.push({ start_date: start, end_date: win.rental_end_date });
      }
    }
  }
  return found;
}

module.exports = { computeWindow, sweepExpiredHolds, freeUnits, controllersInUse, capacity, fits, alternatives };
