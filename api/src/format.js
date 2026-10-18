const { fmtDate, fmtTime } = require('./time');
const { displayPhone } = require('./phone');

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "Sat 25 Oct, 3:30–6:30pm" or "Sat 25 Oct → Sat 1 Nov"
function bookingWhen(b) {
  if (b.kind === 'birthday') {
    return `${fmtDate(b.event_start)}, ${fmtTime(b.event_start)}–${fmtTime(b.event_end)}`;
  }
  return `${fmtDate(b.rental_start_date)} → ${fmtDate(b.rental_end_date)}`;
}

function bookingWhat(b) {
  return b.kind === 'birthday'
    ? plural(b.setups, 'setup')
    : `${plural(b.setups, 'PS5')} · ${plural(b.controllers, 'controller')}`;
}

function who(lead) {
  return lead.name ? `${lead.name} (${displayPhone(lead.phone)})` : displayPhone(lead.phone);
}

module.exports = { rupees, plural, bookingWhen, bookingWhat, who };
