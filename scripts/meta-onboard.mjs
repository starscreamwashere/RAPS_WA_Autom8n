#!/usr/bin/env node
// One-time onboarding of the business number to the WhatsApp Cloud API while
// it stays on the WhatsApp Business app ("coexistence"). See docs/META_SETUP.md
// (phase 5). Serves Meta's Embedded Signup button, and the moment the owner
// finishes the flow it does the server-side steps Meta requires:
//
//   1. exchange the 30-second code for a business token
//   2. subscribe our app to webhooks on the Messaging account (WABA)
//   3. check the number is on both the Business app and Cloud API
//   4. start the contacts + chat-history sync (must happen within 24 hours)
//
// Usage (the page must be reached over HTTPS on a domain listed in the app's
// Facebook Login for Business allowed domains, e.g. through a tunnel):
//
//   META_APP_ID=... META_APP_SECRET=... META_CONFIG_ID=... node scripts/meta-onboard.mjs
//   cloudflared tunnel --url http://localhost:8090      # in another terminal
//
// The result (IDs and the business token) is written to meta-onboarding.json,
// which is git-ignored. Treat it like a password.

import fs from 'node:fs';
import http from 'node:http';

const { META_APP_ID, META_APP_SECRET, META_CONFIG_ID } = process.env;
const GRAPH = (process.env.GRAPH_API_BASE || 'https://graph.facebook.com/v27.0').replace(/\/$/, '');
const VERSION = GRAPH.match(/v[\d.]+$/)?.[0] || 'v27.0';
const PORT = Number(process.env.ONBOARD_PORT) || 8090;
const OUT = process.env.ONBOARD_OUT || 'meta-onboarding.json';

for (const [k, v] of Object.entries({ META_APP_ID, META_APP_SECRET, META_CONFIG_ID })) {
  if (!v) { console.error(`${k} is not set (see docs/META_SETUP.md)`); process.exit(2); }
}

async function graph(method, path, { token, body, query } = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${json.error?.message || res.status} (code ${json.error?.code ?? '-'})`);
  return json;
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RAPS Powerplay · connect WhatsApp</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5}
button{background:#1877f2;border:0;border-radius:6px;color:#fff;font-size:16px;font-weight:600;padding:12px 24px;cursor:pointer}
pre{background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap}</style></head>
<body>
<h1>Connect the RAPS WhatsApp number</h1>
<ol>
<li>Keep the WhatsApp Business app open on the business phone.</li>
<li>Click the button, log in with the Facebook account that manages RAPS Powerplay.</li>
<li>Choose <b>connect your existing WhatsApp Business app</b>, enter the business number,
and follow the prompts on the phone (Connect → Confirm, share chat history).</li>
<li>Click <b>Finish</b> at the end (do not just close the window).</li>
</ol>
<button onclick="launch()">Connect with Facebook</button>
<pre id="log">Waiting…</pre>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
<script>
const log = (m) => { document.getElementById('log').textContent += '\\n' + m; };
const post = (path, data) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  .then((r) => r.json()).then((j) => log(JSON.stringify(j, null, 2))).catch((e) => log('error: ' + e));
window.fbAsyncInit = () => FB.init({ appId: ${JSON.stringify(META_APP_ID)}, autoLogAppEvents: true, xfbml: true, version: ${JSON.stringify(VERSION)} });
window.addEventListener('message', (event) => {
  if (!event.origin.endsWith('facebook.com')) return;
  try {
    const data = JSON.parse(event.data);
    if (data.type === 'WA_EMBEDDED_SIGNUP') { log('session: ' + data.event); post('/session', data); }
  } catch { /* other messages from the SDK */ }
});
// The code lives 30 seconds: send it to the server at once
const done = (response) => {
  if (response.authResponse?.code) { log('got code, finishing on the server…'); post('/code', { code: response.authResponse.code }); }
  else log('no code returned: ' + JSON.stringify(response));
};
function launch() {
  FB.login(done, { config_id: ${JSON.stringify(META_CONFIG_ID)}, response_type: 'code', override_default_response_type: true,
    extras: { version: 'v5' } }); // v5: WhatsApp Business app onboarding is on by default
}
</script></body></html>`;

let session = null;   // from the session-logging event (IDs)
let token = null;     // business token from the code exchange
let finished = false;

function save(extra = {}) {
  const data = { at: new Date().toISOString(), graph: GRAPH, session, business_token: token, ...extra };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function finish() {
  if (finished || !session || !token) return null;
  finished = true;
  const d = session.data || {};
  const wabaId = d.waba_id || d.messaging_account_ids?.[0];
  const phoneId = d.phone_number_id;
  const steps = {};
  console.log(`\nIDs: WABA ${wabaId}, phone number ID ${phoneId}, event ${session.event}`);

  steps.subscribed = await graph('POST', `${wabaId}/subscribed_apps`, { token });
  console.log('✓ app subscribed to the Messaging account webhooks');

  const phone = await graph('GET', phoneId, { token, query: { fields: 'display_phone_number,verified_name,is_on_biz_app,platform_type' } });
  steps.phone = phone;
  console.log(`✓ ${phone.verified_name} (${phone.display_phone_number}): is_on_biz_app=${phone.is_on_biz_app}, platform_type=${phone.platform_type}`);

  if (phone.is_on_biz_app) {
    // Each of these can only be done once, within 24 hours of onboarding
    steps.contacts_sync = await graph('POST', `${phoneId}/smb_app_data`, { token, body: { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' } });
    steps.history_sync = await graph('POST', `${phoneId}/smb_app_data`, { token, body: { messaging_product: 'whatsapp', sync_type: 'history' } });
    console.log(`✓ contacts and history sync started (request ids ${steps.contacts_sync.request_id}, ${steps.history_sync.request_id})`);
  } else {
    console.log('! The number is NOT on the Business app (normal Cloud API onboarding). It still needs');
    console.log('  POST /<phone_number_id>/register with a 6-digit PIN; see docs/META_SETUP.md. Not done automatically.');
  }
  save({ waba_id: wabaId, phone_number_id: phoneId, steps });
  console.log(`\nSaved to ${OUT}. Put into .env:\n  WA_PHONE_NUMBER_ID=${phoneId}\n  WA_BUSINESS_ACCOUNT_ID=${wabaId}`);
  console.log('Then create the permanent System User token (docs/META_SETUP.md, phase 6). Keep the WhatsApp Business app open until the sync settles.');
  return { ok: true, waba_id: wabaId, phone_number_id: phoneId, is_on_biz_app: phone.is_on_biz_app };
}

const readJson = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
});
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.method === 'POST' && req.url === '/session') {
      const data = await readJson(req);
      console.log(`session event: ${data.event} ${JSON.stringify(data.data || {})}`);
      if (data.event === 'CANCEL' || data.event === 'ERROR') return reply(res, 200, { ok: false, event: data.event, data: data.data });
      session = data;
      save();
      return reply(res, 200, { ok: true, stored: 'session', next: token ? await finish() : 'waiting for the code' });
    }
    if (req.method === 'POST' && req.url === '/code') {
      const { code } = await readJson(req);
      const t = await graph('GET', 'oauth/access_token', { query: { client_id: META_APP_ID, client_secret: META_APP_SECRET, code } });
      token = t.access_token;
      save();
      console.log('✓ code exchanged for a business token');
      return reply(res, 200, { ok: true, stored: 'token', next: session ? await finish() : 'waiting for the session event' });
    }
    reply(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    reply(res, 500, { ok: false, error: err.message });
  }
}).listen(PORT, () => console.log(`Embedded Signup page on http://localhost:${PORT} (open it through your HTTPS tunnel)`));
