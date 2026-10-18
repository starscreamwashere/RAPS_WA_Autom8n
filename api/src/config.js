const { normalizePhone } = require('./phone');

const config = {
  port: Number(process.env.API_PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  apiKey: process.env.API_KEY,
  ownerPhone: normalizePhone(process.env.OWNER_PHONE || ''),
};

module.exports = config;
