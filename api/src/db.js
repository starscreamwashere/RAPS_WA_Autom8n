const { Pool, types } = require('pg');
const config = require('./config');

// DATE columns stay 'YYYY-MM-DD' strings; parsing them into JS Dates would
// shift them by the server's timezone.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

const EXCLUSION_VIOLATION = '23P01';
const SERIALIZATION_FAILURE = '40001';

// Every booking write takes this lock first. Controller stock is a pooled
// count that an EXCLUDE constraint cannot enforce, so writes that change it
// are serialised; per-unit overlap is still guaranteed by the constraint.
const BOOKING_LOCK_KEY = 7270001;

async function withTx(fn, { retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const retryable = err.code === EXCLUSION_VIOLATION || err.code === SERIALIZATION_FAILURE;
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

async function lockBookings(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [BOOKING_LOCK_KEY]);
}

module.exports = { pool, withTx, lockBookings, EXCLUSION_VIOLATION };
