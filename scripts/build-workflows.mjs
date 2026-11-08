#!/usr/bin/env node
// Generates the n8n workflows in n8n/workflows/ from prompts/system.md and
// prompts/tools.json, so the bot's prompt and tools have one source of truth.
// Re-run after editing either file:  node scripts/build-workflows.mjs
//
// Built for n8n 2.46 (pinned in docker-compose.yml). Workflows read their
// settings from environment variables (see .env.example), except the Gemini
// key, which is an n8n credential named "Gemini (RAPS)".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'n8n', 'workflows');
const systemPrompt = fs.readFileSync(path.join(ROOT, 'prompts/system.md'), 'utf8');
const { tools } = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/tools.json'), 'utf8'));

export const GEMINI_CREDENTIAL = { id: 'raps-gemini', name: 'Gemini (RAPS)' };

// ---- node helpers -----------------------------------------------------------

let ids = 0;
const nextId = (prefix) => `${prefix}-${String(++ids).padStart(3, '0')}`;

function node(name, type, typeVersion, parameters, position, extra = {}) {
  return { id: nextId('n'), name, type, typeVersion, position, parameters, ...extra };
}

const API = '$env.RAPS_API_URL';
const apiHeaders = { parameters: [{ name: 'x-api-key', value: '={{ $env.RAPS_API_KEY }}' }] };

// A call to the RAPS API. `body` is a JS expression (without ={{ }}).
function apiCall(name, method, urlExpr, body, position, extra = {}) {
  const p = {
    method,
    url: `={{ ${API} + ${urlExpr} }}`,
    sendHeaders: true,
    headerParameters: apiHeaders,
    options: { timeout: 20000 },
  };
  if (body) Object.assign(p, { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}` });
  return node(name, 'n8n-nodes-base.httpRequest', 4.5, p, position, extra);
}

// A WhatsApp Cloud API send. `payload` is a JS expression for the message body.
const GRAPH_URL = '={{ ($env.GRAPH_API_BASE || "https://graph.facebook.com/v27.0") + "/" + String($env.WA_PHONE_NUMBER_ID).trim() + "/messages" }}';
function whatsappSend(name, payload, position, extra = {}) {
  return node(name, 'n8n-nodes-base.httpRequest', 4.5, {
    method: 'POST',
    url: GRAPH_URL,
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: '={{ "Bearer " + String($env.WA_ACCESS_TOKEN).trim() }}' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify(${payload}) }}`,
    options: { timeout: 20000 },
  }, position, extra);
}
// A customer with a WhatsApp username may have no phone in the webhook; then
// the contact key is their business-scoped user ID ("IN.…"), sent as recipient
const address = (key) => `...(/^[A-Z]{2}\\./.test(String(${key})) ? { recipient: ${key} } : { to: ${key} })`;
const textMessage = (to, text) => `{ messaging_product: "whatsapp", recipient_type: "individual", ${address(to)}, type: "text", text: { preview_url: false, body: ${text} } }`;

function code(name, js, position, mode = 'runOnceForAllItems') {
  return node(name, 'n8n-nodes-base.code', 2, { mode, jsCode: js.trim() }, position);
}

// Routes items by an expression returning the output index
function route(name, outputs, expr, position) {
  return node(name, 'n8n-nodes-base.switch', 3.5, {
    mode: 'expression', numberOutputs: outputs, output: `={{ ${expr} }}`, options: {},
  }, position);
}

function connect(conns, from, to, { output = 0, type = 'main', index = 0 } = {}) {
  conns[from] ??= {};
  conns[from][type] ??= [];
  while (conns[from][type].length <= output) conns[from][type].push([]);
  conns[from][type][output].push({ node: to, type, index });
}

function workflow(name, nodes, connections) {
  return {
    name,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', timezone: 'Asia/Kolkata', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' },
    pinData: {},
    meta: { generatedBy: 'scripts/build-workflows.mjs' },
  };
}

// ---- WF1: inbound WhatsApp ----------------------------------------------------

const PARSE_JS = String.raw`
// Verifies Meta's signature, then turns the webhook payload into one item per
// message: customer messages, owner commands, and echoes of messages the
// owner typed from the WhatsApp Business app (coexistence).
const crypto = require('crypto');
const item = $input.first();
const body = item.json.body || {};

const secret = String($env.WA_APP_SECRET || '').trim();
if (secret) {
  const raw = Buffer.from(item.binary?.data?.data || '', 'base64');
  const given = String(item.json.headers['x-hub-signature-256'] || '');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return []; // not from Meta: ignore
  }
}

const digits = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 10 ? '91' + d : d;
};
const owner = digits($env.OWNER_PHONE);

// WhatsApp message → the text the bot sees ([image], [voice note], …)
function describe(m) {
  switch (m.type) {
    case 'text': return m.text?.body;
    case 'button': return m.button?.text;
    case 'interactive': return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
    case 'image': return '[image]' + (m.image?.caption ? ' ' + m.image.caption : '');
    case 'video': return '[video]' + (m.video?.caption ? ' ' + m.video.caption : '');
    case 'audio': return '[voice note]';
    case 'document': return '[document] ' + (m.document?.filename || '');
    case 'sticker': return '[sticker]';
    case 'location': {
      const l = m.location || {};
      return '[location: ' + [l.name, l.address].filter(Boolean).join(', ') + ' (' + l.latitude + ',' + l.longitude + ')]';
    }
    case 'contacts': return '[contact card]';
    case 'reaction': return null; // reactions need no reply
    default: return '[unsupported message]';
  }
}

const out = [];
for (const entry of body.entry || []) {
  for (const change of entry.changes || []) {
    const v = change.value || {};
    // With WhatsApp usernames the phone (from / wa_id) can be missing; the
    // business-scoped user ID (from_user_id / user_id) is always there.
    // "phone" below is the contact key: the phone if known, else the user ID.
    const contacts = v.contacts || [];
    const contactFor = (phone, userId) => contacts.find((c) => (phone && c.wa_id === phone) || (userId && c.user_id === userId))
      || (contacts.length === 1 ? contacts[0] : {});
    for (const m of v.messages || []) {
      const text = describe(m);
      if (text == null) continue;
      const c = contactFor(m.from, m.from_user_id);
      const from = digits(m.from || c.wa_id);
      const userId = m.from_user_id || c.user_id || null;
      if (!from && !userId) continue;
      out.push({ json: {
        kind: from && from === owner ? 'owner' : 'customer',
        phone: from || userId,
        user_id: userId,
        username: c.profile?.username || null,
        name: c.profile?.name || null,
        wa_message_id: m.id,
        message_type: m.type,
        text: String(text).trim(),
        referral: m.referral || null,
      } });
    }
    for (const m of v.message_echoes || []) {
      const text = describe(m);
      if (text == null) continue;
      const c = contactFor(m.to, m.to_user_id);
      const to = digits(m.to || c.wa_id);
      const userId = m.to_user_id || c.user_id || null;
      if (!to && !userId) continue;
      out.push({ json: { kind: 'echo', phone: to || userId, user_id: userId, username: c.profile?.username || null,
        wa_message_id: m.id, message_type: m.type, text: String(text).trim() } });
    }
  }
}
return out;
`;

const VERIFY_JS = String.raw`
// Meta's one-time webhook check: echo hub.challenge if the token matches
const q = $input.first().json.query || {};
const ok = q['hub.mode'] === 'subscribe' && String(q['hub.verify_token'] || '') === String($env.WA_VERIFY_TOKEN || '').trim() && !!$env.WA_VERIFY_TOKEN;
return [{ json: { ok, challenge: ok ? String(q['hub.challenge'] || '') : 'forbidden' } }];
`;

const BUILD_PROMPT_JS = String.raw`
// Fills the system prompt (prompts/system.md) with the time and the profile
const TEMPLATE = ${JSON.stringify(systemPrompt)};
const msg = $('Parse Meta payload').item.json;
const profile = $input.item.json;
const ist = new Date(Date.now() + 330 * 60000);
const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][ist.getUTCDay()];
const now = day + ' ' + ist.toISOString().slice(0, 10) + ' ' + ist.toISOString().slice(11, 16);
return { json: {
  phone: msg.phone,
  wa_message_id: msg.wa_message_id,
  user_text: msg.text,
  system_prompt: TEMPLATE.replace('{{NOW_IST}}', now).replace('{{LEAD_PROFILE}}', JSON.stringify(profile, null, 2)),
} };
`;

const CLEAN_REPLY_JS = String.raw`
// WhatsApp formatting: *bold* not **bold**, no markdown headings, size limit
let text = String($input.item.json.output || '').trim();
text = text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s*/gm, '').trim();
if (!text) text = 'Thanks for your message! Our team will get back to you shortly 🧡';
return { json: { phone: $('Build prompt').item.json.phone, reply: text.slice(0, 4000) } };
`;

const HOLDING_JS = String.raw`
// The AI could not answer (quota, outage): never leave the lead unanswered
const ctx = $('Build prompt').item.json;
return { json: {
  phone: ctx.phone,
  reply: 'Thanks for your message! Our team will get back to you shortly 🧡',
  error: String($input.item.json.error?.message || $input.item.json.error || 'unknown error').slice(0, 300),
  customer_said: String(ctx.user_text || '').slice(0, 300),
} };
`;

// One HTTP Request Tool per entry in prompts/tools.json. Everything the model
// fills in goes through $fromAI as a string; the API coerces types and treats
// "" as absent. The phone and message id come from the workflow, never the model.
function toolNode(t, i) {
  const ctx = "$('Build prompt').first().json";
  const fromAi = (key, schema, required) => {
    const desc = [schema.description, schema.enum && `One of: ${schema.enum.join(', ')}`].filter(Boolean).join('. ');
    return required
      ? `$fromAI(${JSON.stringify(key)}, ${JSON.stringify(desc)}, "string")`
      : `$fromAI(${JSON.stringify(key)}, ${JSON.stringify(desc)}, "string", "")`;
  };
  const props = t.parameters.properties || {};
  const required = new Set(t.parameters.required || []);

  let url = t.http.path.replace('{phone}', `" + ${ctx}.phone + "`);
  url = url.replace(/\{(\w+)\}/g, (_, k) => `" + encodeURIComponent(${fromAi(k, props[k], true)}) + "`);
  const p = {
    method: t.http.method,
    url: `={{ ${API} + "${url}" }}`,
    sendHeaders: true,
    headerParameters: { parameters: [...apiHeaders.parameters] },
    options: { timeout: 20000, response: { response: { neverError: true } } },
    descriptionType: 'manual',
    toolDescription: t.description,
  };
  for (const [h, v] of Object.entries(t.http.headers || {})) {
    p.headerParameters.parameters.push({ name: h, value: `={{ ${v.replace('{{context.message_id}}', `${ctx}.wa_message_id`).replace(/^/, '').trim()} }}` });
  }
  const query = (t.http.query || []).map((k) => ({ name: k, value: `={{ ${fromAi(k, props[k], required.has(k))} }}` }));
  if (t.context?.phone === 'query') query.push({ name: 'phone', value: `={{ ${ctx}.phone }}` });
  if (query.length) Object.assign(p, { sendQuery: true, queryParameters: { parameters: query } });

  let bodyFields = [];
  if (t.http.body_from) {
    const inner = props[t.http.body_from].properties;
    bodyFields = Object.entries(inner).map(([k, s]) => `${JSON.stringify(k)}: ${fromAi(k, s, false)}`);
  } else if (t.http.body) {
    bodyFields = t.http.body.map((k) => `${JSON.stringify(k)}: ${fromAi(k, props[k], required.has(k))}`);
  }
  if (t.context?.phone === 'body') bodyFields.push(`phone: ${ctx}.phone`);
  if (t.http.method !== 'GET') {
    Object.assign(p, { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ ${bodyFields.join(', ')} }) }}` });
  }
  // The idempotency header uses the raw message id, not a template string
  p.headerParameters.parameters = p.headerParameters.parameters.map((h) =>
    (h.name === 'Idempotency-Key' ? { name: h.name, value: `={{ ${ctx}.wa_message_id }}` } : h));
  return node(t.name, 'n8n-nodes-base.httpRequestTool', 4.5, p, [1400 + (i % 6) * 180, 760 + Math.floor(i / 6) * 180]);
}

function geminiModel(name, which, position) {
  const expr = which === 'primary'
    ? 'String($env.LLM_MODELS || "").split(",")[0].trim()'
    : '(String($env.LLM_MODELS || "").split(",")[1] || String($env.LLM_MODELS || "").split(",")[0]).trim()';
  return node(name, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, {
    modelName: `={{ "models/" + ${expr} }}`,
    options: { temperature: 0.2 },
  }, position, { credentials: { googlePalmApi: GEMINI_CREDENTIAL } });
}

function buildInbound() {
  ids = 0;
  const c = {};
  const nodes = [
    node('WhatsApp verify (GET)', 'n8n-nodes-base.webhook', 2.2,
      { httpMethod: 'GET', path: 'whatsapp', responseMode: 'responseNode', options: {} }, [0, 0], { webhookId: 'raps-whatsapp-verify' }),
    code('Check verify token', VERIFY_JS, [220, 0]),
    node('Answer Meta', 'n8n-nodes-base.respondToWebhook', 1.5, {
      respondWith: 'text', responseBody: '={{ $json.challenge }}',
      options: { responseCode: '={{ $json.ok ? 200 : 403 }}' },
    }, [440, 0]),

    node('WhatsApp inbound (POST)', 'n8n-nodes-base.webhook', 2.2,
      { httpMethod: 'POST', path: 'whatsapp', responseMode: 'onReceived', options: { rawBody: true } }, [0, 300], { webhookId: 'raps-whatsapp-inbound' }),
    code('Parse Meta payload', PARSE_JS, [220, 300]),
    route('Who is it?', 3, '({ owner: 0, echo: 1, customer: 2 })[$json.kind] ?? 2', [440, 300]),

    // Owner: deterministic commands, one-line reply
    apiCall('Run owner command', 'POST', '"/owner/command"', '{ phone: $json.phone, text: $json.text }', [700, 80]),
    whatsappSend('Reply to owner', textMessage("$('Parse Meta payload').item.json.phone", '$json.reply'), [920, 80]),

    // Owner typed to a customer from the Business app: log it, bot steps back
    apiCall('Log owner app message', 'POST', '"/messages"',
      '{ phone: $json.phone, user_id: $json.user_id || undefined, username: $json.username || undefined, direction: "out", kind: "owner_app", wa_message_id: $json.wa_message_id, body: $json.text }', [700, 280]),
    apiCall('Pause bot for customer', 'POST', '"/leads/" + $(\'Parse Meta payload\').item.json.phone + "/pause"', null, [920, 280]),

    // Customer: log, then reply unless duplicate / opted out / owner took over
    apiCall('Log inbound', 'POST', '"/messages"',
      '{ phone: $json.phone, user_id: $json.user_id || undefined, username: $json.username || undefined, direction: "in", wa_message_id: $json.wa_message_id, kind: $json.message_type, body: $json.text, name: $json.name || undefined, referral: $json.referral || undefined }',
      [700, 500]),
    route('Should reply?', 2, '(!$json.duplicate && !$json.opted_out && !$json.bot_paused) ? 0 : 1', [920, 500]),
    apiCall('Load profile', 'GET',
      '"/leads/" + $(\'Parse Meta payload\').item.json.phone + "?current=" + encodeURIComponent($(\'Parse Meta payload\').item.json.wa_message_id)', null, [1140, 500]),
    code('Build prompt', BUILD_PROMPT_JS, [1360, 500], 'runOnceForEachItem'),
    node('AI Agent', '@n8n/n8n-nodes-langchain.agent', 3.1, {
      promptType: 'define',
      text: '={{ $json.user_text }}',
      needsFallback: true,
      options: { systemMessage: '={{ $json.system_prompt }}', maxIterations: 8 },
    }, [1600, 500], { onError: 'continueErrorOutput' }),
    geminiModel('Gemini', 'primary', [1400, 1180]),
    geminiModel('Gemini fallback', 'fallback', [1580, 1180]),
    code('Clean reply', CLEAN_REPLY_JS, [1900, 420], 'runOnceForEachItem'),
    whatsappSend('Send reply', textMessage('$json.phone', '$json.reply'), [2120, 420]),
    apiCall('Log reply', 'POST', '"/messages"', '{ phone: $(\'Clean reply\').item.json.phone, direction: "out", body: $(\'Clean reply\').item.json.reply }', [2340, 420]),

    code('Holding reply', HOLDING_JS, [1900, 640], 'runOnceForEachItem'),
    whatsappSend('Send holding reply', textMessage('$json.phone', '$json.reply'), [2120, 640]),
    apiCall('Alert owner: AI failed', 'POST', '"/handoffs"',
      '{ phone: $(\'Holding reply\').item.json.phone, reason: "other", priority: "urgent", summary: "The bot could not reply (" + $(\'Holding reply\').item.json.error + "). Customer said: " + $(\'Holding reply\').item.json.customer_said }',
      [2340, 640]),
  ];
  const toolNodes = tools.map(toolNode);
  nodes.push(...toolNodes);

  connect(c, 'WhatsApp verify (GET)', 'Check verify token');
  connect(c, 'Check verify token', 'Answer Meta');
  connect(c, 'WhatsApp inbound (POST)', 'Parse Meta payload');
  connect(c, 'Parse Meta payload', 'Who is it?');
  connect(c, 'Who is it?', 'Run owner command', { output: 0 });
  connect(c, 'Who is it?', 'Log owner app message', { output: 1 });
  connect(c, 'Who is it?', 'Log inbound', { output: 2 });
  connect(c, 'Run owner command', 'Reply to owner');
  connect(c, 'Log owner app message', 'Pause bot for customer');
  connect(c, 'Log inbound', 'Should reply?');
  connect(c, 'Should reply?', 'Load profile', { output: 0 });
  connect(c, 'Load profile', 'Build prompt');
  connect(c, 'Build prompt', 'AI Agent');
  connect(c, 'AI Agent', 'Clean reply', { output: 0 });
  connect(c, 'AI Agent', 'Holding reply', { output: 1 });
  connect(c, 'Clean reply', 'Send reply');
  connect(c, 'Send reply', 'Log reply');
  connect(c, 'Holding reply', 'Send holding reply');
  connect(c, 'Send holding reply', 'Alert owner: AI failed');
  connect(c, 'Gemini', 'AI Agent', { type: 'ai_languageModel', index: 0 });
  connect(c, 'Gemini fallback', 'AI Agent', { type: 'ai_languageModel', index: 1 });
  for (const t of toolNodes) connect(c, t.name, 'AI Agent', { type: 'ai_tool' });

  return workflow('RAPS · 1 · Inbound WhatsApp', nodes, c);
}

// ---- WF2: outbox sender --------------------------------------------------------

const OUTBOX_PAYLOAD_JS = String.raw`
// Free text inside the 24h window, otherwise the approved template with the
// message flattened into its single body variable
const m = $input.item.json;
// The API gives "to" (phone) or, for a customer known only by their WhatsApp
// user ID (usernames), "user_id", which Meta takes as "recipient"
const who = m.to ? { to: m.to } : { recipient: m.user_id || m.phone };
const payload = m.send_as === 'text'
  ? { messaging_product: 'whatsapp', recipient_type: 'individual', ...who, type: 'text', text: { preview_url: false, body: m.text } }
  : { messaging_product: 'whatsapp', recipient_type: 'individual', ...who, type: 'template',
      template: { name: m.template, language: { code: $env.WA_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: m.variables.map((v) => ({ type: 'text', text: String(v).slice(0, 1000) })) }] } };
return { json: { id: m.id, payload } };
`;

function buildOutbox() {
  ids = 0;
  const c = {};
  const nodes = [
    node('Every 30 seconds', 'n8n-nodes-base.scheduleTrigger', 1.2,
      { rule: { interval: [{ field: 'seconds', secondsInterval: 30 }] } }, [0, 0]),
    apiCall('Pending messages', 'GET', '"/outbox/pending"', null, [220, 0]),
    code('Build WhatsApp payload', OUTBOX_PAYLOAD_JS, [440, 0], 'runOnceForEachItem'),
    whatsappSend('Send', '$json.payload', [660, 0], { onError: 'continueErrorOutput' }),
    apiCall('Mark sent', 'POST', '"/outbox/" + $(\'Build WhatsApp payload\').item.json.id + "/sent"', null, [900, -100]),
    apiCall('Mark failed', 'POST', '"/outbox/" + $(\'Build WhatsApp payload\').item.json.id + "/failed"',
      '{ error: String($json.error?.message || $json.error || "send failed").slice(0, 500) }', [900, 100]),
  ];
  connect(c, 'Every 30 seconds', 'Pending messages');
  connect(c, 'Pending messages', 'Build WhatsApp payload');
  connect(c, 'Build WhatsApp payload', 'Send');
  connect(c, 'Send', 'Mark sent', { output: 0 });
  connect(c, 'Send', 'Mark failed', { output: 1 });
  return workflow('RAPS · 2 · Outbox sender', nodes, c);
}

// ---- WF3: scheduled jobs ---------------------------------------------------------

function buildJobs() {
  ids = 0;
  const c = {};
  const nodes = [
    node('Every 15 minutes', 'n8n-nodes-base.scheduleTrigger', 1.2,
      { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }, [0, 0]),
    apiCall('Expire lapsed holds', 'POST', '"/jobs/sweep"', null, [220, 0]),
    apiCall('Queue reminders', 'POST', '"/jobs/reminders/run"', null, [440, 0]),
    apiCall('Queue review requests', 'POST', '"/jobs/reviews/run"', null, [660, 0]),
    node('Every day 21:00', 'n8n-nodes-base.scheduleTrigger', 1.2,
      { rule: { interval: [{ field: 'cronExpression', expression: '0 21 * * *' }] } }, [0, 220]),
    apiCall('Queue owner digest', 'POST', '"/reports/digest/send"', null, [220, 220]),
  ];
  connect(c, 'Every 15 minutes', 'Expire lapsed holds');
  connect(c, 'Expire lapsed holds', 'Queue reminders');
  connect(c, 'Queue reminders', 'Queue review requests');
  connect(c, 'Every day 21:00', 'Queue owner digest');
  return workflow('RAPS · 3 · Reminders and digest', nodes, c);
}

// ---- write --------------------------------------------------------------------------

const outputs = {
  'raps-1-inbound.json': buildInbound(),
  'raps-2-outbox-sender.json': buildOutbox(),
  'raps-3-scheduled-jobs.json': buildJobs(),
};
fs.mkdirSync(OUT, { recursive: true });
for (const [file, wf] of Object.entries(outputs)) {
  wf.id = file.replace('.json', '');
  fs.writeFileSync(path.join(OUT, file), `${JSON.stringify(wf, null, 2)}\n`);
  console.log(`wrote n8n/workflows/${file} (${wf.nodes.length} nodes)`);
}
