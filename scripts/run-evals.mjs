#!/usr/bin/env node
// Plays the scripted test conversations in prompts/evals/cases.json against
// a running RAPS API and a Gemini model, the same way WF1 does: log the
// message, load the lead profile, run the agent with the tools from
// prompts/tools.json, then check what it did and said.
//
// Use a throwaway database: the cases create leads and bookings.
//
//   RAPS_API_URL=http://localhost:3000 RAPS_API_KEY=... OWNER_PHONE=91... \
//   GEMINI_API_KEY=... LLM_MODEL=gemini-... node scripts/run-evals.mjs [case-id ...]
//
// Writes a JSON report to evals-report.json (or EVALS_REPORT).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.RAPS_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.RAPS_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE;
const GEMINI_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.LLM_MODEL || (process.env.LLM_MODELS || '').split(',')[0];
const MAX_STEPS = 8;

for (const [name, val] of Object.entries({ RAPS_API_KEY: API_KEY, GEMINI_API_KEY: GEMINI_KEY, LLM_MODEL: MODEL })) {
  if (!val) { console.error(`${name} is not set`); process.exit(2); }
}

const systemTemplate = fs.readFileSync(path.join(ROOT, 'prompts/system.md'), 'utf8');
const { tools } = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/tools.json'), 'utf8'));
const { cases } = JSON.parse(fs.readFileSync(process.env.EVALS_CASES || path.join(ROOT, 'prompts/evals/cases.json'), 'utf8'));

// ---- helpers ---------------------------------------------------------------

const IST = 330 * 60000;
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
function plusDays(n) {
  const d = new Date(`${todayIst()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nowIstText() {
  const d = new Date(Date.now() + IST);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
  return `${day} ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}
// "{{DATE+5}}" → the date five days from today (IST). Cases may also have
// `setup` / `cleanup` steps: message, profile, owner command, booking.
const fill = (s, vars) => String(s)
  .replace(/\{\{DATE\+(\d+)\}\}/g, (_, n) => plusDays(Number(n)))
  .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'x-api-key': API_KEY, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// Gemini takes an OpenAPI subset: upper-case types, no empty objects
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.required) out.required = s.required;
  return out;
}
const functionDeclarations = tools.map((t) => {
  const decl = { name: t.name, description: t.description };
  if (Object.keys(t.parameters.properties || {}).length) decl.parameters = toGeminiSchema(t.parameters);
  return decl;
});

// The workflow's job: turn a tool call into an API request, adding context
async function callTool(name, args, ctx) {
  const t = tools.find((x) => x.name === name);
  if (!t) return { error: `unknown tool ${name}` };
  const a = { ...(args || {}) };
  let url = t.http.path.replace('{phone}', ctx.phone).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(a[k] ?? ''));
  const query = new URLSearchParams();
  for (const k of t.http.query || []) if (a[k] !== undefined && a[k] !== '') query.set(k, a[k]);
  if (t.context?.phone === 'query') query.set('phone', ctx.phone);
  if ([...query].length) url += `?${query}`;
  let body;
  if (t.http.body_from) body = { ...(a[t.http.body_from] || {}) };
  else if (t.http.body) body = Object.fromEntries(t.http.body.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  if (t.context?.phone === 'body') body = { ...(body || {}), phone: ctx.phone };
  const headers = Object.fromEntries(Object.entries(t.http.headers || {}).map(([h, v]) => [h, v.replace('{{context.message_id}}', ctx.messageId)]));
  const r = await api(t.http.method, url, t.http.method === 'GET' ? undefined : body ?? {}, headers);
  return r.status >= 400 ? { error: r.body.error || { status: r.status } } : r.body;
}

// Free-tier keys hit per-minute limits during a run: wait and retry when the
// API says the wait is short; a used-up daily quota still fails.
const MAX_WAIT_S = 90;
async function gemini(contents, systemText) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GEMINI_BASE}/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 200) return json.candidates?.[0]?.content || { role: 'model', parts: [] };
    const retry = (json.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
    const waitS = retry ? parseFloat(retry) + 1 : 30;
    if ((res.status === 429 || res.status === 503) && waitS <= MAX_WAIT_S && attempt < 5) {
      console.log(`   (Gemini ${res.status}, retrying in ${Math.round(waitS)}s)`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${json.error?.message || 'error'}`);
  }
}

// One customer turn, exactly as WF1 runs it
async function runTurn(state, text) {
  state.turn += 1;
  const messageId = `eval.${state.phone}.${state.turn}`;
  await api('POST', '/messages', { phone: state.phone, direction: 'in', wa_message_id: messageId, body: text, name: state.name });
  // Memory is the message log, delivered inside the profile, as in WF1
  const profile = (await api('GET', `/leads/${state.phone}?current=${encodeURIComponent(messageId)}`)).body;
  const system = systemTemplate.replace('{{NOW_IST}}', nowIstText()).replace('{{LEAD_PROFILE}}', JSON.stringify(profile, null, 2));
  state.contents = [{ role: 'user', parts: [{ text }] }];
  const calls = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const content = await gemini(state.contents, system);
    state.contents.push({ role: 'model', parts: content.parts || [] });
    const fnCalls = (content.parts || []).filter((p) => p.functionCall);
    if (!fnCalls.length) {
      const reply = (content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
      await api('POST', '/messages', { phone: state.phone, direction: 'out', body: reply });
      return { reply, calls };
    }
    const responses = [];
    for (const { functionCall: fc } of fnCalls) {
      const result = await callTool(fc.name, fc.args, { phone: state.phone, messageId });
      calls.push({ name: fc.name, args: fc.args || {}, ok: !result.error, result });
      responses.push({ functionResponse: { name: fc.name, response: result } });
    }
    state.contents.push({ role: 'user', parts: responses });
  }
  return { reply: '', calls, error: 'too many tool steps' };
}

// ---- checks ----------------------------------------------------------------

const subset = (want, got) => Object.entries(want).every(([k, v]) =>
  (v && typeof v === 'object') ? subset(v, got?.[k] || {}) : String(got?.[k]).toLowerCase() === String(v).toLowerCase());

function checkTurn(c, out, vars) {
  const fails = [];
  const reply = out.reply || '';
  const named = (n) => out.calls.filter((x) => x.name === n);
  for (const t of [].concat(c.tool_called || [])) {
    const spec = typeof t === 'string' ? { name: t } : t;
    const hit = named(spec.name).some((x) => !spec.args || subset(JSON.parse(fill(JSON.stringify(spec.args), vars)), x.args));
    if (!hit) fails.push(`expected tool ${spec.name}${spec.args ? ` with ${JSON.stringify(spec.args)}` : ''}`);
  }
  for (const n of [].concat(c.tool_not_called || [])) if (named(n).length) fails.push(`tool ${n} should not be called`);
  for (const re of [].concat(c.reply_matches || [])) if (!new RegExp(fill(re, vars), 'i').test(reply)) fails.push(`reply should match /${re}/`);
  for (const re of [].concat(c.reply_not_matches || [])) if (new RegExp(fill(re, vars), 'i').test(reply)) fails.push(`reply should not match /${re}/`);
  if (c.max_chars && reply.length > c.max_chars) fails.push(`reply is ${reply.length} chars (max ${c.max_chars})`);
  if (!reply) fails.push('no reply text');
  return fails;
}

async function setup(steps = [], state, vars) {
  for (const s of steps) {
    if (s.message) await api('POST', '/messages', { phone: state.phone, direction: 'in', body: s.message, name: state.name });
    if (s.profile) await api('PATCH', `/leads/${state.phone}`, JSON.parse(fill(JSON.stringify(s.profile), vars)));
    if (s.owner) {
      const r = await api('POST', '/owner/command', { phone: OWNER_PHONE, text: fill(s.owner, vars) });
      if (!r.body.ok) throw new Error(`setup owner command failed: ${r.body.reply || JSON.stringify(r.body)}`);
    }
    if (s.booking) {
      const r = await api('POST', '/bookings', { ...JSON.parse(fill(JSON.stringify(s.booking), vars)), phone: s.for_phone ? fill(s.for_phone, vars) : state.phone });
      if (r.status >= 300) throw new Error(`setup booking failed: ${JSON.stringify(r.body)}`);
      vars[s.save_ref_as || 'REF'] = r.body.booking.ref;
    }
  }
}

async function finalChecks(c, vars) {
  const fails = [];
  for (const b of c.booking_status || []) {
    const ref = fill(b.ref, vars);
    const r = await api('GET', `/bookings/${ref}`);
    if (r.body.status !== b.status) fails.push(`${ref} should be ${b.status}, is ${r.body.status}`);
  }
  return fails;
}

// ---- main ------------------------------------------------------------------

const only = process.argv.slice(2);
const selected = cases.filter((c) => !only.length || only.includes(c.id));
const results = [];
let n = 0;
for (const c of selected) {
  n += 1;
  // Unique per run and case: 91 + 7 + six digits of time + case number
  const phone = `917${String(Date.now()).slice(-6)}${String(n).padStart(3, '0')}`;
  const state = { phone, name: c.name, turn: 0, contents: [] };
  const vars = { PHONE: phone };
  const transcript = [];
  let fails = [];
  try {
    await setup(c.setup, state, vars);
    for (const turn of c.turns) {
      const text = fill(turn.user, vars);
      const out = await runTurn(state, text);
      transcript.push({ user: text, reply: out.reply, tools: out.calls.map((x) => `${x.name}${x.ok ? '' : ' (error)'}`) });
      fails.push(...checkTurn(turn.expect || {}, out, vars).map((f) => `turn ${transcript.length}: ${f}`));
      if (out.error) fails.push(`turn ${transcript.length}: ${out.error}`);
    }
    for (const f of [].concat(c.tool_called_anywhere || [])) {
      const spec = typeof f === 'string' ? { name: f } : f;
      const all = transcript.flatMap((t) => t.tools);
      if (!all.some((x) => x.startsWith(spec.name))) fails.push(`expected tool ${spec.name} somewhere in the conversation`);
    }
    fails.push(...await finalChecks(c, vars));
  } catch (err) {
    fails.push(`error: ${err.message}`);
  } finally {
    await setup(c.cleanup, state, vars).catch((err) => fails.push(`cleanup: ${err.message}`));
  }
  const pass = fails.length === 0;
  results.push({ id: c.id, pass, fails, transcript });
  console.log(`${pass ? '✅' : '❌'} ${n}/${selected.length} ${c.id}${pass ? '' : `\n   ${fails.join('\n   ')}`}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed with ${MODEL}`);
fs.writeFileSync(process.env.EVALS_REPORT || 'evals-report.json', JSON.stringify({ model: MODEL, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
