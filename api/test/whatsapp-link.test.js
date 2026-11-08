// The business number can be disconnected from the Cloud API (coexistence:
// phone unused ~14 days, number re-registered, …). The owner must hear about it.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, resetDb, pool } = require('./helpers');

beforeEach(resetDb);
after(() => pool.end());

const ownerNotes = async () => (await api.get('/outbox/pending')).body.filter((o) => o.recipient === 'owner');
const event = (body) => api.post('/whatsapp/link-events', { source: 'webhook', ...body });

test('a disconnection alerts the owner once, in plain words, and asks n8n to push it', async () => {
  const r = (await event({ event: 'PARTNER_REMOVED', reason: 'PRIMARY_INACTIVITY', details: { initiated_by: 'SYSTEM' } })).body;
  assert.equal(r.state, 'disconnected');
  assert.equal(r.alert, true);
  assert.match(r.text, /DISCONNECTED: the business phone did not open WhatsApp for about 14 days/);
  assert.match(r.text, /META_SETUP\.md/);
  assert.equal((await ownerNotes()).length, 1);

  // Meta repeats itself; health checks keep failing: no new alerts
  assert.equal((await event({ event: 'PARTNER_REMOVED', reason: 'PRIMARY_INACTIVITY' })).body.alert, false);
  assert.equal((await api.post('/whatsapp/link-events', { source: 'health_check', event: 'HEALTH_ERROR', error: 'not on Cloud API' })).body.alert, false);
  assert.equal((await ownerNotes()).length, 1);

  const status = (await api.get('/whatsapp/link')).body;
  assert.equal(status.state, 'disconnected');
  assert.equal(status.reason, 'PRIMARY_INACTIVITY');
  assert.equal(status.recent.length, 3);
});

test('the nightly digest leads with the problem until it is fixed, then recovery is announced', async () => {
  await event({ event: 'PARTNER_REMOVED', reason: 'CHANGE_NUMBER' });
  assert.match((await api.get('/reports/digest')).body.text, /^🚨 WhatsApp bot disconnected since .* \(change number\)/);

  const ok = (await api.post('/whatsapp/link-events', { source: 'health_check', event: 'HEALTH_OK' })).body;
  assert.equal(ok.state, 'connected');
  assert.equal(ok.alert, true);
  assert.match(ok.text, /connected again/);
  assert.doesNotMatch((await api.get('/reports/digest')).body.text, /🚨/);
  // Healthy and staying healthy: quiet
  assert.equal((await api.post('/whatsapp/link-events', { source: 'health_check', event: 'HEALTH_OK' })).body.alert, false);
});

test('restrictions alert each time, and a passing health check does not clear them', async () => {
  const a = (await event({ event: 'ACCOUNT_RESTRICTION', restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' })).body;
  assert.equal(a.state, 'restricted');
  assert.match(a.text, /restricted .*biz initiated messaging/);
  assert.equal((await event({ event: 'ACCOUNT_VIOLATION', violation_type: 'SCAM' })).body.alert, true);
  const check = (await api.post('/whatsapp/link-events', { source: 'health_check', event: 'HEALTH_OK' })).body;
  assert.equal(check.alert, false);
  assert.equal(check.state, 'restricted');
  // Meta lifts it
  assert.equal((await event({ event: 'DISABLED_UPDATE', ban_state: 'REINSTATE' })).body.state, 'connected');
});

test('events about other things (pricing tiers, …) change nothing', async () => {
  const r = (await event({ event: 'VOLUME_BASED_PRICING_TIER_UPDATE' })).body;
  assert.equal(r.alert, false);
  assert.equal(r.state, 'connected');
  assert.equal((await ownerNotes()).length, 0);
});
