const { pool } = require('../db');
const clock = require('../clock');
const { notFound } = require('../errors');
const { upsertLead } = require('./leads');
const { who } = require('../format');

const ICONS = {
  sponsorship: '🤝', human_requested: '🙋', complaint: '⚠️', custom_quote: '🧮', out_of_area: '📍',
  unknown_area: '📍', cancellation_paid: '⚠️', reschedule: '🔁', payment_claim: '💸', damage: '🛠', other: '📌',
};

// Owner is pinged right away for these; everything else waits for the digest
const IMMEDIATE = new Set(['sponsorship', 'cancellation_paid', 'reschedule', 'payment_claim', 'complaint', 'human_requested', 'custom_quote']);

async function createHandoff(client, { lead, reason, priority = 'normal', summary, details, bookingId, pauseBot }) {
  const { rows } = await client.query(
    `INSERT INTO handoffs (lead_id, booking_id, reason, priority, summary, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [lead.id, bookingId || null, reason, priority, summary, details || null, clock.now()],
  );
  await client.query(
    `UPDATE leads SET needs_human = true, bot_paused_at = CASE WHEN $2 THEN coalesce(bot_paused_at, $3) ELSE bot_paused_at END
      WHERE id = $1`, [lead.id, Boolean(pauseBot), clock.now()]);
  const h = rows[0];
  const notify = priority === 'urgent' || IMMEDIATE.has(reason);
  return {
    handoff: h,
    notifications: notify
      ? [{ to: 'owner', text: `${ICONS[reason] || '📌'} #${h.id} ${reason.replace(/_/g, ' ')} · ${who(lead)}\n${summary}\nReply RESOLVE ${h.id} when done.` }]
      : [],
  };
}

async function flagForHuman(input, client = pool) {
  const lead = await upsertLead(client, input.phone);
  let bookingId = null;
  if (input.booking_ref) {
    const b = await client.query('SELECT id FROM bookings WHERE ref = $1 AND lead_id = $2', [input.booking_ref, lead.id]);
    bookingId = b.rows[0]?.id ?? null;
  }
  return createHandoff(client, {
    lead, reason: input.reason, priority: input.priority, summary: input.summary,
    details: input.details, bookingId, pauseBot: input.pause_bot,
  });
}

async function resolveHandoffs(client, where, params) {
  await client.query(`UPDATE handoffs SET status = 'resolved', resolved_at = $1 WHERE status = 'open' AND ${where}`,
    [clock.now(), ...params]);
}

async function resolveHandoff(id, client = pool) {
  const { rows } = await client.query(
    `UPDATE handoffs SET status = 'resolved', resolved_at = $2 WHERE id = $1 RETURNING *`, [id, clock.now()]);
  if (!rows[0]) throw notFound('Handoff');
  // needs_human clears once the lead has no other open handoffs
  await client.query(
    `UPDATE leads SET needs_human = EXISTS (SELECT 1 FROM handoffs WHERE lead_id = $1 AND status = 'open') WHERE id = $1`,
    [rows[0].lead_id]);
  return rows[0];
}

async function listHandoffs(status = 'open', client = pool) {
  const { rows } = await client.query(
    `SELECT h.*, l.phone, l.name FROM handoffs h JOIN leads l ON l.id = h.lead_id
      WHERE h.status = $1 ORDER BY h.created_at`, [status]);
  return rows;
}

module.exports = { createHandoff, flagForHuman, resolveHandoff, resolveHandoffs, listHandoffs };
