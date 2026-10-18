const { pool } = require('../db');
const clock = require('../clock');
const { notFound } = require('../errors');
const { normalizePhone, displayPhone } = require('../phone');
const { getSettings } = require('../settings');
const { checkArea } = require('./serviceAreas');

// Fields the agent's update_lead_profile tool may write
const PROFILE_FIELDS = [
  'name', 'language', 'intent', 'stage', 'occasion', 'event_date', 'preferred_start', 'venue_type',
  'num_kids', 'num_guests', 'child_age', 'setups_needed', 'decoration_wanted',
  'rental_start_date', 'rental_days', 'controllers_wanted', 'area', 'games_interest', 'notes',
];

async function upsertLead(client, phone, { name } = {}) {
  const { rows } = await client.query(
    `INSERT INTO leads (phone, name, first_seen_at) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET name = coalesce(leads.name, EXCLUDED.name)
     RETURNING *, (xmax = 0) AS inserted`,
    [normalizePhone(phone), name || null, clock.now()],
  );
  return rows[0];
}

async function getLeadByPhone(client, phone) {
  const { rows } = await client.query('SELECT * FROM leads WHERE phone = $1', [normalizePhone(phone)]);
  return rows[0] || null;
}

// What the bot still has to ask before it can quote / book. The order is the
// owner's qualifying order, so the bot asks in that sequence.
function missingFields(lead, settings) {
  const quote = [];
  const booking = [];
  if (lead.intent === 'birthday') {
    if (lead.in_service_area !== true) quote.push('area');
    if (!lead.event_date) quote.push('event_date');
    if (!lead.num_kids && !lead.num_guests && !lead.setups_needed) quote.push('num_kids');
    booking.push(...quote);
    if (!lead.preferred_start) booking.push('preferred_start');
    if (lead.decoration_wanted == null) booking.push('decoration_wanted');
  } else if (lead.intent === 'rental') {
    if (!lead.rental_days) quote.push('rental_days');
    if (!lead.controllers_wanted) quote.push('controllers_wanted');
    booking.push(...quote);
    if (lead.in_service_area !== true) booking.push('area');
    if (!lead.rental_start_date) booking.push('rental_start_date');
  }
  return { missing_for_quote: quote, missing_for_booking: booking, birthday_bookings_enabled: settings.birthday_bookings_enabled };
}

async function leadProfile(phone, client = pool) {
  const lead = await getLeadByPhone(client, phone);
  if (!lead) throw notFound('Lead');
  const settings = await getSettings(client);
  const [{ rows: bookings }, { rows: handoffs }] = await Promise.all([
    client.query(
      `SELECT ref, kind, status, setups, controllers, event_start, event_end, rental_start_date, rental_end_date,
              price_total, advance_due, hold_expires_at, payment_claimed_at
         FROM bookings WHERE lead_id = $1 AND status IN ('held','confirmed') AND reschedule_of IS NULL
        ORDER BY delivery_at`, [lead.id]),
    client.query(`SELECT id, reason, summary, created_at FROM handoffs WHERE lead_id = $1 AND status = 'open'`, [lead.id]),
  ]);
  const { inserted, ...clean } = lead;
  return {
    ...clean,
    bot_paused: lead.bot_paused_at != null,
    ...missingFields(lead, settings),
    active_bookings: bookings,
    open_handoffs: handoffs,
  };
}

async function updateProfile(phone, patch, client = pool) {
  const lead = await getLeadByPhone(client, phone);
  if (!lead) throw notFound('Lead');
  const fields = Object.fromEntries(Object.entries(patch).filter(([k]) => PROFILE_FIELDS.includes(k)));

  // Setting an area runs the service-area check so the profile always knows
  if (fields.area !== undefined) {
    const area = await checkArea(fields.area, client);
    fields.in_service_area = area.in_area;
    fields.service_area_id = area.service_area_id ?? null;
  }
  // A birthday/rental lead that starts giving details is now qualifying
  if (lead.stage === 'new' && !fields.stage && (fields.intent || Object.keys(fields).length)) {
    fields.stage = 'qualifying';
  }
  const keys = Object.keys(fields);
  if (keys.length) {
    await client.query(
      `UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [lead.id, ...keys.map((k) => fields[k])],
    );
  }
  return leadProfile(phone, client);
}

// Owner typed to this customer from the WhatsApp Business app
async function pauseBot(phone, client = pool) {
  const lead = await upsertLead(client, phone);
  const firstPause = lead.bot_paused_at == null;
  if (firstPause) await client.query('UPDATE leads SET bot_paused_at = $2 WHERE id = $1', [lead.id, clock.now()]);
  const label = lead.name ? `${lead.name} (${displayPhone(lead.phone)})` : displayPhone(lead.phone);
  return {
    paused: true,
    first_pause: firstPause,
    notifications: firstPause
      ? [{ to: 'owner', text: `🤫 Bot paused for ${label}. Send RESUME ${displayPhone(lead.phone)} to hand back.` }]
      : [],
  };
}

async function resumeBot(phone, client = pool) {
  const lead = await getLeadByPhone(client, phone);
  if (!lead) throw notFound('Lead');
  await client.query('UPDATE leads SET bot_paused_at = NULL WHERE id = $1', [lead.id]);
  return { paused: false, lead };
}

module.exports = { upsertLead, getLeadByPhone, leadProfile, updateProfile, missingFields, pauseBot, resumeBot, PROFILE_FIELDS };
