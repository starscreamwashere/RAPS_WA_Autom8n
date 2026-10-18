#!/usr/bin/env node
// Lists the Gemini models this API key can use right now and, with --probe,
// checks which ones actually answer on the key's current tier (free tier
// quotas are per model, and models.list does not say which are free).
//
// Usage:
//   GEMINI_API_KEY=... node scripts/gemini-models.mjs            # list text models
//   GEMINI_API_KEY=... node scripts/gemini-models.mjs --probe    # + test each one
//   GEMINI_API_KEY=... node scripts/gemini-models.mjs --probe --json
//
// The probe sends two tiny requests per model: a plain "reply OK" and a
// function-calling check, because the AI Agent depends on tool calls.

const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const API_KEY = process.env.GEMINI_API_KEY;
const args = new Set(process.argv.slice(2));
const PROBE = args.has('--probe');
const JSON_OUT = args.has('--json');

// Model families that can't run a text chat agent
const NON_CHAT = /(embedding|imagen|image|tts|audio|live|native|veo|aqa|learnlm|robotics|computer-use)/i;

if (!API_KEY) {
  console.error('GEMINI_API_KEY is not set. Create a key at https://aistudio.google.com/apikey');
  process.exit(1);
}

async function call(path, body) {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': API_KEY, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function listModels() {
  const models = [];
  let pageToken = '';
  do {
    const { status, json } = await call(`models?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (status !== 200) {
      throw new Error(`models.list failed (${status}): ${json.error?.message || 'unknown error'}`);
    }
    models.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);

  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .filter((m) => /gemini/i.test(m.name) && !NON_CHAT.test(m.name))
    .map((m) => ({
      id: m.name.replace(/^models\//, ''),
      displayName: m.displayName,
      inputTokenLimit: m.inputTokenLimit,
      outputTokenLimit: m.outputTokenLimit,
      preview: /(preview|exp)/i.test(m.name),
    }));
}

function describeFailure(status, json) {
  const msg = json.error?.message || '';
  if (status === 429 && /limit:\s*0/i.test(msg)) return 'not on this tier (quota 0)';
  if (status === 429) return 'rate-limited / quota used up';
  if (status === 403) return 'no access';
  if (status === 404) return 'not found';
  return `HTTP ${status}${msg ? `: ${msg.slice(0, 80)}` : ''}`;
}

async function probe(id) {
  const text = await call(`models/${id}:generateContent`, {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
    generationConfig: { maxOutputTokens: 1024 },
  });
  if (text.status !== 200) return { usable: false, tools: false, note: describeFailure(text.status, text.json) };

  const tool = await call(`models/${id}:generateContent`, {
    contents: [{ role: 'user', parts: [{ text: 'What are your rates? Use the tool.' }] }],
    tools: [{ functionDeclarations: [{
      name: 'get_rates',
      description: 'Returns current rental and birthday package prices.',
      parameters: { type: 'object', properties: {} },
    }] }],
    generationConfig: { maxOutputTokens: 1024 },
  });
  const parts = tool.json.candidates?.[0]?.content?.parts || [];
  const calledTool = parts.some((p) => p.functionCall?.name === 'get_rates');
  return {
    usable: true,
    tools: calledTool,
    note: tool.status === 200 ? (calledTool ? 'ok' : 'answered but did not call the tool') : describeFailure(tool.status, tool.json),
  };
}

// Stable before preview (previews can disappear), then Flash before Flash-Lite
// before Pro (Pro is rarely on the free tier and is slower), then newest name first.
function rank(m) {
  const family = /flash-lite/i.test(m.id) ? 1 : /flash/i.test(m.id) ? 0 : 2;
  return [m.preview ? 1 : 0, family];
}

function compare(a, b) {
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

let models;
try {
  models = (await listModels()).sort(compare);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (PROBE) {
  for (const m of models) Object.assign(m, await probe(m.id));
}

if (JSON_OUT) {
  console.log(JSON.stringify(models, null, 2));
} else {
  console.log(`\n${models.length} text models visible to this key${PROBE ? ' (probed)' : ''}:\n`);
  for (const m of models) {
    const status = PROBE ? `${m.usable ? '✅' : '❌'} tools:${m.tools ? 'yes' : 'no '}  ` : '';
    console.log(`  ${status}${m.id.padEnd(40)} ${m.preview ? '[preview] ' : ''}${PROBE ? m.note : m.displayName}`);
  }
  if (PROBE) {
    const picks = models.filter((m) => m.usable && m.tools).map((m) => m.id);
    console.log(picks.length
      ? `\nSuggested fallback order for .env:\nLLM_MODELS=${picks.slice(0, 3).join(',')}\n`
      : '\nNo model passed both checks on this key.\n');
  } else {
    console.log('\nRun again with --probe to see which ones work on this key right now.\n');
  }
}
