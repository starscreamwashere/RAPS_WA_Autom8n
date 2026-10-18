// Shared test setup: a real Postgres (TEST_DATABASE_URL), a fresh schema per
// test file, and a pinned clock so dates are predictable.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/raps_test';
process.env.API_KEY = 'test-key';
process.env.OWNER_PHONE = '919321732794';

const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { migrate } = require('../src/migrate');
const clock = require('../src/clock');

const OWNER = '919321732794';
// Monday 2 Nov 2026, 10:00 IST
const NOW = '2026-11-02T10:00:00+05:30';

async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  clock.set(NOW);
}

const app = createApp();
const api = {
  get: (url) => request(app).get(url).set('x-api-key', 'test-key'),
  post: (url, body) => request(app).post(url).set('x-api-key', 'test-key').send(body),
  patch: (url, body) => request(app).patch(url).set('x-api-key', 'test-key').send(body),
  raw: () => request(app),
};

const owner = (text) => api.post('/owner/command', { phone: OWNER, text });

function rental(phone, start_date, extra = {}) {
  return api.post('/bookings', { kind: 'rental', phone, start_date, days: 7, controllers: 1, ...extra });
}

module.exports = { api, owner, rental, resetDb, pool, clock, NOW, OWNER };
