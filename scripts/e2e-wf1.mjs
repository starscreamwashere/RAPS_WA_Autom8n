#!/usr/bin/env node
// End-to-end test of WF1 (Inbound WhatsApp) running in a real n8n, with
// Meta's Graph API replaced by scripts/mock-graph.mjs. Sends webhooks the way
// Meta does (signed with the app secret) and checks what n8n sent back and
// what the API recorded. Needs: the API on a throwaway database, the mock,
// and n8n with WF1 published and these env vars set the same way
// (GRAPH_API_BASE pointing at the mock). See docs/E2E.md.
//
//   N8N_URL=http://localhost:5678 MOCK_GRAPH_URL=http://localhost:4010 \
//   RAPS_API_URL=http://localhost:3000 RAPS_API_KEY=... OWNER_PHONE=91... \
//   WA_APP_SECRET=... WA_VERIFY_TOKEN=... node scripts/e2e-wf1.mjs

import crypto from 'node:crypto';

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const HOOK = `${N8N}/webhook/whatsapp`;
const MOCK = (process.env.MOCK_GRAPH_URL || 'http://localhost:4010').replace(/\/$/, '');
const API = (process.env.RAPS_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const { RAPS_API_KEY, OWNER_PHONE, WA_APP_SECRET, WA_VERIFY_TOKEN } = process.env;
const BUSINESS = process.env.BUSINESS_PHONE || '919082201911';
const REPLY_TIMEOUT = Number(process.env.REPLY_TIMEOUT_MS) || 120000;

for (const [k, v] of Object.entries({ RAPS_API_KEY, OWNER_PHONE, WA_APP_SECRET, WA_VERIFY_TOKEN })) {
  if (!v) { console.error(`${k} is not set`); process.exit(2); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'x-api-key': RAPS_API_KEY, 'content-type': 'application/json', ...init.headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const sentTo = async (phone) => (await (await fetch(`${MOCK}/__sent`)).json()).filter((m) => (m.body.to === phone || m.body.recipient === phone) && !m.failed);

// ---- Meta-shaped webhooks ---------------------------------------------------

let seq = 0;
const wamid = () => `wamid.e2e.${Date.now()}.${++seq}`;
const envelope = (field, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS, phone_number_id: '1234567890' }, ...value } }] }],
});
const textFrom = (phone, text, name = 'E2E Tester', id = wamid()) => envelope('messages', {
  contacts: [{ wa_id: phone, profile: { name } }],
  messages: [{ from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
// A customer with a WhatsApp username: no phone in the webhook, only their
// business-scoped user ID
const textFromUsername = (userId, username, text, id = wamid()) => envelope('messages', {
  contacts: [{ user_id: userId, profile: { name: 'Asha', username } }],
  messages: [{ from_user_id: userId, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
// What Meta sends when the owner types to a customer from the WhatsApp Business app
const echoTo = (phone, text) => envelope('smb_message_echoes', {
  message_echoes: [{ from: BUSINESS, to: phone, id: wamid(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});

async function deliver(payload, { secret = WA_APP_SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
}

async function waitForSend(phone, count, timeout = REPLY_TIMEOUT) {
  const until = Date.now() + timeout;
  for (;;) {
    const got = await sentTo(phone);
    if (got.length >= count) return got;
    if (Date.now() > until) return got;
    await sleep(1000);
  }
}

// ---- checks ----------------------------------------------------------------

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`✅ ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`❌ ${name}\n   ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const customer = `9198${String(Date.now()).slice(-8)}`;

// --ai-down: run against an n8n whose LLM_MODELS name models that do not
// exist, and check only the safety net (holding reply + urgent owner alert).
if (process.argv.includes('--ai-down')) {
  await check('AI fails: customer still gets a holding reply, owner gets an urgent handoff', async () => {
    await deliver(textFrom(customer, 'Hi, is a PS5 free this weekend?', 'Asha'));
    const got = await waitForSend(customer, 1, 60000);
    assert(got.length === 1, `expected 1 holding reply, got ${got.length}`);
    assert(/team will get back/i.test(got[0].body.text?.body || ''), `unexpected reply: ${got[0].body.text?.body}`);
    await sleep(1500);
    const handoffs = (await api('/handoffs')).body;
    const list = Array.isArray(handoffs) ? handoffs : handoffs.handoffs || [];
    assert(list.some((h) => h.priority === 'urgent' && /could not reply/.test(h.summary || '')), 'no urgent handoff for the failure');
  });
  const ok = results.every((r) => r.pass);
  console.log(`\n${ok ? 1 : 0}/1 WF1 checks passed (AI down)`);
  process.exit(ok ? 0 : 1);
}
const intruder = `9197${String(Date.now()).slice(-8)}`;

await check('webhook verify: right token gets the challenge, wrong one 403', async () => {
  const ok = await fetch(`${HOOK}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WA_VERIFY_TOKEN)}&hub.challenge=4242`);
  assert(ok.status === 200 && (await ok.text()).trim() === '4242', `expected 200 "4242", got ${ok.status}`);
  const bad = await fetch(`${HOOK}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242`);
  assert(bad.status === 403, `wrong token answered ${bad.status}`);
});

await check('bad signature: ignored, nothing logged or sent', async () => {
  await deliver(textFrom(intruder, 'Hi, PS5 for a week?'), { secret: 'not-the-secret' });
  await sleep(8000);
  const lead = await api(`/leads/${intruder}`);
  assert(lead.status === 404 || !(lead.body.recent_messages || []).length, 'the message was logged');
  assert(!(await sentTo(intruder)).length, 'a reply was sent');
});

await check('owner command: HELP is answered by the API, not the AI', async () => {
  await deliver(textFrom(OWNER_PHONE, 'HELP', 'Owner'));
  const got = await waitForSend(OWNER_PHONE, 1, 30000);
  assert(got.length >= 1, 'no reply to the owner');
  assert(/PAID/i.test(got.at(-1).body.text?.body || ''), `reply does not look like the command list: ${got.at(-1).body.text?.body}`);
  const asLead = await api(`/leads/${OWNER_PHONE}`);
  assert(asLead.status === 404 || !(asLead.body.recent_messages || []).length, 'owner message was logged as a customer message');
});

let firstId;
await check('customer message: agent quotes from the rate card and the reply is sent and logged', async () => {
  firstId = wamid();
  await deliver(textFrom(customer, 'Hi! How much for a PS5 for 1 week with 1 controller?', 'Rohan', firstId));
  const got = await waitForSend(customer, 1);
  assert(got.length === 1, `expected 1 reply, got ${got.length}`);
  const text = got[0].body.text?.body || '';
  console.log(`   bot: ${text.replace(/\n/g, ' / ').slice(0, 220)}`);
  assert(got[0].auth === 'Bearer mock-token' || got[0].auth?.startsWith('Bearer '), 'no bearer token on the send');
  assert(/2,?750/.test(text), 'reply does not carry the ₹2,750 rate-card price');
  assert(!/\*\*/.test(text), 'reply has markdown **bold**');
  await sleep(1500);
  const lead = (await api(`/leads/${customer}`)).body;
  const msgs = lead.recent_messages || [];
  assert(msgs.some((m) => m.from === 'customer'), 'inbound message not logged');
  assert(msgs.some((m) => m.from === 'assistant'), 'reply not logged');
});

await check('duplicate delivery of the same message: no second reply', async () => {
  await deliver(textFrom(customer, 'Hi! How much for a PS5 for 1 week with 1 controller?', 'Rohan', firstId));
  await sleep(10000);
  const got = await sentTo(customer);
  assert(got.length === 1, `expected still 1 reply, got ${got.length}`);
});

await check('owner types from the Business app (echo): bot pauses for that customer', async () => {
  await deliver(echoTo(customer, 'Hi Rohan, this is Vindy from RAPS. I will help you directly.'));
  await sleep(5000);
  const lead = (await api(`/leads/${customer}`)).body;
  assert(lead.bot_paused === true, `bot_paused is ${lead.bot_paused}`);
  const pending = (await api('/outbox/pending')).body;
  const list = Array.isArray(pending) ? pending : pending.messages || pending.items || [];
  assert(list.some((m) => /paused/i.test(JSON.stringify(m))), 'no "bot paused" note queued for the owner');
});

await check('while paused: customer message is logged but the bot stays quiet', async () => {
  const before = (await sentTo(customer)).length;
  await deliver(textFrom(customer, 'Okay, can you deliver tomorrow?', 'Rohan'));
  await sleep(12000);
  assert((await sentTo(customer)).length === before, 'the bot replied while paused');
  const msgs = (await api(`/leads/${customer}`)).body.recent_messages || [];
  assert(msgs.some((m) => /deliver tomorrow/.test(m.text || '')), 'message not logged');
});

await check('owner RESUME hands the customer back to the bot', async () => {
  const before = (await sentTo(OWNER_PHONE)).length;
  await deliver(textFrom(OWNER_PHONE, `RESUME ${customer}`, 'Owner'));
  const got = await waitForSend(OWNER_PHONE, before + 1, 30000);
  assert(got.length > before, 'no reply to the owner');
  const lead = (await api(`/leads/${customer}`)).body;
  assert(lead.bot_paused === false, `bot_paused is ${lead.bot_paused}`);
});

await check('customer with a WhatsApp username (no phone): answered by user ID', async () => {
  const userId = `IN.${Date.now()}${seq}`;
  await deliver(textFromUsername(userId, 'asha.games', 'Hi! PS5 for 1 day with 1 controller, price?'));
  const got = await waitForSend(userId, 1);
  assert(got.length === 1, `expected 1 reply, got ${got.length}`);
  assert(got[0].body.recipient === userId && !got[0].body.to, 'reply not addressed by recipient');
  console.log(`   bot: ${(got[0].body.text?.body || '').replace(/\n/g, ' / ').slice(0, 160)}`);
  const lead = (await api(`/leads/${userId}`)).body;
  assert(lead.user_id === userId && lead.phone === null && lead.username === 'asha.games', `lead: ${JSON.stringify(lead).slice(0, 200)}`);
});

await check('Meta disconnects the number: owner gets a push alert (WhatsApp may be down) and the state is recorded', async () => {
  const before = (await (await fetch(`${MOCK}/__push`)).json()).length;
  await deliver({
    object: 'whatsapp_business_account',
    entry: [{ id: 'PARTNER', time: Math.floor(Date.now() / 1000), changes: [{ field: 'account_update', value: {
      event: 'PARTNER_REMOVED',
      waba_info: { waba_id: 'WABA', owner_business_id: 'BIZ' },
      disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
    } }] }],
  });
  const until = Date.now() + 20000;
  let pushes = [];
  while (Date.now() < until) {
    pushes = (await (await fetch(`${MOCK}/__push`)).json()).slice(before);
    if (pushes.length) break;
    await sleep(1000);
  }
  assert(pushes.length === 1, `expected 1 push, got ${pushes.length} (is ALERT_PUSH_URL set to ${MOCK}/__push?)`);
  assert(/DISCONNECTED: the business phone did not open WhatsApp for about 14 days/.test(pushes[0].text), pushes[0].text);
  console.log(`   push: ${pushes[0].text.slice(0, 120)}…`);
  const link = (await api('/whatsapp/link')).body;
  assert(link.state === 'disconnected', `state is ${link.state}`);
  // Reconnected later: back to normal (so the run can be repeated)
  await api('/whatsapp/link-events', { method: 'POST', body: JSON.stringify({ source: 'health_check', event: 'HEALTH_OK' }) });
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} WF1 checks passed`);
process.exit(passed === results.length ? 0 : 1);
