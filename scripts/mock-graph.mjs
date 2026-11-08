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

import http from 'node:http';

const PORT = Number(process.env.MOCK_GRAPH_PORT) || 4010;
let sent = [];
let failNext = 0;
let seq = 0;

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
    console.log(`→ ${body.to} [${body.type}] ${body.text?.body ?? body.template?.name ?? ''}`.slice(0, 200));
    seq += 1;
    return reply(res, 200, {
      messaging_product: 'whatsapp',
      contacts: [{ input: body.to, wa_id: body.to }],
      messages: [{ id: `wamid.mock.${seq}` }],
    });
  }
  reply(res, 404, { error: { message: `mock: no route for ${req.method} ${req.url}` } });
}).listen(PORT, () => console.log(`mock Graph API on :${PORT}`));
