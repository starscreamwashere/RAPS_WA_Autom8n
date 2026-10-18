// All rupee arithmetic lives here; the AI agent only relays these numbers.
const { pool } = require('../db');
const { getSettings } = require('../settings');
const { HttpError } = require('../errors');
const { daysBetween } = require('../time');

const PACKAGE_BY_DAYS = { 1: 'day', 7: 'week', 30: 'month' };

async function loadCatalog(client = pool) {
  const [settings, rates, rentalRates, units] = await Promise.all([
    getSettings(client),
    client.query('SELECT * FROM rates WHERE active'),
    client.query('SELECT * FROM rental_rates ORDER BY days, controllers'),
    client.query(`SELECT count(*)::int AS n FROM units WHERE status = 'active'`),
  ]);
  return {
    settings,
    rates: Object.fromEntries(rates.rows.map((r) => [r.code, r])),
    rentalRates: rentalRates.rows,
    activeUnits: units.rows[0].n,
  };
}

const pct = (total, p) => Math.round((total * p) / 100);

function birthdayQuote(input, cat) {
  const { settings, rates, activeUnits } = cat;
  const perSetupMax = settings.controllers_per_setup_max;
  const players = input.players ?? null;
  const suggested = players ? Math.ceil(players / perSetupMax) : null;
  const setups = input.setups ?? suggested;
  if (!setups) throw new HttpError(400, 'VALIDATION', 'Give setups or players for a birthday quote');

  const controllers = setups * perSetupMax;
  const reasons = [];
  if (setups > activeUnits) reasons.push(`needs ${setups} consoles; we have ${activeUnits}`);
  if (controllers > settings.controllers_total) {
    reasons.push(`needs ${controllers} controllers; we have ${settings.controllers_total}`);
  }

  const station = rates.birthday_station;
  const lineItems = [{ label: `${station.label} × ${setups}`, amount: station.amount * setups }];
  let total = station.amount * setups;

  let decorationOnRequest = false;
  if (input.decoration) {
    const deco = rates.decoration;
    if (deco?.amount == null) {
      decorationOnRequest = true;
      lineItems.push({ label: 'Decoration', amount: null, note: 'price on request: the team will share it' });
    } else {
      lineItems.push({ label: deco.label, amount: deco.amount });
      total += deco.amount;
    }
  }

  const custom = reasons.length > 0;
  const advancePct = settings.advance_pct_birthday;
  return {
    kind: 'birthday',
    quotable: !custom,
    needs_owner_confirmation: custom || decorationOnRequest,
    reasons: custom ? reasons : decorationOnRequest ? ['decoration price is on request'] : [],
    players,
    suggested_setups: suggested,
    setups,
    controllers,
    hours: settings.birthday_default_hours,
    includes: station.includes,
    line_items: lineItems,
    total: custom ? null : total,
    advance_pct: advancePct,
    advance_due: custom ? null : pct(total, advancePct),
    balance_due: custom ? null : total - pct(total, advancePct),
    balance_when: 'after the setup is installed',
    birthday_bookings_enabled: settings.birthday_bookings_enabled,
  };
}

function rentalQuote(input, cat) {
  const { settings, rentalRates } = cat;
  let days = input.days;
  if (!days && input.start_date && input.end_date) days = daysBetween(input.start_date, input.end_date);
  if (!days || days < 1) throw new HttpError(400, 'VALIDATION', 'Give days, or start_date and end_date');

  const consoles = input.setups ?? 1;
  const controllers = input.controllers ?? consoles;
  if (controllers < consoles || controllers > consoles * settings.controllers_per_setup_max) {
    throw new HttpError(400, 'VALIDATION', `Each PS5 takes 1 to ${settings.controllers_per_setup_max} controllers`);
  }

  const reasons = [];
  const pkg = PACKAGE_BY_DAYS[days];
  if (!pkg) reasons.push(`${days} days is not on the rate card (1 day, 1 week or 1 month)`);
  if (consoles > 1) reasons.push('more than one PS5 on a rental is quoted by the owner');
  if (controllers > settings.controllers_total) reasons.push('more controllers than we own');
  const rate = pkg && rentalRates.find((r) => r.package === pkg && r.controllers === controllers);
  if (pkg && consoles === 1 && !rate) reasons.push('no rate for this controller count');

  const custom = reasons.length > 0;
  const total = custom ? null : rate.amount;
  const advancePct = settings.advance_pct_rental;
  return {
    kind: 'rental',
    quotable: !custom,
    needs_owner_confirmation: custom,
    reasons,
    days,
    package: pkg ?? null,
    setups: consoles,
    controllers,
    includes: ['PS5', `${controllers} controller${controllers > 1 ? 's' : ''}`, 'HDMI + cables + stands',
      'PS Plus Deluxe + EA Play (100+ games)', 'Delivery and pickup'],
    line_items: custom ? [] : [{ label: `PS5 rental, ${pkg}, ${controllers} controller${controllers > 1 ? 's' : ''}`, amount: total }],
    total,
    advance_pct: advancePct,
    advance_due: custom ? null : pct(total, advancePct),
    balance_due: custom ? null : total - pct(total, advancePct),
    balance_when: 'on delivery',
    rate_card: rentalRates.map(({ package: p, controllers: c, amount }) => ({ package: p, controllers: c, amount })),
  };
}

function quote(input, cat) {
  if (input.kind === 'birthday') return birthdayQuote(input, cat);
  if (input.kind === 'rental') return rentalQuote(input, cat);
  throw new HttpError(400, 'VALIDATION', 'kind must be birthday or rental');
}

module.exports = { loadCatalog, quote, PACKAGE_BY_DAYS };
