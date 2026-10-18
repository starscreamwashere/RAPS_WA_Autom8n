// IST helpers. India has no daylight saving, so a fixed +05:30 offset is exact.
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function istDateTime(date, time) {
  const t = time.length === 5 ? `${time}:00` : time;
  const d = new Date(`${date}T${t}+05:30`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date/time: ${date} ${time}`);
  return d;
}

function istParts(d) {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    date: s.toISOString().slice(0, 10),
    hh: s.getUTCHours(),
    mm: s.getUTCMinutes(),
    dow: s.getUTCDay(),
    day: s.getUTCDate(),
    month: s.getUTCMonth(),
  };
}

const istDate = (d) => istParts(d).date;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / 86400000);
}

const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

// "Sat 25 Oct"
function fmtDate(d) {
  const p = typeof d === 'string' ? istParts(istDateTime(d, '12:00')) : istParts(d);
  return `${DAYS[p.dow]} ${p.day} ${MONTHS[p.month]}`;
}

// "3:30pm"
function fmtTime(d) {
  const { hh, mm } = istParts(d);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${hh < 12 ? 'am' : 'pm'}`;
}

// "15:30"
function hhmm(d) {
  const { hh, mm } = istParts(d);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

module.exports = { istDateTime, istDate, istParts, addDays, daysBetween, addMinutes, fmtDate, fmtTime, hhmm };
