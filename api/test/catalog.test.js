const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, resetDb, pool } = require('./helpers');

before(resetDb);
after(() => pool.end());

test('health needs no key; everything else does', async () => {
  assert.equal((await api.raw().get('/health')).status, 200);
  const r = await api.raw().get('/rates');
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'UNAUTHORIZED');
  assert.equal((await api.raw().get('/rates').set('x-api-key', 'wrong-key')).status, 401);
});

test('rental quotes come straight from the rate card', async () => {
  const week2 = (await api.post('/quotes', { kind: 'rental', days: 7, controllers: 2 })).body;
  assert.equal(week2.total, 2999);
  assert.equal(week2.advance_due, 300);
  assert.equal(week2.balance_due, 2699);
  assert.equal(week2.balance_when, 'on delivery');

  assert.equal((await api.post('/quotes', { kind: 'rental', days: 1, controllers: 4 })).body.total, 1600);
  assert.equal((await api.post('/quotes', { kind: 'rental', days: 1, controllers: 1 })).body.total, 950);
  assert.equal((await api.post('/quotes', { kind: 'rental', days: 30, controllers: 3 })).body.total, 9000);
  const byDates = (await api.post('/quotes', { kind: 'rental', start_date: '2026-11-10', end_date: '2026-11-17', controllers: 3 })).body;
  assert.equal(byDates.total, 3399);
});

test('durations off the rate card go to the owner', async () => {
  const q = (await api.post('/quotes', { kind: 'rental', days: 3, controllers: 1 })).body;
  assert.equal(q.quotable, false);
  assert.equal(q.needs_owner_confirmation, true);
  assert.equal(q.total, null);
  const two = (await api.post('/quotes', { kind: 'rental', days: 7, setups: 2, controllers: 2 })).body;
  assert.equal(two.quotable, false);
  assert.equal((await api.post('/quotes', { kind: 'rental', days: 7, controllers: 5 })).status, 400);
});

test('birthday quote suggests ceil(players / 4) setups at ₹9,000 each with 50% advance', async () => {
  const q = (await api.post('/quotes', { kind: 'birthday', players: 10 })).body;
  assert.equal(q.suggested_setups, 3);
  assert.equal(q.controllers, 12);
  assert.equal(q.total, 27000);
  assert.equal(q.advance_due, 13500);
  assert.equal(q.balance_when, 'after the setup is installed');
  assert.equal((await api.post('/quotes', { kind: 'birthday', players: 4 })).body.setups, 1);
});

test('a party bigger than the inventory becomes a custom quote', async () => {
  const q = (await api.post('/quotes', { kind: 'birthday', players: 30 })).body; // 8 setups > 6 consoles
  assert.equal(q.quotable, false);
  assert.equal(q.total, null);
  assert.match(q.reasons.join(' '), /consoles/);
  const c = (await api.post('/quotes', { kind: 'birthday', setups: 6 })).body; // 24 controllers > 20
  assert.equal(c.quotable, false);
  assert.match(c.reasons.join(' '), /controllers/);
});

test('decoration is price on request', async () => {
  const q = (await api.post('/quotes', { kind: 'birthday', setups: 1, decoration: true })).body;
  assert.equal(q.total, 9000);
  assert.equal(q.needs_owner_confirmation, true);
  assert.equal(q.line_items[1].amount, null);
});

test('service area check', async () => {
  const check = async (q) => (await api.get(`/service-areas/check?q=${encodeURIComponent(q)}`)).body;
  assert.equal((await check('Andheri West')).in_area, true);
  assert.equal((await check('andheri w')).region, 'Mumbai');
  assert.equal((await check('Flat 4, Vikhroli East near station')).locality, 'Vikhroli');
  assert.equal((await check('Kharghar sector 12')).region, 'Navi Mumbai');
  assert.equal((await check('Ghodbunder road')).region, 'Thane West');
  assert.equal((await check('vasai west')).region, 'Vasai');
  assert.equal((await check('400053')).in_area, true);
  assert.equal((await check('Thane East')).in_area, false);
  assert.equal((await check('Pune')).in_area, false);
  assert.equal((await check('110001')).in_area, false);
  assert.equal((await check('Kalyan')).in_area, null);
  assert.equal((await check('Thane')).in_area, null);
});

test('rates endpoint exposes terms the bot must repeat', async () => {
  const r = (await api.get('/rates')).body;
  assert.equal(r.birthday.amount, 9000);
  assert.equal(r.birthday.bookings_open, false);
  assert.equal(r.rental.rate_card.length, 12);
  assert.equal(r.rental.advance_pct, 10);
  assert.equal(r.security_deposit, 'none');
});
