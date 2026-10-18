const { pool } = require('../db');

// Clearly elsewhere: answer "not in our area" instead of "unknown"
const OUTSIDE = ['pune', 'nashik', 'lonavala', 'delhi', 'bangalore', 'bengaluru', 'hyderabad',
  'chennai', 'kolkata', 'surat', 'ahmedabad', 'goa', 'nagpur', 'jaipur', 'indore'];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(w)\b/g, 'west')
    .replace(/\b(e)\b/g, 'east')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns in_area: true (we serve it), false (clearly outside), or null
// (unknown locality: the bot says it will confirm and hands it to the owner).
async function checkArea(query, client = pool) {
  const q = normalize(query);
  if (!q) return { in_area: null, query, matched_on: null };

  const pin = q.match(/\b(\d{6})\b/);
  if (pin) {
    const { rows } = await client.query(
      'SELECT region FROM service_pincode_ranges WHERE pin_range @> $1::int LIMIT 1', [Number(pin[1])]);
    if (rows[0]) return { in_area: true, region: rows[0].region, locality: null, matched_on: 'pincode', query };
    if (!/^4[0-2]/.test(pin[1])) return { in_area: false, region: null, matched_on: 'pincode', query };
  }

  const { rows: areas } = await client.query(
    'SELECT id, region, locality, aliases FROM service_areas WHERE active');
  const names = (a) => [normalize(a.locality), ...a.aliases.map(normalize)];
  // Exact first, then "the message mentions this locality", longest name first
  const exact = areas.find((a) => names(a).includes(q));
  const contained = exact || areas
    .flatMap((a) => names(a).map((n) => ({ a, n })))
    .filter(({ n }) => new RegExp(`\\b${n}\\b`).test(q))
    .sort((x, y) => y.n.length - x.n.length)[0]?.a;
  const hit = exact || contained;
  if (hit) {
    // "Thane" alone could be East (not served); only Thane West localities count
    if (hit.region === 'Thane West' && /\bthane east\b/.test(q)) {
      return { in_area: false, region: null, matched_on: 'locality', query };
    }
    return { in_area: true, region: hit.region, locality: hit.locality, service_area_id: hit.id,
      matched_on: exact ? 'locality' : 'mention', query };
  }

  if (/\bthane east\b/.test(q) || OUTSIDE.some((c) => new RegExp(`\\b${c}\\b`).test(q))) {
    return { in_area: false, region: null, matched_on: 'known_outside', query };
  }
  return { in_area: null, region: null, matched_on: null, query };
}

module.exports = { checkArea, normalize };
