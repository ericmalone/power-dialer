'use strict';

/**
 * Agent-facing JSON API. Everything here requires a signed-in user.
 */

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const engine = require('../dialer/engine');
const messenger = require('../sms/messenger');
const phone = require('../util/phone');
const { makeAccessToken, identityFor } = require('../twilioClient');

const router = express.Router();

router.use(auth.requireLogin);

function wrap(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: err.message || 'Something went wrong.' });
    }
  };
}

// --- identity ---------------------------------------------------------------

router.get('/me', wrap(async (req) => ({
  user: auth.publicUser(req.user),
  maxLines: Math.min(config.maxLinesPerAgent, req.user.max_lines || config.maxLinesPerAgent),
  twilioConfigured: config.twilioConfigured,
  recordCalls: config.recordCalls,
})));

router.get('/token', wrap(async (req) => {
  if (!config.twilioConfigured) {
    throw new Error('Twilio is not fully configured yet. Ask your administrator to finish setup.');
  }
  return { token: makeAccessToken(identityFor(req.user)), identity: identityFor(req.user) };
}));

// --- lists ------------------------------------------------------------------

router.get('/lists', wrap(async (req) => {
  const isAdmin = req.user.role === 'admin';
  const rows = isAdmin
    ? db.prepare('SELECT * FROM lists WHERE archived = 0 ORDER BY created_at DESC').all()
    : db
        .prepare(
          'SELECT l.* FROM lists l JOIN assignments a ON a.list_id = l.id ' +
            'WHERE a.user_id = ? AND l.archived = 0 ORDER BY l.created_at DESC'
        )
        .all(req.user.id);

  return {
    lists: rows.map((l) => {
      const c = db
        .prepare(
          "SELECT COUNT(*) total, " +
            "SUM(CASE WHEN status IN ('new','queued') THEN 1 ELSE 0 END) remaining, " +
            "SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done, " +
            "SUM(CASE WHEN phone IS NULL THEN 1 ELSE 0 END) invalid " +
            'FROM leads WHERE list_id = ?'
        )
        .get(l.id);
      return {
        id: l.id,
        name: l.name,
        createdAt: l.created_at,
        total: c.total || 0,
        remaining: c.remaining || 0,
        done: c.done || 0,
        invalid: c.invalid || 0,
      };
    }),
  };
}));

router.get('/dispositions', wrap(async () => ({
  dispositions: db.prepare('SELECT * FROM dispositions ORDER BY sort').all(),
})));

// --- dialer controls --------------------------------------------------------

router.get('/station', wrap(async (req) => engine.snapshot(req.user.id)));

router.post('/dialer/start', wrap(async (req) =>
  engine.start(req.user.id, { listId: Number(req.body.listId), lines: Number(req.body.lines) })
));

router.post('/dialer/pause', wrap(async (req) => engine.pause(req.user.id, req.body.reason || 'break')));
router.post('/dialer/resume', wrap(async (req) => engine.resume(req.user.id)));
router.post('/dialer/stop', wrap(async (req) => engine.stop(req.user.id)));
router.post('/dialer/lines', wrap(async (req) => engine.setLines(req.user.id, Number(req.body.lines))));
router.post('/dialer/offline', wrap(async (req) => {
  engine.agentOffline(req.user.id);
  return engine.snapshot(req.user.id);
}));

router.post('/dialer/hangup', wrap(async (req) => {
  await engine.hangupLead(req.user.id);
  return engine.snapshot(req.user.id);
}));

router.post('/dialer/dial-one', wrap(async (req) => engine.dialOne(req.user.id, Number(req.body.leadId))));

router.post('/disposition', wrap(async (req) =>
  engine.disposition(req.user.id, {
    callId: req.body.callId ? Number(req.body.callId) : null,
    code: req.body.code || '',
    notes: req.body.notes || '',
    callbackMinutes: Number(req.body.callbackMinutes) || 0,
  })
));

// --- leads ------------------------------------------------------------------

router.get('/leads/:id', wrap(async (req) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
  if (!lead) throw new Error('Lead not found.');
  const calls = db
    .prepare('SELECT * FROM calls WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(lead.id);
  return { lead: engine.leadPublic(lead), history: calls };
}));

router.post('/leads/:id/notes', wrap(async (req) => {
  db.prepare("UPDATE leads SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(
    String(req.body.notes || ''),
    Number(req.params.id)
  );
  return { ok: true };
}));

router.post('/leads/:id/dnc', wrap(async (req) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.params.id));
  if (!lead || !lead.phone) throw new Error('No phone number on that lead.');
  db.prepare('INSERT OR IGNORE INTO dnc (phone, reason, added_by) VALUES (?,?,?)').run(
    lead.phone,
    req.body.reason || 'Agent request',
    req.user.id
  );
  db.prepare("UPDATE leads SET status='dnc', locked_by=NULL WHERE id = ?").run(lead.id);
  return { ok: true };
}));

// Callbacks the agent owns.
router.get('/callbacks', wrap(async (req) => ({
  callbacks: db
    .prepare(
      "SELECT id, first_name, last_name, company, phone, next_attempt, notes FROM leads " +
        "WHERE worked_by = ? AND disposition = 'callback' AND status = 'queued' " +
        'ORDER BY next_attempt LIMIT 100'
    )
    .all(req.user.id)
    .map((l) => ({ ...l, phoneDisplay: phone.format(l.phone) })),
})));

// --- personal stats ---------------------------------------------------------

router.get('/my-stats', wrap(async (req) => {
  const today = db
    .prepare(
      "SELECT COUNT(*) calls, " +
        "SUM(CASE WHEN outcome='connected' THEN 1 ELSE 0 END) connects, " +
        'SUM(talk_seconds) talk ' +
        "FROM calls WHERE user_id = ? AND date(created_at) = date('now')"
    )
    .get(req.user.id);
  const byDisp = db
    .prepare(
      "SELECT disposition, COUNT(*) n FROM calls WHERE user_id = ? AND date(created_at) = date('now') " +
        "AND disposition <> '' GROUP BY disposition ORDER BY n DESC"
    )
    .all(req.user.id);
  return {
    today: { calls: today.calls || 0, connects: today.connects || 0, talkSeconds: today.talk || 0 },
    byDisposition: byDisp,
  };
}));

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

function ownsTemplate(user, tpl) {
  if (!tpl) return false;
  if (user.role === 'admin') return true;
  return tpl.owner_id === user.id;
}

router.get('/sms/setup', wrap(async (req) => ({
  enabled: config.sms.enabled,
  mergeFields: messenger.MERGE_FIELDS,
  maxPerBatch: config.sms.maxPerBatch,
  dailyCap: config.sms.dailyCapPerAgent,
  appendOptOut: config.sms.appendOptOut,
  optOutText: config.sms.optOutText,
  quietHours: config.sms.quietHours
    ? { start: config.callingHoursStart, end: config.callingHoursEnd }
    : null,
  sentToday: db
    .prepare("SELECT COUNT(*) c FROM messages WHERE user_id=? AND direction='outbound' AND date(created_at)=date('now')")
    .get(req.user.id).c,
})));

router.get('/sms/templates', wrap(async (req) => ({
  templates: messenger.templatesFor(req.user.id).map((t) => ({
    id: t.id,
    name: t.name,
    body: t.body,
    mine: t.owner_id === req.user.id,
    shared: !!t.shared || t.owner_id === null,
    segments: messenger.segmentCount(messenger.withOptOut(t.body)),
  })),
})));

router.post('/sms/templates', wrap(async (req) => {
  const name = String(req.body.name || '').trim();
  const body = String(req.body.body || '').trim();
  if (!name) throw new Error('Give the template a name.');
  if (!body) throw new Error('The message is empty.');
  if (body.length > 1400) throw new Error('That message is too long - keep it under 1400 characters.');
  const shared = req.user.role === 'admin' && req.body.shared ? 1 : 0;
  const info = db
    .prepare('INSERT INTO sms_templates (owner_id, name, body, shared) VALUES (?,?,?,?)')
    .run(shared ? null : req.user.id, name, body, shared);
  return { template: db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(info.lastInsertRowid) };
}));

router.patch('/sms/templates/:id', wrap(async (req) => {
  const tpl = db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(Number(req.params.id));
  if (!ownsTemplate(req.user, tpl)) throw new Error('That template belongs to someone else.');
  const name = req.body.name !== undefined ? String(req.body.name).trim() : tpl.name;
  const body = req.body.body !== undefined ? String(req.body.body).trim() : tpl.body;
  if (!name || !body) throw new Error('Name and message are both required.');
  db.prepare("UPDATE sms_templates SET name=?, body=?, updated_at=datetime('now') WHERE id=?").run(name, body, tpl.id);
  return { ok: true };
}));

router.delete('/sms/templates/:id', wrap(async (req) => {
  const tpl = db.prepare('SELECT * FROM sms_templates WHERE id = ?').get(Number(req.params.id));
  if (!ownsTemplate(req.user, tpl)) throw new Error('That template belongs to someone else.');
  db.prepare('UPDATE sms_templates SET archived = 1 WHERE id = ?').run(tpl.id);
  return { ok: true };
}));

/** What the lead will actually receive, plus segment count. */
router.post('/sms/preview', wrap(async (req) => {
  const lead = req.body.leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(req.body.leadId)) : null;
  const rendered = messenger.withOptOut(messenger.render(req.body.body || '', lead, req.user));
  return {
    text: rendered,
    characters: rendered.length,
    segments: messenger.segmentCount(rendered),
  };
}));

/** Send to one lead, or to a number typed by hand. */
router.post('/sms/send', wrap(async (req) => {
  const leadId = req.body.leadId ? Number(req.body.leadId) : null;
  const to = req.body.to ? phone.normalize(req.body.to) : null;
  if (!leadId && !to) throw new Error('Who is this going to?');
  if (req.body.to && !to) throw new Error('That does not look like a phone number.');

  let body = String(req.body.body || '');
  if (!body && req.body.templateId) {
    const tpl = db.prepare('SELECT body FROM sms_templates WHERE id = ?').get(Number(req.body.templateId));
    body = tpl ? tpl.body : '';
  }
  if (!body.trim()) throw new Error('The message is empty.');

  const res = messenger.enqueue({
    leadId,
    toNumber: to,
    body,
    userId: req.user.id,
    templateId: req.body.templateId ? Number(req.body.templateId) : null,
    callId: req.body.callId ? Number(req.body.callId) : null,
  });
  if (res && res.blocked) throw new Error(res.blocked);
  return { message: res, queued: 1 };
}));

/** Send the same message to many people at once. */
router.post('/sms/send-batch', wrap(async (req) => {
  const leadIds = Array.isArray(req.body.leadIds) ? req.body.leadIds : [];
  // Split on commas, semicolons and new lines only - a space is part of
  // "(212) 555-0198", not a separator.
  const numbers = Array.isArray(req.body.numbers)
    ? req.body.numbers
    : String(req.body.numbers || '')
        .split(/[,;\n\r\t]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  let body = String(req.body.body || '');
  if (!body && req.body.templateId) {
    const tpl = db.prepare('SELECT body FROM sms_templates WHERE id = ?').get(Number(req.body.templateId));
    body = tpl ? tpl.body : '';
  }
  if (!body.trim()) throw new Error('The message is empty.');
  if (!leadIds.length && !numbers.length) throw new Error('Pick at least one person.');

  return messenger.enqueueBatch({
    leadIds,
    numbers,
    body,
    templateId: req.body.templateId ? Number(req.body.templateId) : null,
    userId: req.user.id,
  });
}));

/** Candidates for a bulk send, filtered the way an agent thinks about them. */
router.get('/sms/recipients', wrap(async (req) => {
  const listId = Number(req.query.listId) || null;
  const scope = String(req.query.scope || 'no_answer');
  const isAdmin = req.user.role === 'admin';

  const clauses = ["l.phone IS NOT NULL", "l.status <> 'dnc'", "l.status <> 'invalid'"];
  const params = {};
  if (listId) {
    clauses.push('l.list_id = @listId');
    params.listId = listId;
  }
  if (!isAdmin) {
    clauses.push('EXISTS (SELECT 1 FROM assignments a WHERE a.list_id = l.list_id AND a.user_id = @uid)');
    params.uid = req.user.id;
  }

  if (scope === 'no_answer') {
    clauses.push("l.attempts > 0 AND l.status IN ('new','queued') AND l.disposition = ''");
  } else if (scope === 'spoke_to') {
    clauses.push("l.worked_by = @me AND l.disposition <> ''");
    params.me = req.user.id;
  } else if (scope === 'callbacks') {
    clauses.push("l.disposition = 'callback'");
  } else if (scope === 'my_leads') {
    clauses.push('l.worked_by = @me2');
    params.me2 = req.user.id;
  }
  // scope === 'everyone' adds nothing

  const rows = db
    .prepare(
      `SELECT l.id, l.first_name, l.last_name, l.company, l.phone, l.disposition, l.attempts
       FROM leads l WHERE ${clauses.join(' AND ')}
       ORDER BY l.row_index LIMIT 1000`
    )
    .all(params);

  return {
    recipients: rows.map((r) => ({
      ...r,
      phoneDisplay: phone.format(r.phone),
      optedOut: messenger.isOptedOut(r.phone),
    })),
  };
}));

router.get('/sms/thread/:leadId', wrap(async (req) => ({
  thread: messenger.threadFor(Number(req.params.leadId)),
})));

router.get('/sms/inbox', wrap(async (req) => {
  const rows = messenger.inboxFor(req.user.id);
  if (!req.query.peek) {
    db.prepare(
      "UPDATE messages SET read_at = datetime('now') WHERE direction='inbound' AND read_at IS NULL AND user_id = ?"
    ).run(req.user.id);
  }
  return {
    inbox: rows.map((m) => ({
      id: m.id,
      leadId: m.lead_id,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.company || '',
      from: m.from_number,
      fromDisplay: phone.format(m.from_number),
      body: m.body,
      at: m.created_at,
      unread: !m.read_at,
    })),
  };
}));

router.get('/sms/sent', wrap(async (req) => ({
  messages: db
    .prepare(
      "SELECT m.*, l.first_name, l.last_name, l.company FROM messages m LEFT JOIN leads l ON l.id = m.lead_id " +
        "WHERE m.user_id = ? AND m.direction='outbound' ORDER BY m.id DESC LIMIT 100"
    )
    .all(req.user.id),
})));

// --- auto-text rules the agent owns ----------------------------------------

const TRIGGERS = ['answered', 'no_answer', 'voicemail', 'abandoned', 'busy', 'disposition'];

router.get('/sms/rules', wrap(async (req) => ({
  triggers: TRIGGERS,
  rules: db
    .prepare(
      'SELECT r.*, t.name AS template_name FROM sms_rules r JOIN sms_templates t ON t.id = r.template_id ' +
        'WHERE r.owner_id = ? OR r.owner_id IS NULL ORDER BY r.owner_id IS NULL DESC, r.id'
    )
    .all(req.user.id)
    .map((r) => ({ ...r, mine: r.owner_id === req.user.id, global: r.owner_id === null })),
})));

router.post('/sms/rules', wrap(async (req) => {
  const trigger = String(req.body.trigger || '');
  if (!TRIGGERS.includes(trigger)) throw new Error('Pick when this should send.');
  const tpl = db.prepare('SELECT * FROM sms_templates WHERE id = ? AND archived = 0').get(Number(req.body.templateId));
  if (!tpl) throw new Error('Pick a template.');
  const forEveryone = req.user.role === 'admin' && req.body.forEveryone;

  const info = db
    .prepare(
      'INSERT INTO sms_rules (owner_id, template_id, trigger, disposition, list_id, delay_minutes, once_per_lead) ' +
        'VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      forEveryone ? null : req.user.id,
      tpl.id,
      trigger,
      trigger === 'disposition' ? String(req.body.disposition || '') : '',
      req.body.listId ? Number(req.body.listId) : null,
      Math.max(0, Math.min(10080, Number(req.body.delayMinutes) || 0)),
      req.body.oncePerLead === false ? 0 : 1
    );
  return { id: info.lastInsertRowid };
}));

router.patch('/sms/rules/:id', wrap(async (req) => {
  const rule = db.prepare('SELECT * FROM sms_rules WHERE id = ?').get(Number(req.params.id));
  if (!rule) throw new Error('Rule not found.');
  if (rule.owner_id !== req.user.id && req.user.role !== 'admin') throw new Error('That rule belongs to someone else.');
  db.prepare('UPDATE sms_rules SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, rule.id);
  return { ok: true };
}));

router.delete('/sms/rules/:id', wrap(async (req) => {
  const rule = db.prepare('SELECT * FROM sms_rules WHERE id = ?').get(Number(req.params.id));
  if (!rule) throw new Error('Rule not found.');
  if (rule.owner_id !== req.user.id && req.user.role !== 'admin') throw new Error('That rule belongs to someone else.');
  db.prepare('DELETE FROM sms_rules WHERE id = ?').run(rule.id);
  return { ok: true };
}));

module.exports = router;
