// Deterministic parser for messages from the owner's personal number.
// No AI is involved: one command in, one short reply out.
const { pool, withTx } = require('../db');
const clock = require('../clock');
const { HttpError } = require('../errors');
const { normalizePhone, displayPhone } = require('../phone');
const { istDate, addDays } = require('../time');
const { getSettings, setSetting, EDITABLE } = require('../settings');
const { who } = require('../format');
const bookings = require('./bookings');
const { resolveHandoff } = require('./handoffs');
const { resumeBot, getLeadByPhone } = require('./leads');

const HELP = [
  'Commands:',
  'PAID RP-1042 4500 [upi|cash|bank]',
  'DONE RP-1042 · NOSHOW RP-1042 · CANCEL RP-1042',
  'MOVE RP-1042 · MOVE RP-1042 2026-10-26 16:00 · DECLINE RP-1042',
  'RESUME 98XXXXXXXX (or RESUME RP-1042) · PAUSED',
  'RESOLVE 17 · TODAY · TOMORROW · SCHEDULE 2026-10-26',
  'BIRTHDAYS ON/OFF · SETTINGS · SET travel_buffer_min 60',
].join('\n');

const REF = /^(?:rp-?)?(\d{3,})$/i;
const toRef = (token) => {
  const m = String(token || '').match(REF);
  return m ? `RP-${m[1]}` : null;
};

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

async function didYouMean(ref) {
  const { rows } = await pool.query(
    `SELECT b.ref, l.name, l.phone FROM bookings b JOIN leads l ON l.id = b.lead_id
      WHERE b.reschedule_of IS NULL AND (b.status IN ('held','confirmed') OR b.created_at > $1)`,
    [new Date(clock.now().getTime() - 60 * 86400000)]);
  const sorted = (s) => s.split('').sort().join('');
  const close = rows.find((r) => levenshtein(r.ref, ref) <= 1 || sorted(r.ref) === sorted(ref));
  return close ? ` Did you mean ${close.ref} (${who(close)})?` : '';
}

async function requireRef(token) {
  const ref = toRef(token);
  if (!ref) throw new HttpError(400, 'USAGE', 'Give a booking number like RP-1042.');
  const exists = await pool.query('SELECT 1 FROM bookings WHERE upper(ref) = $1', [ref]);
  if (!exists.rowCount) throw new HttpError(404, 'NOT_FOUND', `No booking ${ref}.${await didYouMean(ref)}`);
  return ref;
}

// "2026-10-26", "26-10-2026", "26/10", "26/10/26"
function parseDate(token) {
  if (!token) return null;
  let m = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return token;
  m = token.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (!m) return null;
  const today = istDate(clock.now());
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
  const iso = (y) => `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if (!m[3] && iso(year) < today) year += 1;
  return iso(year);
}

// "16:00", "4pm", "4:30pm"
function parseTime(token) {
  if (!token) return null;
  const m = token.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || Number(m[2] || 0) > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
}

async function setStatus(ref, status) {
  const b = await bookings.updateBooking(ref, { status });
  return status === 'completed'
    ? `✅ ${b.ref} marked completed. Review request will go out.`
    : `✅ ${b.ref} marked no-show.`;
}

async function run(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const cmd = (tokens[0] || '').toUpperCase();
  const args = tokens.slice(1);

  switch (cmd) {
    case 'PAID': {
      const ref = await requireRef(args[0]);
      const amount = Number(String(args[1] || '').replace(/[₹,]/g, ''));
      if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'USAGE', 'Usage: PAID RP-1042 4500 [upi|cash|bank]');
      const method = (args[2] || '').toLowerCase();
      const r = await bookings.recordPayment(ref, { amount, method: ['upi', 'cash', 'bank'].includes(method) ? method : null });
      return { reply: r.reply, notifications: r.notifications };
    }
    case 'DONE': return { reply: await setStatus(await requireRef(args[0]), 'completed') };
    case 'NOSHOW': case 'NO-SHOW': return { reply: await setStatus(await requireRef(args[0]), 'no_show') };
    case 'CANCEL': {
      const r = await bookings.cancelBooking(await requireRef(args[0]), { by: 'owner' });
      return { reply: `✅ ${r.booking.ref} cancelled. Units are free again. Customer notified.`, notifications: r.notifications };
    }
    case 'MOVE': {
      const ref = await requireRef(args[0]);
      let change = null;
      if (args[1]) {
        const date = parseDate(args[1]);
        if (!date) throw new HttpError(400, 'USAGE', 'Usage: MOVE RP-1042 2026-10-26 16:00');
        change = { date, start_date: date, start_time: parseTime(args[2]) || undefined };
      }
      const r = await bookings.moveBooking(ref, change);
      return { reply: r.reply, notifications: r.notifications };
    }
    case 'DECLINE': {
      const r = await bookings.declineReschedule(await requireRef(args[0]));
      return { reply: r.reply, notifications: r.notifications };
    }
    case 'RESOLVE': {
      const id = Number(String(args[0] || '').replace('#', ''));
      if (!Number.isInteger(id)) throw new HttpError(400, 'USAGE', 'Usage: RESOLVE 17');
      await resolveHandoff(id);
      return { reply: `✅ Handoff #${id} resolved.` };
    }
    case 'RESUME': {
      const target = args[0];
      let phone;
      if (toRef(target) && !/^\d{10,}$/.test(target)) {
        const b = await bookings.loadBooking(pool, await requireRef(target));
        phone = b.phone;
      } else {
        phone = normalizePhone(target);
      }
      if (!phone) throw new HttpError(400, 'USAGE', 'Usage: RESUME 98XXXXXXXX or RESUME RP-1042');
      const lead = await getLeadByPhone(pool, phone);
      if (!lead) throw new HttpError(404, 'NOT_FOUND', `No chat with ${displayPhone(phone)}.`);
      await resumeBot(phone);
      return { reply: `✅ Bot is replying to ${who(lead)} again.` };
    }
    case 'PAUSED': {
      const { rows } = await pool.query('SELECT name, phone FROM leads WHERE bot_paused_at IS NOT NULL ORDER BY bot_paused_at');
      return { reply: rows.length ? `🤫 Paused chats (${rows.length}):\n${rows.map((l) => `• ${who(l)}`).join('\n')}` : '✅ No paused chats.' };
    }
    case 'TODAY': return { reply: (await bookings.schedule(istDate(clock.now()))).text };
    case 'TOMORROW': return { reply: (await bookings.schedule(addDays(istDate(clock.now()), 1))).text };
    case 'SCHEDULE': {
      const date = parseDate(args[0]);
      if (!date) throw new HttpError(400, 'USAGE', 'Usage: SCHEDULE 2026-10-26');
      return { reply: (await bookings.schedule(date)).text };
    }
    case 'BIRTHDAYS': {
      const on = (args[0] || '').toUpperCase();
      if (!['ON', 'OFF'].includes(on)) throw new HttpError(400, 'USAGE', 'Usage: BIRTHDAYS ON or BIRTHDAYS OFF');
      await withTx((c) => setSetting(c, 'birthday_bookings_enabled', on === 'ON'));
      return { reply: on === 'ON'
        ? '✅ Birthday bookings are live: the bot will quote, check availability and hold birthday slots.'
        : '✅ Birthday bookings are off: the bot collects birthday details and hands them to you.' };
    }
    case 'SETTINGS': {
      const s = await getSettings();
      return { reply: Object.keys(EDITABLE).map((k) => `${k}: ${s[k]}`).concat(`birthday_bookings_enabled: ${s.birthday_bookings_enabled}`).join('\n') };
    }
    case 'SET': {
      const key = (args[0] || '').toLowerCase();
      const type = EDITABLE[key];
      if (!type) throw new HttpError(400, 'USAGE', `Can't set "${args[0] || ''}". Send SETTINGS to see what can be changed.`);
      const raw = args.slice(1).join(' ');
      let value = raw;
      if (type === 'int') {
        value = Number(raw);
        if (!Number.isInteger(value) || value < 0) throw new HttpError(400, 'USAGE', `${key} needs a whole number.`);
      } else if (type === 'time') {
        value = parseTime(raw);
        if (!value) throw new HttpError(400, 'USAGE', `${key} needs a time like 09:00.`);
      } else if (!raw) {
        throw new HttpError(400, 'USAGE', `${key} needs a value.`);
      }
      await withTx((c) => setSetting(c, key, value));
      return { reply: `✅ ${key} set to ${value}.` };
    }
    case 'HELP': case '?': case '':
      return { reply: HELP };
    default:
      return { reply: `I didn't understand that.\n${HELP}` };
  }
}

// Any failure becomes a one-line "❌ …" reply instead of an HTTP error,
// because the owner reads it on WhatsApp.
async function runOwnerCommand(text) {
  try {
    const r = await run(text);
    return { ok: true, reply: r.reply, notifications: r.notifications || [] };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, reply: `❌ ${err.message}`, notifications: [] };
    throw err;
  }
}

module.exports = { runOwnerCommand, parseDate, parseTime, toRef };
