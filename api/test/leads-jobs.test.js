const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, owner, rental, resetDb, pool, clock } = require('./helpers');

beforeEach(resetDb);
after(() => pool.end());

const P = '919800000001';

test('inbound messages create the lead once; Meta retries are flagged as duplicates', async () => {
  const msg = { phone: P, direction: 'in', wa_message_id: 'wamid.A1', body: 'Hi, what is the package?', name: 'Priya Shah' };
  const first = (await api.post('/messages', msg)).body;
  assert.equal(first.duplicate, false);
  assert.equal(first.is_new_lead, true);
  assert.equal(first.lead.name, 'Priya Shah');
  assert.equal((await api.post('/messages', msg)).body.duplicate, true);
  const second = (await api.post('/messages', { ...msg, wa_message_id: 'wamid.A2', body: 'hello?' })).body;
  assert.equal(second.is_new_lead, false);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM messages');
  assert.equal(rows[0].n, 2);
});

test('click-to-WhatsApp referral is stored on the lead', async () => {
  const referral = { source_type: 'ad', source_id: '120208', headline: 'Birthday special: PS5 at your party' };
  await api.post('/messages', { phone: P, direction: 'in', body: 'Hi', referral });
  const lead = (await api.get(`/leads/${P}`)).body;
  assert.equal(lead.source, 'ad');
  assert.equal(lead.ad_ref.headline, 'Birthday special: PS5 at your party');
});

test('the profile says what to ask before quoting, in the owner\'s order', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'birthday party enquiry' });
  let lead = (await api.patch(`/leads/${P}`, { intent: 'birthday' })).body;
  assert.deepEqual(lead.missing_for_quote, ['area', 'event_date', 'num_kids']);
  assert.equal(lead.stage, 'qualifying');

  lead = (await api.patch(`/leads/${P}`, { area: 'Kharghar', event_date: '2026-11-21' })).body;
  assert.equal(lead.in_service_area, true);
  assert.deepEqual(lead.missing_for_quote, ['num_kids']);

  lead = (await api.patch(`/leads/${P}`, { num_kids: 12 })).body;
  assert.deepEqual(lead.missing_for_quote, []); // all there: quote straight away
  assert.deepEqual(lead.missing_for_booking, ['preferred_start', 'decoration_wanted']);
});

test('a returning lead keeps its profile across days', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'need ps5 for a week' });
  await api.patch(`/leads/${P}`, { intent: 'rental', rental_days: 7, controllers_wanted: 2 });
  clock.set('2026-11-06T11:00:00+05:30');
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi again, is it still available?' });
  const lead = (await api.get(`/leads/${P}`)).body;
  assert.equal(lead.rental_days, 7);
  assert.equal(lead.controllers_wanted, 2);
  assert.deepEqual(lead.missing_for_quote, []);
  assert.deepEqual(lead.missing_for_booking, ['area', 'rental_start_date']);
});

test('unknown fields cannot be written through the profile tool', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi' });
  const r = await api.patch(`/leads/${P}`, { needs_human: false, bot_paused_at: null });
  assert.equal(r.status, 400);
});

test('STOP opts the lead out', async () => {
  const r = (await api.post('/messages', { phone: P, direction: 'in', body: 'STOP' })).body;
  assert.equal(r.opted_out, true);
});

test('sponsorship handoff pings the owner right away', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'We run the Juhu Diwali Mela', name: 'Event Team' });
  const r = (await api.post('/handoffs', {
    phone: P, reason: 'sponsorship', summary: 'Juhu Diwali Mela, 25 Oct, ~2,000 visitors, wants 2 free stations',
    details: { event: 'Juhu Diwali Mela', ask: 'free' },
  })).body;
  assert.match(r.notifications[0].text, /🤝 #\d+ sponsorship · Event Team/);
  assert.equal((await api.get(`/leads/${P}`)).body.needs_human, true);
  await owner(`RESOLVE ${r.handoff.id}`);
  assert.equal((await api.get(`/leads/${P}`)).body.needs_human, false);
});

test('reminder jobs: hold nudge, day-before reminder, pickup day, review ask', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi', name: 'Rohan Mehta' });
  const ref = (await rental(P, '2026-11-03', { days: 1 })).body.booking.ref;

  // 30 minutes before the 12:00 hold expiry: nudge the customer
  clock.set('2026-11-02T11:35:00+05:30');
  let due = (await api.get('/jobs/reminders-due')).body;
  assert.equal(due.length, 1);
  assert.equal(due[0].type, 'hold_nudge');
  assert.match(due[0].text, /Hi Rohan! Your slot .* is held until 12pm/);
  await api.post('/jobs/mark', { booking_ref: ref, field: due[0].mark });
  assert.equal((await api.get('/jobs/reminders-due')).body.length, 0);

  await owner(`PAID ${ref} 95`);
  clock.set('2026-11-02T18:00:00+05:30'); // delivery tomorrow 09:00 is within 24h
  due = (await api.get('/jobs/reminders-due')).body;
  assert.deepEqual(due.map((d) => d.type), ['booking_reminder']);
  assert.equal(due[0].template, 'booking_reminder');
  assert.ok(due[0].variables.every((x) => !/\n/.test(x)));
  await api.post('/jobs/mark', { booking_ref: ref, field: 'reminder_sent_at' });

  clock.set('2026-11-04T08:30:00+05:30'); // pickup day
  due = (await api.get('/jobs/reminders-due')).body;
  assert.deepEqual(due.map((d) => d.type), ['pickup_reminder']);
  assert.match(due[0].text, /scheduled for pickup today/);

  await owner(`DONE ${ref}`);
  assert.equal((await api.get('/jobs/reviews-due')).body.length, 0); // waits an hour
  clock.set('2026-11-04T10:00:00+05:30');
  const reviews = (await api.get('/jobs/reviews-due')).body;
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].text, /Google review/);
  assert.equal((await api.post('/jobs/mark', { booking_ref: ref, field: 'price_total' })).status, 400);
});

test('nightly digest is a single line for the template variable', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi', name: 'Rohan', referral: { headline: 'PS5 for a week' } });
  const ref = (await rental(P, '2026-11-03', { days: 1 })).body.booking.ref;
  await owner(`PAID ${ref} 95`);
  await api.post('/messages', { phone: '919800000002', direction: 'in', body: 'hi' });
  await rental('919800000002', '2026-11-10');
  await api.post('/handoffs', { phone: P, reason: 'complaint', summary: 'Controller drift on unit' });
  await api.post('/leads/919800000002/pause');
  clock.set('2026-11-02T21:00:00+05:30');

  const d = (await api.get('/reports/digest')).body;
  assert.equal(d.new_leads, 2);
  assert.equal(d.leads_from_ads, 1);
  assert.equal(d.bookings_made, 2);
  assert.equal(d.bookings_confirmed, 1);
  assert.equal(d.revenue_received, 95);
  assert.equal(d.holds_expired, 1);
  assert.deepEqual(d.tomorrow, [ref]);
  assert.doesNotMatch(d.text, /\n/);
  assert.match(d.text, /₹95 received/);
  assert.match(d.text, /needs you: #\d+ complaint/);
  assert.match(d.text, /bot paused for: 9800000002/);
  assert.match(d.text, /ads: PS5 for a week 1 leads\/1 booked/);
});
