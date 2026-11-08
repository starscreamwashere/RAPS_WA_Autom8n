// Is the business number still connected to the Cloud API? Fed by Meta's
// account_update webhooks (WF1) and a periodic health check (WF3). The owner
// is alerted when the state changes; the reply also tells n8n to send the
// alert by push, because a disconnected number cannot send WhatsApp messages.
const { pool, withTx } = require('../db');
const clock = require('../clock');
const { getSettings, setSetting } = require('../settings');
const { enqueue } = require('./outbox');

const FIX = 'Fix: open WhatsApp Business on the business phone, then reconnect the number (docs/META_SETUP.md, phase 5).';

// Why Meta disconnected the number, in the owner's words
const DISCONNECT_REASONS = {
  PRIMARY_INACTIVITY: 'the business phone did not open WhatsApp for about 14 days',
  COMPANION_INACTIVITY: 'a linked device was inactive for about 30 days',
  BUSINESS_DOWNGRADE: 'the business number was registered on the normal (non-Business) WhatsApp app',
  CHANGE_NUMBER: 'the business number was changed in WhatsApp',
  USER_RE_REGISTERED: 'WhatsApp Business was set up again on a new phone',
  ACCOUNT_DISCONNECTED: 'it was disconnected in the WhatsApp Business app (Settings → Account → Business Platform) or by Meta',
};

// Meta event → new state and the alert text (null state: not about the link)
function classify({ event, reason, ban_state: banState, restriction_type: restriction, violation_type: violation, error }) {
  switch (event) {
    case 'PARTNER_REMOVED':
    case 'PARTNER_APP_UNINSTALLED':
    case 'ACCOUNT_DELETED': {
      const why = DISCONNECT_REASONS[reason] || (reason ? reason.toLowerCase().replace(/_/g, ' ') : 'Meta reported it');
      return { state: 'disconnected', text: `🚨 WhatsApp bot DISCONNECTED: ${why}. Customers are not getting bot replies and the bot cannot send reminders. ${FIX}` };
    }
    case 'DISABLED_UPDATE':
      if (banState === 'REINSTATE') return { state: 'connected', text: '✅ Meta reinstated the WhatsApp business account. The bot is working again.' };
      return { state: 'restricted', text: `🚨 Meta ${banState === 'SCHEDULE_FOR_DISABLE' ? 'plans to disable' : 'disabled'} the WhatsApp business account for a policy issue. Check WhatsApp Manager → Account quality and appeal there.` };
    case 'ACCOUNT_RESTRICTION':
      return { state: 'restricted', text: `⚠️ Meta restricted the WhatsApp business account${restriction ? ` (${restriction.toLowerCase().replace(/_/g, ' ')})` : ''}. Check WhatsApp Manager → Account quality.` };
    case 'ACCOUNT_VIOLATION':
      return { state: 'restricted', text: `⚠️ Meta flagged a policy violation on the WhatsApp business account${violation ? ` (${violation.toLowerCase().replace(/_/g, ' ')})` : ''}. Check WhatsApp Manager → Account quality.` };
    case 'PARTNER_ADDED':
    case 'PARTNER_APP_INSTALLED':
    case 'HEALTH_OK':
      return { state: 'connected', text: '✅ The WhatsApp bot is connected again and answering customers.' };
    case 'HEALTH_ERROR':
      return { state: 'disconnected', text: `🚨 WhatsApp bot check failed: Meta says ${error || 'the number is not on the Cloud API'}. Customers may not be getting bot replies. If the access token was changed or expired, update WA_ACCESS_TOKEN; otherwise ${FIX.slice(5)}` };
    default:
      return { state: null, text: null };
  }
}

async function recordLinkEvent(input) {
  return withTx(async (client) => {
    const settings = await getSettings(client);
    const current = settings.whatsapp_link || { state: 'connected' };
    let { state, text } = classify(input);
    // A passing check proves the number can message, not that a restriction ended
    if (input.event === 'HEALTH_OK' && current.state === 'restricted') state = null;
    const changed = state && state !== current.state;
    // Restrictions/violations are separate incidents: alert each new one
    const alert = Boolean(changed || (state === 'restricted' && input.source === 'webhook'));
    if (changed) {
      await setSetting(client, 'whatsapp_link', { state, since: clock.now().toISOString(), reason: input.reason || input.error || input.event });
    }
    await client.query(
      `INSERT INTO whatsapp_link_events (source, event, reason, state, alerted, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.source, input.event, input.reason || input.error || null, state || 'unchanged', alert, input.details || null, clock.now()]);
    // Also by WhatsApp: it reaches the owner when the number can still send
    // (restrictions, recovery); when it cannot, the push alert from n8n does
    if (alert) await enqueue([{ to: 'owner', text }], client);
    return { state: state || current.state, changed: Boolean(changed), alert, text: alert ? text : null };
  });
}

async function linkStatus() {
  const settings = await getSettings();
  const { rows } = await pool.query('SELECT source, event, reason, state, alerted, created_at FROM whatsapp_link_events ORDER BY id DESC LIMIT 10');
  return { ...(settings.whatsapp_link || { state: 'connected' }), recent: rows };
}

module.exports = { recordLinkEvent, linkStatus, classify };
