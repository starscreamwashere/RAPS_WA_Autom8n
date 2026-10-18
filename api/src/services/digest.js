// Nightly owner digest. `text` is pre-flattened (no newlines) because a
// WhatsApp template variable cannot contain line breaks.
const { pool, withTx } = require('../db');
const clock = require('../clock');
const { istDate, istDateTime, addDays, fmtDate } = require('../time');
const { rupees, plural, who } = require('../format');
const { daySchedule } = require('./bookings');
const { sweepExpiredHolds } = require('./availability');

async function one(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}
async function many(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function digest(date = istDate(clock.now())) {
  const from = istDateTime(date, '00:00');
  const to = istDateTime(addDays(date, 1), '00:00');
  const range = [from, to];
  // Lapsed holds only flip to "expired" when something sweeps; do it now so
  // the counts below are current even on a quiet day
  await withTx((client) => sweepExpiredHolds(client));

  const leads = await one(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE source = 'ad')::int AS from_ads
       FROM leads WHERE first_seen_at >= $1 AND first_seen_at < $2`, range);
  const byAd = await many(
    `SELECT coalesce(l.ad_ref->>'headline', l.ad_ref->>'source_id', 'ad') AS ad, count(DISTINCT l.id)::int AS leads,
            count(DISTINCT b.id) FILTER (WHERE b.status IN ('confirmed','completed'))::int AS bookings
       FROM leads l LEFT JOIN bookings b ON b.lead_id = l.id
      WHERE l.source = 'ad' AND l.first_seen_at >= $1 AND l.first_seen_at < $2
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, range);
  const created = await one(
    `SELECT count(*)::int AS n FROM bookings WHERE reschedule_of IS NULL AND created_at >= $1 AND created_at < $2`, range);
  const confirmed = await one(
    `SELECT count(DISTINCT booking_id)::int AS n FROM payments WHERE kind = 'advance' AND received_at >= $1 AND received_at < $2`, range);
  const revenue = await one(
    `SELECT coalesce(sum(amount), 0)::int AS n FROM payments WHERE received_at >= $1 AND received_at < $2`, range);
  const expired = await one(
    `SELECT count(*)::int AS n FROM bookings WHERE status = 'expired' AND reschedule_of IS NULL
        AND hold_expires_at >= $1 AND hold_expires_at < $2`, range);
  const noShows = await one(
    `SELECT count(*)::int AS n FROM bookings WHERE status = 'no_show' AND updated_at >= $1 AND updated_at < $2`, range);
  const openHandoffs = await many(
    `SELECT h.id, h.reason, l.name, l.phone FROM handoffs h JOIN leads l ON l.id = h.lead_id
      WHERE h.status = 'open' ORDER BY h.priority = 'urgent' DESC, h.created_at`);
  const paused = await many(`SELECT name, phone FROM leads WHERE bot_paused_at IS NOT NULL`);
  const tomorrow = (await daySchedule(pool, addDays(date, 1))).filter((b) => !b.reschedule_of);

  const parts = [
    `${fmtDate(date)}`,
    `${plural(leads.n, 'new lead')} (${leads.from_ads} from ads)`,
    `${plural(created.n, 'booking')} made, ${confirmed.n} confirmed`,
    `${rupees(revenue.n)} received`,
    `${plural(expired.n, 'hold')} expired unpaid`,
    `${plural(noShows.n, 'no-show')}`,
    `tomorrow: ${plural(tomorrow.length, 'booking')}${tomorrow.length ? ` (${tomorrow.map((b) => b.ref).join(', ')})` : ''}`,
    openHandoffs.length
      ? `needs you: ${openHandoffs.slice(0, 5).map((h) => `#${h.id} ${h.reason.replace(/_/g, ' ')} ${who(h)}`).join(', ')}${openHandoffs.length > 5 ? ` +${openHandoffs.length - 5} more` : ''}`
      : 'nothing waiting on you',
    paused.length ? `bot paused for: ${paused.map(who).join(', ')}` : null,
    byAd.length ? `ads: ${byAd.map((a) => `${a.ad} ${a.leads} leads/${a.bookings} booked`).join(', ')}` : null,
  ].filter(Boolean);

  return {
    date,
    new_leads: leads.n,
    leads_from_ads: leads.from_ads,
    bookings_made: created.n,
    bookings_confirmed: confirmed.n,
    revenue_received: revenue.n,
    holds_expired: expired.n,
    no_shows: noShows.n,
    tomorrow: tomorrow.map((b) => b.ref),
    open_handoffs: openHandoffs,
    paused_chats: paused,
    ads: byAd,
    text: parts.join(' · ').replace(/\n/g, ' · '),
  };
}

module.exports = { digest };
