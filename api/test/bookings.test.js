const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, owner, rental, resetDb, pool, clock } = require('./helpers');

beforeEach(resetDb);
after(() => pool.end());

const phone = (n) => `9198000000${String(n).padStart(2, '0')}`;

test('a rental booking is created as a 2-hour hold with the right money', async () => {
  const r = await rental(phone(1), '2026-11-10', { controllers: 2, area: 'Powai' });
  assert.equal(r.status, 201);
  const b = r.body.booking;
  assert.match(b.ref, /^RP-\d{4}$/);
  assert.equal(b.status, 'held');
  assert.equal(b.price_total, 2999);
  assert.equal(b.advance_due, 300);
  assert.equal(b.rental_end_date, '2026-11-17');
  assert.equal(new Date(b.hold_expires_at).toISOString(), '2026-11-02T06:30:00.000Z'); // 12:00 IST
  assert.match(r.body.summary_for_customer, /₹300/);
  assert.match(r.body.summary_for_customer, /vindyreddy3011@oksbi/);
  assert.match(r.body.summary_for_customer, /12pm/);

  const lead = (await api.get(`/leads/${phone(1)}`)).body;
  assert.equal(lead.stage, 'booking_held');
  assert.equal(lead.active_bookings.length, 1);
});

test('the same Idempotency-Key never creates two bookings', async () => {
  const body = { kind: 'rental', phone: phone(1), start_date: '2026-11-10', days: 7, controllers: 1 };
  const a = await api.post('/bookings', body).set('Idempotency-Key', 'wamid.123');
  const b = await api.post('/bookings', body).set('Idempotency-Key', 'wamid.123');
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.body.booking.ref, b.body.booking.ref);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM bookings');
  assert.equal(rows[0].n, 1);
});

test('six PS5s can be booked; the seventh overlapping request is refused with alternatives', async () => {
  for (let i = 1; i <= 6; i++) assert.equal((await rental(phone(i), '2026-11-10')).status, 201);
  const r = await rental(phone(7), '2026-11-12');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'UNAVAILABLE');
  assert.ok(r.body.error.details.alternatives.length > 0);
  // The week after the rentals end is free again
  assert.equal((await rental(phone(7), '2026-11-18')).status, 201);
});

test('race: parallel requests for the last free PS5 produce exactly one booking', async () => {
  for (let i = 1; i <= 5; i++) assert.equal((await rental(phone(i), '2026-11-10')).status, 201);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => rental(phone(20 + i), '2026-11-11')));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409, 409, 409]);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE status = 'held'`);
  assert.equal(rows[0].n, 6);
});

test('the database itself rejects an overlapping unit even if the API is bypassed', async () => {
  const r = await rental(phone(1), '2026-11-10');
  const { rows: [b] } = await pool.query('SELECT id, lead_id FROM bookings WHERE ref = $1', [r.body.booking.ref]);
  const { rows: [bu] } = await pool.query('SELECT unit_id FROM booking_units WHERE booking_id = $1', [b.id]);
  const { rows: [copy] } = await pool.query(
    `INSERT INTO bookings (lead_id, kind, setups, controllers, rental_start_date, rental_end_date, delivery_at, pickup_at,
       block_period, price_total, advance_due)
     SELECT lead_id, kind, setups, controllers, rental_start_date, rental_end_date, delivery_at, pickup_at,
       block_period, price_total, advance_due FROM bookings WHERE id = $1 RETURNING id`, [b.id]);
  await assert.rejects(
    pool.query(`INSERT INTO booking_units (booking_id, unit_id, period, status)
                SELECT $1, $2, block_period, 'held' FROM bookings WHERE id = $1`, [copy.id, bu.unit_id]),
    (err) => err.code === '23P01');
});

test('controller stock is shared: 20 controllers cap concurrent use even with consoles free', async () => {
  await owner('BIRTHDAYS ON');
  // 5 birthday setups × 4 controllers = 20 controllers, 5 consoles
  const party = await api.post('/bookings', { kind: 'birthday', phone: phone(1), date: '2026-11-14', start_time: '15:30', setups: 5 });
  assert.equal(party.status, 201, JSON.stringify(party.body));
  const avail = (await api.get('/availability?kind=rental&start_date=2026-11-14&days=1&controllers=1')).body;
  assert.equal(avail.free_units, 1);
  assert.equal(avail.free_controllers, 0);
  assert.equal(avail.available, false);
  assert.equal((await rental(phone(2), '2026-11-14', { days: 1 })).status, 409);
});

test('birthday bookings are refused until the owner turns them on', async () => {
  const body = { kind: 'birthday', phone: phone(1), date: '2026-11-14', start_time: '15:30', players: 8 };
  const off = await api.post('/bookings', body);
  assert.equal(off.status, 409);
  assert.equal(off.body.error.code, 'BIRTHDAY_NOT_LIVE');
  assert.match((await owner('BIRTHDAYS ON')).body.reply, /live/);
  const on = await api.post('/bookings', body);
  assert.equal(on.status, 201);
  assert.equal(on.body.booking.setups, 2);
  assert.equal(on.body.booking.controllers, 8);
  assert.equal(on.body.booking.price_total, 18000);
  assert.equal(on.body.booking.advance_due, 9000);
});

test('birthday timing: setup to teardown must fit in business hours, travel blocks the unit', async () => {
  await owner('BIRTHDAYS ON');
  const late = await api.get('/availability?kind=birthday&date=2026-11-14&start_time=17:00&setups=1');
  assert.equal(late.status, 422);
  assert.equal(late.body.error.code, 'OUTSIDE_HOURS'); // 17:00 + 3h + 30m teardown > 20:00

  // 15:30 party: on site 14:45–19:00, unit blocked 13:15–20:30 (90 min travel each way)
  const r = await api.post('/bookings', { kind: 'birthday', phone: phone(1), date: '2026-11-14', start_time: '15:30', setups: 1 });
  assert.equal(r.status, 201);
  const { rows: [b] } = await pool.query(
    `SELECT to_char(lower(block_period) AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS s,
            to_char(upper(block_period) AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS e,
            to_char(delivery_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS arrive
       FROM bookings WHERE ref = $1`, [r.body.booking.ref]);
  assert.deepEqual(b, { s: '13:15', e: '20:30', arrive: '14:45' });

  // 6 setups need 24 controllers (we own 20): the owner quotes it
  const big = await api.post('/bookings', { kind: 'birthday', phone: phone(2), date: '2026-11-15', start_time: '15:30', setups: 6 });
  assert.equal(big.status, 422);
  assert.equal(big.body.error.code, 'NEEDS_OWNER_QUOTE');
});

test('birthday on the same day respects travel time', async () => {
  await owner('BIRTHDAYS ON');
  // It is 10:00. A 12:00 start needs the team to leave at 09:45: too soon
  const soon = await api.get('/availability?kind=birthday&date=2026-11-02&start_time=12:00&setups=1');
  assert.equal(soon.status, 422);
  assert.equal(soon.body.error.code, 'TOO_SOON');
  const ok = await api.get('/availability?kind=birthday&date=2026-11-02&start_time=13:00&setups=1');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.available, true);
});

test('same-day rental is fine during the day, refused too close to closing', async () => {
  assert.equal((await rental(phone(1), '2026-11-02', { days: 1 })).status, 201);
  clock.set('2026-11-02T19:00:00+05:30');
  const r = await rental(phone(2), '2026-11-02', { days: 1 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'TOO_SOON');
});

test('unpaid holds lapse after 2 hours and free the unit; a payment claim keeps the hold', async () => {
  for (let i = 1; i <= 6; i++) await rental(phone(i), '2026-11-10');
  const claimed = (await api.get(`/bookings?phone=${phone(1)}`)).body[0].ref;
  const claim = await api.post(`/bookings/${claimed}/payment-claim`, { phone: phone(1), amount: 275 });
  assert.equal(claim.status, 200);
  assert.match(claim.body.notifications[0].text, new RegExp(`PAID ${claimed} 275`));

  clock.set('2026-11-02T12:01:00+05:30');
  const avail = (await api.get('/availability?kind=rental&start_date=2026-11-10&days=7&controllers=1')).body;
  assert.equal(avail.free_units, 5); // 5 unclaimed holds expired, the claimed one stays
  const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM bookings GROUP BY status ORDER BY status`);
  assert.deepEqual(rows, [{ status: 'expired', n: 5 }, { status: 'held', n: 1 }]);
});

test('a customer cancels their unpaid hold; the owner is told', async () => {
  const ref = (await rental(phone(1), '2026-11-10')).body.booking.ref;
  const wrong = await api.post(`/bookings/${ref}/cancel`, { phone: phone(2) });
  assert.equal(wrong.status, 404); // someone else's booking is invisible
  const r = await api.post(`/bookings/${ref}/cancel`, { phone: phone(1) });
  assert.equal(r.body.cancelled, true);
  assert.equal(r.body.notifications[0].to, 'owner');
  assert.equal((await api.get('/availability?kind=rental&start_date=2026-11-10&days=7')).body.free_units, 6);
});

test('a paid booking is never cancelled by the bot: it becomes an urgent handoff', async () => {
  const ref = (await rental(phone(1), '2026-11-10')).body.booking.ref;
  await owner(`PAID ${ref} 275`);
  const r = await api.post(`/bookings/${ref}/cancel`, { phone: phone(1) });
  assert.equal(r.body.cancelled, false);
  assert.equal(r.body.handed_off, true);
  assert.match(r.body.notifications[0].text, /cancellation paid/);
  assert.equal((await api.get(`/bookings/${ref}`)).body.status, 'confirmed');
  const h = (await api.get('/handoffs')).body;
  assert.equal(h[0].reason, 'cancellation_paid');
  assert.equal(h[0].priority, 'urgent');
});

test('validation errors are 400 with details', async () => {
  const r = await api.post('/bookings', { kind: 'rental', phone: phone(1), start_date: '10/11/2026', days: 7 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION');
  const past = await rental(phone(1), '2026-10-01');
  assert.equal(past.status, 422);
  assert.equal(past.body.error.code, 'IN_PAST');
  const offCard = await rental(phone(1), '2026-11-10', { days: 3 });
  assert.equal(offCard.status, 422);
  assert.equal(offCard.body.error.code, 'NEEDS_OWNER_QUOTE');
});
