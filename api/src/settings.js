const { pool } = require('./db');

// Settings the owner may change with the SET command, and their types
const EDITABLE = {
  hold_minutes: 'int',
  hold_nudge_before_min: 'int',
  setup_buffer_min: 'int',
  teardown_buffer_min: 'int',
  travel_buffer_min: 'int',
  birthday_default_hours: 'int',
  controllers_total: 'int',
  reminder_hours_before: 'int',
  business_open: 'time',
  business_close: 'time',
  payment_upi_id: 'text',
};

async function getSettings(client = pool) {
  const { rows } = await client.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function setSetting(client, key, value) {
  await client.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

module.exports = { getSettings, setSetting, EDITABLE };
