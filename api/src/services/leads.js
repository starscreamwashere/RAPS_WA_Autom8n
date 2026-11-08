const { pool } = require('../db');
const clock = require('../clock');
const { notFound, HttpError } = require('../errors');
const { normalizePhone, normalizeContact, isUserId, displayContact } = require('../phone');
const { getSettings } = require('../settings');
const { checkArea } = require('./serviceAreas');

// Fields the agent's update_lead_profile tool may write
const PROFILE_FIELDS = [
  'name', 'language', 'intent', 'stage', 'occasion', 'event_date', 'preferred_start', 'venue_type',
  'num_kids', 'num_guests', 'child_age', 'setups_needed', 'decoration_wanted',
  'rental_start_date', 'rental_days', 'controllers_wanted', 'area', 'games_interest', 'notes',
];

// Finds or creates the lead for a contact key (phone or BSUID). When a webhook
// carries both the phone and the BSUID, they are stored together, and a lead
// that was first known only by its BSUID is merged into the phone's lead.
async function upsertLead(client, key, { name, phone, user_id: userId, username } = {}) {
  const k = normalizeContact(key);
  const p = phone ? normalizePhone(phone) : (k && !isUserId(k) ? k : null);
  const u = userId || (isUserId(k) ? k : null);
  if (!p && !u) throw new HttpError(400, 'NO_CONTACT', 'A phone number or WhatsApp user ID is needed');

  let byPhone = p ? (await client.query('SELECT * FROM leads WHERE phone = $1 FOR UPDATE', [p])).rows[0] : null;
  const byUser = u ? (await client.query('SELECT * FROM leads WHERE user_id = $1 FOR UPDATE', [u])).rows[0] : null;
  if (byPhone && byUser && byPhone.id !== byUser.id) byPhone = await mergeLeads(client, byPhone, byUser);
  const found = byPhone || byUser;

  if (!found) {
    const { rows } = await client.query(
      `INSERT INTO leads (phone, user_id, username, name, first_seen_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING *, true AS inserted`,
      [p, u, username || null, name || null, clock.now()]);
    if (rows[0]) return rows[0];
    return upsertLead(client, key, { name, phone, user_id: userId, username }); // lost a race: read it again
  }
  // The phone is the stable identity: a BSUID changes when the user changes number
  const { rows } = await client.query(
    `UPDATE leads SET phone = coalesce(phone, $2),
                      user_id = coalesce($3, user_id),
                      username = coalesce($4, username),
                      name = coalesce(name, $5)
      WHERE id = $1 RETURNING *, false AS inserted`,
    [found.id, p, u, username || null, name || null]);
  return rows[0];
}

// Moves everything from the BSUID-only lead into the phone lead, then removes it
async function mergeLeads(client, keep, drop) {
  for (const table of ['messages', 'bookings', 'handoffs']) {
    await client.query(`UPDATE ${table} SET lead_id = $1 WHERE lead_id = $2`, [keep.id, drop.id]);
  }
  const fill = PROFILE_FIELDS.filter((f) => keep[f] == null && drop[f] != null);
  await client.query('DELETE FROM leads WHERE id = $1', [drop.id]);
  const sets = [
    ...fill.map((f, i) => `${f} = $${i + 2}`),
    `username = coalesce(username, $${fill.length + 2})`,
    `last_inbound_at = greatest(last_inbound_at, $${fill.length + 3})`,
    `first_seen_at = least(first_seen_at, $${fill.length + 4})`,
    `bot_paused_at = coalesce(bot_paused_at, $${fill.length + 5})`,
    `opted_out = opted_out OR $${fill.length + 6}`,
  ];
  const { rows } = await client.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [keep.id, ...fill.map((f) => drop[f]), drop.username, drop.last_inbound_at, drop.first_seen_at,
      drop.bot_paused_at, drop.opted_out]);
  return rows[0];
}

async function getLeadByContact(client, key) {
  const k = normalizeContact(key);
  if (!k) return null;
  const { rows } = await client.query(`SELECT * FROM leads WHERE ${isUserId(k) ? 'user_id' : 'phone'} = $1`, [k]);
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

// Conversation memory comes from the message log, so the bot also sees what
// the owner typed to the customer from the WhatsApp Business app.
const HISTORY = 30;

async function leadProfile(phone, client = pool, { currentMessageId } = {}) {
  const lead = await getLeadByContact(client, phone);
  if (!lead) throw notFound('Lead');
  const settings = await getSettings(client);
  const [{ rows: bookings }, { rows: handoffs }, { rows: history }] = await Promise.all([
    client.query(
      `SELECT ref, kind, status, setups, controllers, event_start, event_end, rental_start_date, rental_end_date,
              price_total, advance_due, hold_expires_at, payment_claimed_at
         FROM bookings WHERE lead_id = $1 AND status IN ('held','confirmed') AND reschedule_of IS NULL
        ORDER BY delivery_at`, [lead.id]),
    client.query(`SELECT id, reason, summary, created_at FROM handoffs WHERE lead_id = $1 AND status = 'open'`, [lead.id]),
    client.query(
      `SELECT direction, kind, body, created_at FROM messages
        WHERE lead_id = $1 AND body IS NOT NULL AND ($2::text IS NULL OR wa_message_id IS DISTINCT FROM $2)
        ORDER BY created_at DESC, id DESC LIMIT $3`, [lead.id, currentMessageId || null, HISTORY]),
  ]);
  const { inserted, ...clean } = lead;
  return {
    ...clean,
    bot_paused: lead.bot_paused_at != null,
    ...missingFields(lead, settings),
    active_bookings: bookings,
    open_handoffs: handoffs,
    // Oldest first; `team` = the owner typing from the Business app
    recent_messages: history.reverse().map((m) => ({
      from: m.direction === 'in' ? 'customer' : m.kind === 'owner_app' ? 'team' : 'assistant',
      at: m.created_at,
      text: m.body,
    })),
  };
}

async function updateProfile(phone, patch, client = pool) {
  const lead = await getLeadByContact(client, phone);
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
  const label = lead.name ? `${lead.name} (${displayContact(lead)})` : displayContact(lead);
  return {
    paused: true,
    first_pause: firstPause,
    notifications: firstPause
      ? [{ to: 'owner', text: `🤫 Bot paused for ${label}. Send RESUME ${displayContact(lead)} to hand back.` }]
      : [],
  };
}

async function resumeBot(phone, client = pool) {
  const lead = await getLeadByContact(client, phone);
  if (!lead) throw notFound('Lead');
  await client.query('UPDATE leads SET bot_paused_at = NULL WHERE id = $1', [lead.id]);
  return { paused: false, lead };
}

module.exports = { upsertLead, getLeadByContact, getLeadByPhone: getLeadByContact, leadProfile, updateProfile, missingFields, pauseBot, resumeBot, PROFILE_FIELDS };
