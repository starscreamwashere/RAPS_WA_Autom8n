// Phones are stored the way Meta sends them: digits only, with country code
// (e.g. 919082201911). A bare 10-digit Indian mobile gets the 91 prefix.
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

// "98XXXXXXXX" style for owner-facing text
function displayPhone(phone) {
  return phone.startsWith('91') && phone.length === 12 ? phone.slice(2) : phone;
}

module.exports = { normalizePhone, displayPhone };
