#!/usr/bin/env node
// A stand-in for Meta's Graph API, for testing the n8n workflows without
// WhatsApp. Point n8n at it with GRAPH_API_BASE=http://localhost:4010/v27.0.
//
//   node scripts/mock-graph.mjs            # listens on MOCK_GRAPH_PORT or 4010
//
// POST /<version>/<phone_number_id>/messages  → records the message, answers like Meta
// GET  /__sent                                 → everything recorded so far
// POST /__fail  {"count":2}                    → the next N sends get HTTP 500
// DELETE /__sent                               → clear the record
// GET  /<version>/<phone_number_id>?fields=…   → health check answer (CLOUD_API)
// POST /__health {"platform_type":"…"} or {"error":{…},"status":401} → change that answer
// POST /__push                                 → stands in for ALERT_PUSH_URL; GET /__push lists them

import http from 'node:http';

const PORT = Number(process.env.MOCK_GRAPH_PORT) || 4010;
let sent = [];
let failNext = 0;
let seq = 0;
let health = { status: 200, body: { platform_type: 'CLOUD_API', is_on_biz_app: true, status: 'CONNECTED', quality_rating: 'GREEN' } };
let pushes = [];

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
});

const reply = (res, status, json) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
};

http.createServer(async (req, res) => {
  const raw = await readBody(req);
  if (req.url === '/__sent' && req.method === 'GET') return reply(res, 200, sent);
  if (req.url === '/__sent' && req.method === 'DELETE') { sent = []; return reply(res, 200, { ok: true }); }
  if (req.url === '/__fail' && req.method === 'POST') { failNext = JSON.parse(raw || '{}').count ?? 1; return reply(res, 200, { ok: true }); }

  if (req.url === '/__push' && req.method === 'POST') {
    pushes.push({ at: new Date().toISOString(), title: req.headers.title || null, text: raw });
    console.log(`📣 push: ${raw.slice(0, 160)}`);
    return reply(res, 200, { ok: true });
  }
  if (req.url === '/__push' && req.method === 'GET') return reply(res, 200, pushes);
  if (req.url === '/__health' && req.method === 'POST') {
    const want = JSON.parse(raw || '{}');
    health = want.error
      ? { status: want.status || 400, body: { error: want.error } }
      : { status: 200, body: { ...health.body, ...want } };
    return reply(res, 200, { ok: true, health });
  }
  const h = req.url.match(/^\/v[\d.]+\/([^/?]+)(\?.*)?$/);
  if (h && req.method === 'GET') return reply(res, health.status, { ...health.body, ...(health.status === 200 ? { id: h[1] } : {}) });

  const m = req.url.match(/^\/v[\d.]+\/([^/]+)\/messages$/);
  if (m && req.method === 'POST') {
    let body;
    try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: { message: 'bad JSON', code: 100 } }); }
    const entry = { at: new Date().toISOString(), phone_number_id: m[1], auth: req.headers.authorization || null, body };
    if (failNext > 0) {
      failNext -= 1;
      sent.push({ ...entry, failed: true });
      return reply(res, 500, { error: { message: 'mock failure', code: 1 } });
    }
    sent.push(entry);
    console.log(`→ ${body.to ?? body.recipient} [${body.type}] ${body.text?.body ?? body.template?.name ?? ''}`.slice(0, 200));
    seq += 1;
    return reply(res, 200, {
      messaging_product: 'whatsapp',
      contacts: [body.to ? { input: body.to, wa_id: body.to } : { user_id: body.recipient }],
      messages: [{ id: `wamid.mock.${seq}` }],
    });
  }
  reply(res, 404, { error: { message: `mock: no route for ${req.method} ${req.url}` } });
}).listen(PORT, () => console.log(`mock Graph API on :${PORT}`));
