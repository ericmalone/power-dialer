'use strict';

/**
 * Text messaging.
 *
 * Everything goes through a queue table rather than straight to Twilio, so
 * that quiet hours, per-agent daily caps and carrier-friendly drip rates all
 * work the same way whether a message was typed by an agent, fired by a rule,
 * or blasted to 200 leads at once.
 */

const { db, settings } = require('../db');
const config = require('../config');
const phone = require('../util/phone');
const realtime = require('../realtime');
const { getClient } = require('../twilioClient');

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'revoke'];
const START_WORDS = ['start', 'unstop', 'yes', 'subscribe', 'optin', 'opt-in'];

let batchCounter = 0;
let flushing = null;

// ---------------------------------------------------------------------------
// Merge fields
// ---------------------------------------------------------------------------

const MERGE_FIELDS = [
  { token: 'first_name', label: "Lead's first name" },
  { token: 'last_name', label: "Lead's last name" },
  { token: 'full_name', label: "Lead's full name" },
  { token: 'business', label: 'Their business / company' },
  { token: 'phone', label: "Lead's phone number" },
  { token: 'email', label: "Lead's email" },
  { token: 'agent_name', label: 'Your full name' },
  { token: 'agent_first_name', label: 'Your first name' },
  { token: 'agent_email', label: 'Your email' },
  { token: 'company_name', label: 'Your company name' },
];

function mergeValues(lead, user) {
  const first = (lead && lead.first_name) || '';
  const last = (lead && lead.last_name) || '';
  const agentName = (user && (user.name || user.email)) || '';
  let extra = {};
  try {
    extra = JSON.parse((lead && lead.extra_json) || '{}');
  } catch {
    extra = {};
  }

  const base = {
    first_name: first || 'there',
    last_name: last,
    full_name: [first, last].filter(Boolean).join(' ') || 'there',
    business: (lead && lead.company) || 'your business',
    phone: phone.format(lead && lead.phone),
    email: (lead && lead.email) || '',
    agent_name: agentName,
    agent_first_name: agentName.split(/\s+/)[0] || agentName,
    agent_email: (user && user.email) || '',
    company_name: config.companyName,
  };

  // Any spare spreadsheet column is usable too: {{Requested Amount}}
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in base)) base[k] = String(v);
  }
  return base;
}

/** Replace {{token}} with values. Unknown tokens collapse to an empty string. */
function render(body, lead, user) {
  const values = mergeValues(lead, user);
  return String(body || '')
    .replace(/\{\{\s*([\w \-]+?)\s*\}\}/g, (_m, token) => {
      if (token in values) return values[token];
      const ci = Object.keys(values).find((k) => k.toLowerCase() === token.toLowerCase());
      return ci ? values[ci] : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * The GSM-7 alphabet. Anything outside it forces the whole message into UCS-2,
 * which halves how much fits in a segment - one stray curly quote doubles the
 * bill on a long text.
 */
const GSM_CHARS =
  /^[@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !"#\u00a4%&'()*+,\-./0-9:;<=>?\u00a1A-Z\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfa-z\u00e4\u00f6\u00f1\u00fc\u00e0\f^{}\\\[~\]|\u20ac]*$/;

/** GSM-7 vs UCS-2 segment maths, so agents can see what a message will cost. */
function segmentCount(text) {
  const s = String(text || '');
  if (!s) return 0;
  const nonGsm = !GSM_CHARS.test(s);
  if (nonGsm) return s.length <= 70 ? 1 : Math.ceil(s.length / 67);
  return s.length <= 160 ? 1 : Math.ceil(s.length / 153);
}

function withOptOut(text) {
  if (!config.sms.appendOptOut) return text;
  const t = String(text || '');
  if (/\bstop\b/i.test(t)) return t;
  return `${t} ${config.sms.optOutText}`.trim();
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isOptedOut(e164) {
  return Boolean(db.prepare('SELECT 1 FROM sms_optouts WHERE phone = ?').get(e164));
}

function isOnDnc(e164) {
  return Boolean(db.prepare('SELECT 1 FROM dnc WHERE phone = ?').get(e164));
}

function sentToday(userId) {
  return db
    .prepare(
      "SELECT COUNT(*) c FROM messages WHERE user_id = ? AND direction='outbound' AND date(created_at) = date('now')"
    )
    .get(userId).c;
}

/**
 * Decide whether a message can go out now, later, or not at all.
 * Returns { ok, reason, sendAfter }.
 */
function screen(e164, { respectQuietHours = true } = {}) {
  if (!config.sms.enabled) return { ok: false, reason: 'Texting is switched off in this install.' };
  if (!e164) return { ok: false, reason: 'No phone number.' };
  if (!phone.validate(e164).ok) return { ok: false, reason: 'Not a textable number.' };
  if (isOptedOut(e164)) return { ok: false, reason: 'They replied STOP.' };
  if (isOnDnc(e164)) return { ok: false, reason: 'On the Do Not Call list.' };

  if (respectQuietHours && config.sms.quietHours) {
    const hours = phone.withinCallingHours(e164, config.callingHoursStart, config.callingHoursEnd);
    if (!hours.ok) return { ok: true, reason: 'quiet_hours', sendAfter: nextWindow(e164) };
  }
  return { ok: true, reason: null, sendAfter: null };
}

/** ISO timestamp of the next moment it is legal to text this number. */
function nextWindow(e164) {
  const now = new Date();
  for (let i = 1; i <= 48; i++) {
    const t = new Date(now.getTime() + i * 30 * 60 * 1000);
    if (phone.withinCallingHours(e164, config.callingHoursStart, config.callingHoursEnd, t).ok) {
      return t.toISOString();
    }
  }
  return new Date(now.getTime() + 12 * 3600 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Sending numbers
// ---------------------------------------------------------------------------

/**
 * Keep a lead's whole thread on one number so replies make sense, and prefer a
 * number local to them - see dialer/callerId.js for the order of preference.
 */
function pickFromNumber(e164, leadId = null) {
  if (config.twilio.messagingServiceSid) return null; // the service picks for us

  // A thread already under way stays on whatever number started it.
  const prior = db
    .prepare("SELECT from_number FROM messages WHERE to_number = ? AND direction='outbound' AND from_number <> '' ORDER BY id DESC LIMIT 1")
    .get(e164);
  if (prior && prior.from_number) {
    const stillActive = db
      .prepare('SELECT 1 x FROM caller_ids WHERE phone = ? AND active = 1 AND sms_capable = 1')
      .get(prior.from_number);
    if (stillActive) return prior.from_number;
  }

  // An explicitly pinned sending number wins over local matching.
  const preferred = settings.get('sms_from_number', '');
  if (preferred) {
    const ok = db.prepare('SELECT 1 x FROM caller_ids WHERE phone = ? AND active = 1 AND sms_capable = 1').get(preferred);
    if (ok) return preferred;
  }

  const choice = require('../dialer/callerId').pick({ toNumber: e164, leadId, smsOnly: true });
  return choice ? choice.phone : null;
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Put one message on the queue. Does not touch Twilio - flush() does that.
 * Returns the row, or a { blocked: reason } object.
 */
function enqueue({ leadId, toNumber, body, userId, templateId = null, ruleId = null, callId = null, batchId = '', delayMinutes = 0, respectQuietHours = true }) {
  const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null;
  const user = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
  const to = toNumber || (lead && lead.phone);

  const verdict = screen(to, { respectQuietHours });
  if (!verdict.ok) {
    const row = db
      .prepare(
        "INSERT INTO messages (direction, lead_id, user_id, call_id, template_id, rule_id, batch_id, to_number, body, status, error) " +
          "VALUES ('outbound',?,?,?,?,?,?,?,?,'blocked',?)"
      )
      .run(leadId || null, userId || null, callId, templateId, ruleId, batchId, to || '', '', verdict.reason);
    return { blocked: verdict.reason, id: row.lastInsertRowid };
  }

  if (userId && sentToday(userId) >= config.sms.dailyCapPerAgent) {
    return { blocked: `Daily text limit reached (${config.sms.dailyCapPerAgent}).` };
  }

  const finalBody = withOptOut(render(body, lead, user));
  if (!finalBody) return { blocked: 'The message is empty.' };

  let sendAfter = verdict.sendAfter;
  if (delayMinutes > 0) {
    const base = sendAfter ? new Date(sendAfter) : new Date();
    const delayed = new Date(base.getTime() + delayMinutes * 60000);
    sendAfter = phone.withinCallingHours(to, config.callingHoursStart, config.callingHoursEnd, delayed).ok || !config.sms.quietHours
      ? delayed.toISOString()
      : nextWindow(to);
  }

  const info = db
    .prepare(
      'INSERT INTO messages (direction, lead_id, user_id, call_id, template_id, rule_id, batch_id, from_number, to_number, body, segments, status, send_after) ' +
        "VALUES ('outbound',?,?,?,?,?,?,?,?,?,?,'queued',?)"
    )
    .run(
      leadId || null,
      userId || null,
      callId,
      templateId,
      ruleId,
      batchId,
      pickFromNumber(to, leadId) || '',
      to,
      finalBody,
      segmentCount(finalBody),
      sendAfter
    );

  scheduleFlush();
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

/** Send the same template to many leads, dripped out at a carrier-safe rate. */
function enqueueBatch({ leadIds = [], numbers = [], body, templateId = null, userId }) {
  const batchId = `sms${++batchCounter}-${userId}`;
  const targets = [];

  for (const id of leadIds.slice(0, config.sms.maxPerBatch)) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
    if (lead && lead.phone) targets.push({ leadId: lead.id, to: lead.phone });
  }
  for (const raw of numbers.slice(0, config.sms.maxPerBatch)) {
    const e164 = phone.normalize(raw);
    if (!e164) continue;
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1').get(e164);
    targets.push({ leadId: lead ? lead.id : null, to: e164 });
  }

  const seen = new Set();
  const unique = targets.filter((t) => {
    if (seen.has(t.to)) return false;
    seen.add(t.to);
    return true;
  });

  const results = { batchId, queued: 0, blocked: [], total: unique.length };
  let slot = 0;
  for (const t of unique) {
    // Drip: spread the batch out so carriers do not see a burst.
    const offsetMs = Math.floor(slot / config.sms.perSecond) * 1000;
    slot++;
    const res = enqueue({
      leadId: t.leadId,
      toNumber: t.to,
      body,
      userId,
      templateId,
      batchId,
      respectQuietHours: true,
    });
    if (res && res.blocked) {
      results.blocked.push({ to: t.to, reason: res.blocked });
    } else {
      results.queued++;
      if (offsetMs > 0) {
        const when = new Date(Date.now() + offsetMs).toISOString();
        db.prepare('UPDATE messages SET send_after = COALESCE(MAX(send_after, ?), ?) WHERE id = ?').run(when, when, res.id);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// The sender loop
// ---------------------------------------------------------------------------

function scheduleFlush() {
  if (flushing) return;
  flushing = setTimeout(() => {
    flushing = null;
    flush().catch((err) => console.error('[sms] flush', err));
  }, 250);
  if (flushing.unref) flushing.unref();
}

async function flush() {
  const due = db
    .prepare(
      "SELECT * FROM messages WHERE direction='outbound' AND status='queued' " +
        "AND (send_after IS NULL OR send_after <= ?) ORDER BY id LIMIT ?"
    )
    .all(new Date().toISOString(), config.sms.perSecond * 5);

  if (!due.length) return;

  let client;
  try {
    client = getClient();
  } catch (err) {
    for (const m of due) {
      db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(err.message, m.id);
    }
    return;
  }

  for (const m of due) {
    db.prepare("UPDATE messages SET status='sending' WHERE id=?").run(m.id);
    try {
      const params = {
        to: m.to_number,
        body: m.body,
        statusCallback: `${config.publicUrl}/webhooks/sms-status`,
      };
      if (config.twilio.messagingServiceSid) {
        params.messagingServiceSid = config.twilio.messagingServiceSid;
      } else {
        const from = m.from_number || pickFromNumber(m.to_number, m.lead_id);
        if (!from) throw new Error('No SMS-capable number configured. Add one in Admin > Numbers.');
        params.from = from;
      }

      const sent = await client.messages.create(params);
      db.prepare(
        "UPDATE messages SET message_sid=?, status='sent', from_number=COALESCE(NULLIF(?,''), from_number), sent_at=datetime('now') WHERE id=?"
      ).run(sent.sid, sent.from || params.from || '', m.id);

      if (m.lead_id) {
        try {
          require('../crm').logActivity({
            leadId: m.lead_id,
            userId: m.user_id,
            kind: 'sms_out',
            title: m.rule_id ? 'Auto-text sent' : 'Text sent',
            body: m.body,
            messageId: m.id,
          });
        } catch {
          /* the timeline must never block a send */
        }
      }
      if (m.user_id) realtime.toUser(m.user_id, 'sms:sent', { id: m.id, to: m.to_number, leadId: m.lead_id });
    } catch (err) {
      db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(
        String(err && err.message ? err.message : err).slice(0, 400),
        m.id
      );
      if (m.user_id) realtime.toUser(m.user_id, 'toast', { kind: 'bad', text: `Text to ${m.to_number} failed: ${err.message}` });
    }
  }

  const more = db
    .prepare("SELECT COUNT(*) c FROM messages WHERE direction='outbound' AND status='queued' AND (send_after IS NULL OR send_after <= ?)")
    .get(new Date().toISOString()).c;
  if (more) scheduleFlush();
}

/** Called on a timer so delayed / quiet-hour messages eventually go out. */
function tick() {
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Fire any auto-text rules matching a finished call.
 * `trigger` is one of: answered | no_answer | voicemail | abandoned | busy | disposition
 */
function runRules({ trigger, disposition = '', leadId, userId, callId, listId }) {
  if (!config.sms.enabled || !leadId) return [];

  const rules = db
    .prepare(
      'SELECT r.*, t.body, t.name FROM sms_rules r JOIN sms_templates t ON t.id = r.template_id ' +
        'WHERE r.active = 1 AND t.archived = 0 AND r.trigger = ? ' +
        'AND (r.owner_id IS NULL OR r.owner_id = ?) ' +
        'AND (r.list_id IS NULL OR r.list_id = ?)'
    )
    .all(trigger, userId || -1, listId || -1);

  const fired = [];
  for (const rule of rules) {
    if (trigger === 'disposition' && rule.disposition && rule.disposition !== disposition) continue;

    if (rule.once_per_lead) {
      const already = db
        .prepare("SELECT 1 FROM messages WHERE lead_id = ? AND rule_id = ? AND status <> 'blocked'")
        .get(leadId, rule.id);
      if (already) continue;
    }

    const res = enqueue({
      leadId,
      body: rule.body,
      userId,
      templateId: rule.template_id,
      ruleId: rule.id,
      callId,
      delayMinutes: rule.delay_minutes,
    });
    fired.push({ rule: rule.name, blocked: res && res.blocked ? res.blocked : null });
  }

  if (fired.length && userId) {
    const sent = fired.filter((f) => !f.blocked);
    if (sent.length) {
      realtime.toUser(userId, 'toast', {
        kind: 'ok',
        text: `Auto-text queued: ${sent.map((f) => f.rule).join(', ')}`,
      });
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/** Handle a reply from a lead. Returns { optOut, optIn, leadId }. */
function receive({ messageSid, from, to, body }) {
  const e164 = phone.normalize(from) || from;
  const text = String(body || '').trim();
  const word = text.toLowerCase().replace(/[^a-z-]/g, '');

  const lead = db.prepare('SELECT * FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1').get(e164);
  const owner = lead && lead.worked_by ? lead.worked_by : null;

  db.prepare(
    "INSERT OR IGNORE INTO messages (message_sid, direction, lead_id, user_id, from_number, to_number, body, status, sent_at) " +
      "VALUES (?,'inbound',?,?,?,?,?,'received',datetime('now'))"
  ).run(messageSid, lead ? lead.id : null, owner, e164, to || '', text);

  let optOut = false;
  let optIn = false;

  if (STOP_WORDS.includes(word)) {
    db.prepare('INSERT OR IGNORE INTO sms_optouts (phone, keyword) VALUES (?,?)').run(e164, word);
    db.prepare("INSERT OR IGNORE INTO dnc (phone, reason) VALUES (?, 'Replied STOP to a text')").run(e164);
    if (lead) db.prepare("UPDATE leads SET status='dnc', locked_by=NULL WHERE id=?").run(lead.id);
    // Cancel anything still queued for them.
    db.prepare("UPDATE messages SET status='blocked', error='They replied STOP.' WHERE to_number=? AND status='queued'").run(e164);
    optOut = true;
  } else if (START_WORDS.includes(word)) {
    db.prepare('DELETE FROM sms_optouts WHERE phone = ?').run(e164);
    optIn = true;
  }

  if (lead) {
    try {
      require('../crm').logActivity({
        leadId: lead.id,
        userId: owner,
        kind: 'sms_in',
        title: optOut ? 'Replied STOP' : 'Texted back',
        body: text,
      });
      if (optOut) require('../crm').setStage(lead.id, 'dead', owner, { reason: 'Do not call' });
    } catch {
      /* best effort */
    }
  }

  const payload = {
    leadId: lead ? lead.id : null,
    from: e164,
    fromDisplay: phone.format(e164),
    name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company : '',
    body: text,
    optOut,
  };
  if (owner) {
    realtime.toUser(owner, 'sms:received', payload);
    realtime.toUser(owner, 'toast', {
      kind: optOut ? 'warn' : 'ok',
      text: optOut ? `${payload.name || payload.fromDisplay} opted out of texts.` : `Reply from ${payload.name || payload.fromDisplay}`,
    });
  }
  realtime.toAdmins('sms:received', payload);

  return { optOut, optIn, leadId: lead ? lead.id : null };
}

function updateStatus({ messageSid, status, errorMessage }) {
  const map = { sent: 'sent', delivered: 'delivered', undelivered: 'undelivered', failed: 'failed' };
  const next = map[status] || status;
  db.prepare('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE message_sid = ?').run(
    next,
    errorMessage || null,
    messageSid
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function templatesFor(userId) {
  return db
    .prepare(
      'SELECT * FROM sms_templates WHERE archived = 0 AND (owner_id = ? OR owner_id IS NULL OR shared = 1) ' +
        'ORDER BY (owner_id IS NULL), name'
    )
    .all(userId);
}

function threadFor(leadId, limit = 50) {
  return db
    .prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT ?')
    .all(leadId, limit)
    .reverse();
}

function inboxFor(userId, limit = 40) {
  return db
    .prepare(
      'SELECT m.*, l.first_name, l.last_name, l.company FROM messages m ' +
        'LEFT JOIN leads l ON l.id = m.lead_id ' +
        "WHERE m.direction='inbound' AND (m.user_id = ? OR m.user_id IS NULL) " +
        'ORDER BY m.id DESC LIMIT ?'
    )
    .all(userId, limit);
}

module.exports = {
  MERGE_FIELDS,
  render,
  segmentCount,
  withOptOut,
  screen,
  nextWindow,
  isOptedOut,
  pickFromNumber,
  enqueue,
  enqueueBatch,
  flush,
  tick,
  runRules,
  receive,
  updateStatus,
  templatesFor,
  threadFor,
  inboxFor,
  STOP_WORDS,
  START_WORDS,
};
