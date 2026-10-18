const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, owner, rental, resetDb, pool, clock } = require('./helpers');

beforeEach(resetDb);
after(() => pool.end());

const phone = (n) => `9198000000${String(n).padStart(2, '0')}`;

async function heldRental(n, start = '2026-11-10', extra) {
  await api.post('/messages', { phone: phone(n), direction: 'in', body: 'hi', name: `Customer${n}` });
  return (await rental(phone(n), start, extra)).body.booking.ref;
}

test('only the owner number can run commands', async () => {
  const r = await api.post('/owner/command', { phone: phone(1), text: 'HELP' });
  assert.equal(r.status, 404);
  assert.match((await owner('help')).body.reply, /PAID RP-1042/);
  assert.match((await owner('what is this')).body.reply, /didn't understand/);
});

test('PAID confirms a hold, notifies the customer, and later payments count as balance', async () => {
  const ref = await heldRental(1);
  const r = (await owner(`PAID ${ref} 275 upi`)).body;
  assert.equal(r.ok, true);
  assert.match(r.reply, new RegExp(`✅ ${ref} confirmed \\(Customer1`));
  assert.equal(r.notifications[0].to, 'customer');
  assert.equal(r.notifications[0].phone, phone(1));
  assert.match(r.notifications[0].text, /₹2,475/); // balance on delivery
  assert.equal((await api.get(`/bookings/${ref}`)).body.status, 'confirmed');
  assert.equal((await api.get(`/leads/${phone(1)}`)).body.stage, 'booked');

  const bal = (await owner(`paid ${ref.toLowerCase()} 2475 cash`)).body;
  assert.match(bal.reply, /Paid ₹2,750 of ₹2,750, fully paid/);
});

test('PAID resolves the payment-claim handoff and works on a lapsed-but-claimed hold', async () => {
  const ref = await heldRental(1);
  await api.post(`/bookings/${ref}/payment-claim`, { phone: phone(1), amount: 275 });
  clock.set('2026-11-02T18:00:00+05:30'); // long past 2h, but the claim keeps it
  assert.equal((await api.get('/handoffs')).body.length, 1);
  assert.match((await owner(`PAID ${ref} 275`)).body.reply, /confirmed/);
  assert.equal((await api.get('/handoffs')).body.length, 0);
});

test('PAID on an expired hold re-confirms it if the unit is still free, refuses if it was taken', async () => {
  const ref = await heldRental(1);
  clock.set('2026-11-02T12:30:00+05:30');
  assert.match((await owner(`PAID ${ref} 275`)).body.reply, /confirmed/);

  const ref2 = await heldRental(2, '2026-11-20');
  clock.set('2026-11-02T15:00:00+05:30');
  for (let i = 3; i <= 8; i++) await heldRental(i, '2026-11-20'); // fill all 6 units after ref2 lapsed
  const r = (await owner(`PAID ${ref2} 275`)).body;
  assert.equal(r.ok, false);
  assert.match(r.reply, /booked by someone else/);
});

test('a mistyped booking number gets a suggestion', async () => {
  const ref = await heldRental(1); // RP-1001
  const digits = ref.slice(3); // 1001 → typo 1010 (last two digits swapped)
  const swapped = `RP-${digits.slice(0, 2)}${digits[3]}${digits[2]}`;
  assert.notEqual(swapped, ref);
  const r = (await owner(`PAID ${swapped} 275`)).body;
  assert.equal(r.ok, false);
  assert.match(r.reply, new RegExp(`No booking ${swapped}\\. Did you mean ${ref} \\(Customer1`));
  assert.match((await owner('PAID 1001')).body.reply, /Give a booking number|Usage/);
});

test('DONE, NOSHOW and CANCEL', async () => {
  const a = await heldRental(1);
  assert.match((await owner(`DONE ${a}`)).body.reply, /is held, not confirmed/);
  await owner(`PAID ${a} 275`);
  assert.match((await owner(`DONE ${a}`)).body.reply, /marked completed/);
  const b = await heldRental(2);
  await owner(`PAID ${b} 275`);
  assert.match((await owner(`NOSHOW ${b}`)).body.reply, /no-show/);
  const c = await heldRental(3);
  const cancel = (await owner(`CANCEL ${c}`)).body;
  assert.match(cancel.reply, /cancelled/);
  assert.equal(cancel.notifications[0].to, 'customer');
});

test('reschedule: the new slot is held, MOVE applies it and keeps payments', async () => {
  const ref = await heldRental(1);
  await owner(`PAID ${ref} 275`);
  const r = (await api.post(`/bookings/${ref}/reschedule-request`, { phone: phone(1), start_date: '2026-11-24' })).body;
  assert.equal(r.fits, true);
  assert.equal(r.held, true);
  assert.match(r.summary_for_customer, /shared your reschedule request/);
  const alert = r.notifications[0].text;
  assert.match(alert, /🔁 Reschedule request/);
  assert.match(alert, /paid ₹275/);
  assert.match(alert, /✅ Can be accommodated/);
  assert.match(alert, new RegExp(`MOVE ${ref}`));

  // The tentative hold blocks a unit on the new dates
  assert.equal((await api.get('/availability?kind=rental&start_date=2026-11-24&days=7')).body.free_units, 5);

  const m = (await owner(`MOVE ${ref}`)).body;
  assert.match(m.reply, /moved to Tue 24 Nov → Tue 1 Dec/);
  assert.match(m.notifications[0].text, /has been moved/);
  const b = (await api.get(`/bookings/${ref}`)).body;
  assert.equal(b.rental_start_date, '2026-11-24');
  assert.equal(b.status, 'confirmed');
  assert.equal(b.paid, 275);
  // Old dates are free, new dates hold exactly one unit (no leftover tentative hold)
  assert.equal((await api.get('/availability?kind=rental&start_date=2026-11-10&days=7')).body.free_units, 6);
  assert.equal((await api.get('/availability?kind=rental&start_date=2026-11-24&days=7')).body.free_units, 5);
  assert.equal((await api.get('/handoffs')).body.length, 0);
});

test('reschedule that does not fit holds nothing and lists alternatives; DECLINE informs the customer', async () => {
  const ref = await heldRental(1);
  for (let i = 2; i <= 7; i++) await heldRental(i, '2026-11-24');
  const r = (await api.post(`/bookings/${ref}/reschedule-request`, { phone: phone(1), start_date: '2026-11-25' })).body;
  assert.equal(r.fits, false);
  assert.equal(r.held, false);
  assert.match(r.notifications[0].text, /❌ Cannot be accommodated/);
  const d = (await owner(`DECLINE ${ref}`)).body;
  assert.match(d.reply, /declined/);
  assert.match(d.notifications[0].text, /stays on/);
  assert.equal((await api.get(`/bookings/${ref}`)).body.rental_start_date, '2026-11-10');
});

test('MOVE with an explicit date for a birthday the owner agreed by phone', async () => {
  await owner('BIRTHDAYS ON');
  await api.post('/messages', { phone: phone(1), direction: 'in', body: 'hi', name: 'Priya' });
  const ref = (await api.post('/bookings', { kind: 'birthday', phone: phone(1), date: '2026-11-14', start_time: '15:30', setups: 1 })).body.booking.ref;
  const r = (await owner(`MOVE ${ref} 15/11 4pm`)).body;
  assert.match(r.reply, /moved to Sun 15 Nov, 4pm–7pm/);
  assert.match((await owner(`MOVE ${ref}`)).body.reply, /No pending reschedule/);
});

test('the requested-slot hold lapses after 2h and the owner is told', async () => {
  const ref = await heldRental(1);
  await owner(`PAID ${ref} 275`);
  await api.post(`/bookings/${ref}/reschedule-request`, { phone: phone(1), start_date: '2026-11-24' });
  clock.set('2026-11-02T12:05:00+05:30');
  const s = (await api.post('/jobs/sweep')).body;
  assert.equal(s.expired, 1);
  assert.match(s.notifications[0].text, new RegExp(`reschedule slot for ${ref}.*lapsed`));
  assert.match((await owner(`MOVE ${ref}`)).body.reply, /No pending reschedule/);
});

test('RESUME and PAUSED', async () => {
  await api.post('/messages', { phone: phone(1), direction: 'in', body: 'hi', name: 'Priya' });
  const p = (await api.post(`/leads/${phone(1)}/pause`)).body;
  assert.equal(p.first_pause, true);
  assert.match(p.notifications[0].text, /Send RESUME 98000000\d\d/);
  assert.equal((await api.post(`/leads/${phone(1)}/pause`)).body.notifications.length, 0);
  assert.match((await owner('PAUSED')).body.reply, /Priya/);
  assert.match((await owner(`RESUME ${phone(1).slice(2)}`)).body.reply, /replying to Priya/);
  assert.match((await owner('PAUSED')).body.reply, /No paused chats/);
  assert.match((await owner('RESUME 9999999999')).body.reply, /No chat with/);
});

test('TODAY / TOMORROW / SCHEDULE and SET', async () => {
  await heldRental(1, '2026-11-03', { days: 1 });
  assert.match((await owner('TOMORROW')).body.reply, /Tue 3 Nov: 1 booking/);
  assert.match((await owner('TODAY')).body.reply, /Nothing booked/);
  assert.match((await owner('SCHEDULE 2026-11-03')).body.reply, /rental Tue 3 Nov → Wed 4 Nov/);
  assert.match((await owner('SET travel_buffer_min 60')).body.reply, /set to 60/);
  assert.match((await owner('SET business_open 8am')).body.reply, /set to 08:00/);
  assert.match((await owner('SET birthday_bookings_enabled true')).body.reply, /Can't set/);
  assert.match((await owner('SETTINGS')).body.reply, /travel_buffer_min: 60/);
});
