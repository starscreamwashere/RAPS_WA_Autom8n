// WhatsApp usernames: customers who adopt one can reach us without their phone
// number, identified only by a business-scoped user ID (BSUID).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, owner, rental, resetDb, pool } = require('./helpers');

beforeEach(resetDb);
after(() => pool.end());

const U = 'IN.13491208655302741918';
const P = '919800000077';

test('a customer known only by user ID can chat, keep a profile and book', async () => {
  const m = (await api.post('/messages', { phone: U, user_id: U, username: 'rohan.plays', direction: 'in', wa_message_id: 'u1', body: 'PS5 for a week?', name: 'Rohan' })).body;
  assert.equal(m.is_new_lead, true);
  assert.equal(m.lead.phone, null);
  assert.equal(m.lead.user_id, U);

  await api.patch(`/leads/${U}`, { intent: 'rental', rental_days: 7, controllers_wanted: 1 });
  const p = (await api.get(`/leads/${U}?current=u1`)).body;
  assert.equal(p.username, 'rohan.plays');
  assert.equal(p.rental_days, 7);

  const b = (await rental(U, '2026-11-20')).body;
  assert.ok(b.created, JSON.stringify(b));
  assert.equal((await api.get(`/bookings?phone=${U}`)).body.length, 1);
  // Only this customer may touch it
  assert.equal((await api.post(`/bookings/${b.booking.ref}/cancel`, { phone: '919811112222' })).status, 404);
  assert.equal((await api.post(`/bookings/${b.booking.ref}/cancel`, { phone: U })).status, 200);
});

test('customer updates to a user-ID-only customer are addressed by recipient, not phone', async () => {
  await api.post('/messages', { user_id: U, direction: 'in', wa_message_id: 'u1', body: 'hi' });
  const { ref } = (await rental(U, '2026-11-20')).body.booking;
  await owner(`PAID ${ref} 275`);
  const msg = (await api.get('/outbox/pending')).body.find((o) => o.recipient === 'customer');
  assert.equal(msg.to, null);
  assert.equal(msg.user_id, U);
  assert.equal(msg.send_as, 'text'); // they wrote within 24h
});

test('when the phone shows up later, the two leads become one', async () => {
  // First contact: username only
  await api.post('/messages', { user_id: U, username: 'rohan.plays', direction: 'in', wa_message_id: 'u1', body: 'PS5 for a week?' });
  await api.patch(`/leads/${U}`, { intent: 'rental', rental_days: 7 });
  const { ref } = (await rental(U, '2026-11-20')).body.booking;
  // Separately, the same person had once messaged from their number
  await api.post('/messages', { phone: P, direction: 'in', wa_message_id: 'p1', body: 'hello', name: 'Rohan Mehta' });
  // Now a webhook carries both: merge
  await api.post('/messages', { phone: P, user_id: U, direction: 'in', wa_message_id: 'u2', body: 'any update?' });

  const { rows } = await pool.query('SELECT * FROM leads');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, P);
  assert.equal(rows[0].user_id, U);
  assert.equal(rows[0].username, 'rohan.plays');
  assert.equal(rows[0].rental_days, 7); // profile facts carried over
  // Same lead whichever key the next webhook uses
  const byPhone = (await api.get(`/leads/${P}`)).body;
  const byUser = (await api.get(`/leads/${U}`)).body;
  assert.equal(byPhone.id, byUser.id);
  assert.equal(byPhone.recent_messages.length, 3);
  assert.equal((await api.get(`/bookings/${ref}?phone=${P}`)).status, 200);
  // Updates now go to the phone
  await owner(`PAID ${ref} 275`);
  const msg = (await api.get('/outbox/pending')).body.find((o) => o.recipient === 'customer');
  assert.equal(msg.to, P);
});

test('owner sees @username, and can RESUME by username or user ID', async () => {
  await api.post('/messages', { user_id: U, username: 'rohan.plays', direction: 'in', wa_message_id: 'u1', body: 'hi' });
  await api.post(`/leads/${U}/pause`);
  const note = (await api.get('/outbox/pending')).body.find((o) => o.recipient === 'owner');
  assert.match(note.text, /@rohan\.plays/);
  assert.match(note.text, /RESUME @rohan\.plays/);

  let r = (await owner('RESUME @Rohan.Plays')).body;
  assert.ok(r.ok, r.reply);
  assert.equal((await api.get(`/leads/${U}`)).body.bot_paused, false);

  await api.post(`/leads/${U}/pause`);
  r = (await owner(`RESUME ${U}`)).body;
  assert.ok(r.ok, r.reply);
  assert.equal((await api.get(`/leads/${U}`)).body.bot_paused, false);
});

test('a message with neither phone nor user ID is refused', async () => {
  const r = await api.post('/messages', { direction: 'in', body: 'hi' });
  assert.equal(r.status, 400);
});
