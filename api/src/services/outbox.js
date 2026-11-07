const { pool, withTx } = require('../db');
const clock = require('../clock');
const config = require('../config');
const { notFound } = require('../errors');
const { getSettings, setSetting } = require('../settings');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 24 * 3600 * 1000;

// Templates for business-initiated messages (outside the 24h window). Each
// has one body variable holding the flattened text; see docs/META_SETUP.md.
const TEMPLATE = { owner: 'owner_alert', customer: 'customer_update' };

const flatten = (text) => text.replace(/\s*\n+\s*/g, ' · ').trim();

async function enqueue(notifications = [], client = pool) {
  let queued = 0;
  for (const n of notifications) {
    const phone = n.to === 'owner' ? config.ownerPhone : n.phone;
    if (!phone || !n.text) continue;
    await client.query(
      'INSERT INTO outbox (recipient, phone, text, created_at) VALUES ($1, $2, $3, $4)',
      [n.to, phone, n.text, clock.now()]);
    queued++;
  }
  return queued;
}

async function noteOwnerInbound() {
  await withTx((c) => setSetting(c, 'owner_last_inbound_at', clock.now().toISOString()));
}

// What the sender should do with each pending message: plain text inside the
// recipient's 24h service window, otherwise the matching template.
async function pending(limit = 50) {
  const settings = await getSettings();
  const now = clock.now().getTime();
  const { rows } = await pool.query(
    `SELECT o.*, l.last_inbound_at
       FROM outbox o LEFT JOIN leads l ON l.phone = o.phone
      WHERE o.status = 'pending' ORDER BY o.id LIMIT $1`, [limit]);
  return rows.map((o) => {
    const lastInbound = o.recipient === 'owner' ? settings.owner_last_inbound_at : o.last_inbound_at;
    const inWindow = lastInbound != null && now - new Date(lastInbound).getTime() < WINDOW_MS;
    return {
      id: o.id,
      recipient: o.recipient,
      phone: o.phone,
      send_as: inWindow ? 'text' : 'template',
      text: o.text,
      template: inWindow ? null : TEMPLATE[o.recipient],
      variables: inWindow ? null : [flatten(o.text)],
      attempts: o.attempts,
    };
  });
}

async function markSent(id) {
  const { rowCount } = await pool.query(
    `UPDATE outbox SET status = 'sent', sent_at = $2 WHERE id = $1`, [id, clock.now()]);
  if (!rowCount) throw notFound('Outbox message');
  return { ok: true };
}

async function markFailed(id, error) {
  const { rows } = await pool.query(
    `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
            status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
      WHERE id = $1 RETURNING status, attempts`, [id, String(error || '').slice(0, 1000), MAX_ATTEMPTS]);
  if (!rows[0]) throw notFound('Outbox message');
  return rows[0];
}

module.exports = { enqueue, pending, markSent, markFailed, noteOwnerInbound, flatten, TEMPLATE };
