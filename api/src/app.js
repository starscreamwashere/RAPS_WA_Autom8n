const crypto = require('node:crypto');
const express = require('express');
const { ZodError } = require('zod');
const config = require('./config');
const { HttpError } = require('./errors');
const routes = require('./routes');

function requireApiKey(req, res, next) {
  const given = Buffer.from(req.get('x-api-key') || '');
  const expected = Buffer.from(config.apiKey || '');
  if (!expected.length || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid x-api-key' } });
  }
  next();
}

// Express 5 forwards rejected promises from async handlers here
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid request', details: err.issues } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof RangeError) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: err.message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Body is not valid JSON' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (req, res) => res.json({ ok: true, service: 'raps-powerplay-api' }));
  app.use(requireApiKey);
  app.use(routes);
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route' } }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
