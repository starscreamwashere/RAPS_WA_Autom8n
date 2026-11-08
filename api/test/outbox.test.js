const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, owner, rental, resetDb, pool, clock, OWNER } = require('./helpers');

beforeEach(resetDb);
after(() => pool.end());

const P = '919800000001';

test('alerts from AI tool calls are queued, not lost', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'we want you at our event', name: 'Event Team' });
  await api.post('/handoffs', { phone: P, reason: 'sponsorship', summary: 'Diwali mela, wants 2 free stations' });
  const items = (await api.get('/outbox/pending')).body;
  assert.equal(items.length, 1);
  assert.equal(items[0].recipient, 'owner');
  assert.equal(items[0].phone, OWNER);
  assert.match(items[0].text, /sponsorship · Event Team/);
});

test('owner messages are free text inside his 24h window, a template outside it', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi' });
  await api.post(`/leads/${P}/pause`); // queues an owner alert
  let [item] = (await api.get('/outbox/pending')).body;
  assert.equal(item.send_as, 'template'); // owner has never messaged the bot
  assert.equal(item.template, 'owner_alert');
  assert.ok(!/\n/.test(item.variables[0]));

  await owner('PAUSED'); // the owner writes in: window opens
  [item] = (await api.get('/outbox/pending')).body;
  assert.equal(item.send_as, 'text');

  clock.set('2026-11-03T10:30:00+05:30'); // 24h30m later
  [item] = (await api.get('/outbox/pending')).body;
  assert.equal(item.send_as, 'template');
});

test('customer updates use the customer\'s own window', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi', name: 'Rohan' });
  const ref = (await rental(P, '2026-11-10')).body.booking.ref;
  const r = (await owner(`PAID ${ref} 275`)).body;
  assert.equal(r.notifications.length, 1);
  const item = (await api.get('/outbox/pending')).body.find((i) => i.recipient === 'customer');
  assert.equal(item.phone, P);
  assert.equal(item.send_as, 'text');
  assert.match(item.text, /advance of ₹275 is received/);

  clock.set('2026-11-04T10:00:00+05:30');
  const later = (await api.get('/outbox/pending')).body.find((i) => i.recipient === 'customer');
  assert.equal(later.template, 'customer_update');
});

test('sent messages leave the queue; failures retry up to 5 times', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi' });
  await api.post('/handoffs', { phone: P, reason: 'complaint', summary: 'TV not turning on' });
  await api.post('/handoffs', { phone: P, reason: 'complaint', summary: 'Controller broken' });
  const [a, b] = (await api.get('/outbox/pending')).body;
  await api.post(`/outbox/${a.id}/sent`);
  for (let i = 1; i <= 4; i++) {
    assert.equal((await api.post(`/outbox/${b.id}/failed`, { error: 'timeout' })).body.status, 'pending');
  }
  assert.equal((await api.post(`/outbox/${b.id}/failed`, { error: 'timeout' })).body.status, 'failed');
  assert.equal((await api.get('/outbox/pending')).body.length, 0);
});

test('the rental ID form link is in the rates', async () => {
  assert.match((await api.get('/rates')).body.rental.id_form_url, /^https:\/\/docs\.google\.com\/forms\//);
});

test('scheduled runs queue reminders, reviews and the digest exactly once', async () => {
  await api.post('/messages', { phone: P, direction: 'in', body: 'hi', name: 'Rohan Mehta' });
  const ref = (await rental(P, '2026-11-03', { days: 1 })).body.booking.ref;
  clock.set('2026-11-02T11:35:00+05:30');
  const [a, b] = await Promise.all([api.post('/jobs/reminders/run'), api.post('/jobs/reminders/run')]);
  assert.equal(a.body.queued + b.body.queued, 1); // overlapping runs: one nudge only
  let items = (await api.get('/outbox/pending')).body;
  assert.equal(items.length, 1);
  assert.match(items[0].text, /held until 12pm/);

  await owner(`PAID ${ref} 95`);
  await owner(`DONE ${ref}`);
  clock.set('2026-11-02T22:00:00+05:30'); // 10pm: no review asks at night
  assert.equal((await api.post('/jobs/reviews/run')).body.queued, 0);
  clock.set('2026-11-03T10:30:00+05:30');
  assert.equal((await api.post('/jobs/reviews/run')).body.queued, 1);
  assert.equal((await api.post('/jobs/reviews/run')).body.queued, 0);

  const d = (await api.post('/reports/digest/send')).body;
  assert.equal(d.queued, 1);
  items = (await api.get('/outbox/pending')).body;
  assert.ok(items.some((i) => i.recipient === 'owner' && /Daily summary/.test(i.text)));
});

test('the profile carries recent conversation, oldest first, without the message being answered', async () => {
  await api.post('/messages', { phone: P, direction: 'in', wa_message_id: 'w1', body: 'Need a PS5 for a week' });
  await api.post('/messages', { phone: P, direction: 'out', body: 'Sure! How many controllers?' });
  await api.post('/messages', { phone: P, direction: 'out', kind: 'owner_app', body: 'Hi, owner here 👋' });
  await api.post('/messages', { phone: P, direction: 'in', wa_message_id: 'w2', body: '2 controllers' });
  const p = (await api.get(`/leads/${P}?current=w2`)).body;
  assert.deepEqual(p.recent_messages.map((m) => [m.from, m.text]), [
    ['customer', 'Need a PS5 for a week'],
    ['assistant', 'Sure! How many controllers?'],
    ['team', 'Hi, owner here 👋'],
  ]);
  // Without ?current, nothing is left out, including the bot's own replies
  // (they have no WhatsApp message id)
  const all = (await api.get(`/leads/${P}`)).body;
  assert.deepEqual(all.recent_messages.map((m) => m.from), ['customer', 'assistant', 'team', 'customer']);
});
