// Checks scripts/run-evals.mjs end to end against the real API, with a
// scripted fake Gemini in place of the model: tool calls are mapped to the
// right requests, context (phone) is injected, and failures are reported.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resetDb, pool, clock, OWNER } = require('./helpers');
const { createApp } = require('../src/app');

let apiServer;
let fakeGemini;
const seen = [];

function fakeModel(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push({ url: req.url, body });
    const system = body.systemInstruction.parts[0].text;
    const last = body.contents[body.contents.length - 1].parts[0];
    let part;
    if (last.functionResponse) {
      const r = last.functionResponse.response;
      part = { text: r.total ? `A week is ₹${r.total.toLocaleString('en-IN')}.` : r.cancelled ? 'Done, it is cancelled.' : 'Noted.' };
    } else if (/week/.test(last.text)) {
      part = { functionCall: { name: 'get_quote', args: { kind: 'rental', days: 7, controllers: 2 } } };
    } else if (/cancel/.test(last.text)) {
      part = { functionCall: { name: 'cancel_booking', args: { ref: system.match(/RP-\d+/)[0] } } };
    } else {
      part = { text: 'Hello!' };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] } }] }));
  });
}

const listen = (server) => new Promise((r) => server.listen(0, () => r(server.address().port)));

before(async () => {
  await resetDb();
  clock.set(null); // the runner works from real dates
  apiServer = http.createServer(createApp());
  fakeGemini = http.createServer(fakeModel);
  await Promise.all([listen(apiServer), listen(fakeGemini)]);
});

after(async () => {
  apiServer.close();
  fakeGemini.close();
  await pool.end();
});

test('the eval runner drives the agent loop and reports pass/fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  const casesFile = path.join(dir, 'cases.json');
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(casesFile, JSON.stringify({ cases: [
    { id: 'quote', turns: [{ user: 'PS5 for a week, 2 controllers?',
      expect: { tool_called: [{ name: 'get_quote', args: { days: 7 } }], reply_matches: ['2,999'] } }] },
    { id: 'cancel', setup: [{ message: 'hi' }, { booking: { kind: 'rental', start_date: '{{DATE+6}}', days: 7, controllers: 1 } }],
      turns: [{ user: 'please cancel', expect: { tool_called: ['cancel_booking'] } }],
      booking_status: [{ ref: '{{REF}}', status: 'cancelled' }] },
    { id: 'should-fail', turns: [{ user: 'hello', expect: { reply_matches: ['this text never appears'] } }] },
  ] }));

  const env = {
    ...process.env,
    RAPS_API_URL: `http://localhost:${apiServer.address().port}`,
    RAPS_API_KEY: 'test-key',
    OWNER_PHONE: OWNER,
    GEMINI_API_BASE: `http://localhost:${fakeGemini.address().port}`,
    GEMINI_API_KEY: 'fake',
    LLM_MODEL: 'fake-model',
    EVALS_CASES: casesFile,
    EVALS_REPORT: report,
  };
  const script = path.join(__dirname, '..', '..', 'scripts', 'run-evals.mjs');
  const code = await new Promise((resolve) => {
    execFile(process.execPath, [script], { env }, (err) => resolve(err ? err.code : 0));
  });

  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(code, 1, 'one failing case makes the run fail');
  assert.deepEqual(r.results.map((x) => [x.id, x.pass]), [['quote', true], ['cancel', true], ['should-fail', false]]);
  assert.match(r.results[2].fails[0], /reply should match/);
  assert.equal(r.results[0].transcript[0].reply, 'A week is ₹2,999.');

  // The model saw the tools, the filled-in prompt, and the lead profile
  const first = seen[0].body;
  assert.equal(first.tools[0].functionDeclarations.length, 11);
  assert.doesNotMatch(first.systemInstruction.parts[0].text, /\{\{(NOW_IST|LEAD_PROFILE)\}\}/);
  assert.match(first.systemInstruction.parts[0].text, /"missing_for_quote"/);
  assert.match(seen[0].url, /fake-model:generateContent/);
});
