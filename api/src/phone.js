// Customers are identified by a "contact key": their phone number, or, when
// WhatsApp hides it (usernames), their business-scoped user ID (BSUID).
//
// Phones are stored the way Meta sends them: digits only, with country code
// (e.g. 919082201911). A bare 10-digit Indian mobile gets the 91 prefix.
// BSUIDs look like 'IN.13491208655302741918' (parent BSUIDs: 'IN.ENT.…').
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9.]{1,160}$/;

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

const isUserId = (key) => BSUID.test(String(key || '').trim());

// A phone number or a BSUID, normalised
function normalizeContact(key) {
  const k = String(key || '').trim();
  return isUserId(k) ? k : normalizePhone(k);
}

// The key to message a lead or booking row by: phone if known, else BSUID
const contactOf = (row) => row.phone || row.user_id;

// "98XXXXXXXX" style for owner-facing text
function displayPhone(phone) {
  if (!phone) return '';
  return phone.startsWith('91') && phone.length === 12 ? phone.slice(2) : phone;
}

// How the owner sees (and can type back) a customer without a name:
// their phone, else @username, else the BSUID
function displayContact(row) {
  if (row.phone) return displayPhone(row.phone);
  if (row.username) return `@${row.username}`;
  return row.user_id || '';
}

module.exports = { normalizePhone, normalizeContact, isUserId, contactOf, displayPhone, displayContact };
