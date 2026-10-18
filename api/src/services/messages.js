const { withTx } = require('../db');
const clock = require('../clock');
const { upsertLead } = require('./leads');

const OPT_OUT = /^(stop|unsubscribe)$/i;

// Logs one WhatsApp message and keeps the lead's timestamps current.
// Meta retries webhooks, so a repeated wa_message_id is reported as a duplicate
// and WF1 stops there instead of replying twice.
async function logMessage(input) {
  return withTx(async (client) => {
    if (input.wa_message_id) {
      const dup = await client.query('SELECT 1 FROM messages WHERE wa_message_id = $1', [input.wa_message_id]);
      if (dup.rowCount) return { duplicate: true };
    }
    const lead = await upsertLead(client, input.phone, { name: input.name });
    const now = clock.now();

    const ins = await client.query(
      `INSERT INTO messages (lead_id, direction, wa_message_id, kind, template_name, body, raw, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
      [lead.id, input.direction, input.wa_message_id || null, input.kind || 'text',
        input.template_name || null, input.body || null, input.raw || null, now],
    );
    if (!ins.rowCount) return { duplicate: true };

    const updates = input.direction === 'in' ? { last_inbound_at: now } : { last_outbound_at: now };
    if (input.direction === 'in' && input.referral && !lead.ad_ref) {
      updates.ad_ref = input.referral;
      updates.source = 'ad';
    } else if (input.direction === 'in' && lead.inserted && !lead.source) {
      updates.source = 'organic';
    }
    if (input.direction === 'in' && OPT_OUT.test((input.body || '').trim())) updates.opted_out = true;
    const keys = Object.keys(updates);
    const { rows } = await client.query(
      `UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [lead.id, ...keys.map((k) => updates[k])],
    );
    const l = rows[0];
    return {
      duplicate: false,
      is_new_lead: lead.inserted,
      bot_paused: l.bot_paused_at != null,
      opted_out: l.opted_out,
      lead: { id: l.id, phone: l.phone, name: l.name, intent: l.intent, stage: l.stage },
    };
  });
}

module.exports = { logMessage };
