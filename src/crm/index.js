'use strict';

/**
 * CRM layer: the merchant record, the timeline, the pipeline.
 *
 * Everything that happens to a lead lands in `activities`, so one query gives
 * you the whole story of a deal - dials, texts, notes, stage moves, AI notes.
 */

const { db } = require('../db');
const phone = require('../util/phone');
const realtime = require('../realtime');
const stages = require('./stages');

// Deal fields a rep or the AI may write to.
const DEAL_FIELDS = {
  monthly_revenue: { label: 'Monthly revenue', type: 'money' },
  annual_revenue: { label: 'Annual revenue', type: 'money' },
  time_in_business_months: { label: 'Time in business (months)', type: 'int' },
  requested_amount: { label: 'Amount requested', type: 'money' },
  approved_amount: { label: 'Amount approved', type: 'money' },
  funded_amount: { label: 'Amount funded', type: 'money' },
  factor_rate: { label: 'Factor rate', type: 'float' },
  industry: { label: 'Industry', type: 'text' },
  entity_state: { label: 'State', type: 'text' },
  open_positions: { label: 'Open positions', type: 'int' },
  fico: { label: 'FICO', type: 'int' },
  use_of_funds: { label: 'Use of funds', type: 'text' },
  nsf_count: { label: 'NSFs last 90 days', type: 'int' },
  avg_daily_balance: { label: 'Average daily balance', type: 'money' },
  lost_reason: { label: 'Reason lost', type: 'text' },
};

function coerce(field, raw) {
  const spec = DEAL_FIELDS[field];
  if (!spec) return undefined;
  if (raw === null || raw === '' || raw === undefined) return null;
  if (spec.type === 'text') return String(raw).slice(0, 400);
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return undefined;
  if (spec.type === 'int') return Math.round(n);
  return n;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function logActivity({ leadId, userId = null, kind, title = '', body = '', callId = null, messageId = null, meta = {} }) {
  if (!leadId) return null;
  const info = db
    .prepare(
      'INSERT INTO activities (lead_id,user_id,kind,title,body,call_id,message_id,meta_json) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(leadId, userId, kind, title, body, callId, messageId, JSON.stringify(meta || {}));
  if (kind === 'call' || kind === 'sms_in' || kind === 'sms_out') {
    db.prepare("UPDATE leads SET last_contact_at = datetime('now') WHERE id = ?").run(leadId);
  }
  return info.lastInsertRowid;
}

function timeline(leadId, limit = 200) {
  const rows = db
    .prepare(
      'SELECT a.*, u.name AS user_name, u.email AS user_email FROM activities a ' +
        'LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.id DESC LIMIT ?'
    )
    .all(leadId, limit);
  return rows.map((r) => {
    let meta = {};
    try {
      meta = JSON.parse(r.meta_json || '{}');
    } catch {
      meta = {};
    }
    return { ...r, meta, who: r.user_name || r.user_email || 'System' };
  });
}

// ---------------------------------------------------------------------------
// The merchant record
// ---------------------------------------------------------------------------

function leadRecord(leadId) {
  const lead = db
    .prepare(
      'SELECT l.*, li.name AS list_name, u.name AS owner_name, u.email AS owner_email ' +
        'FROM leads l LEFT JOIN lists li ON li.id = l.list_id LEFT JOIN users u ON u.id = l.owner_id WHERE l.id = ?'
    )
    .get(leadId);
  if (!lead) return null;

  let extra = {};
  try {
    extra = JSON.parse(lead.extra_json || '{}');
  } catch {
    extra = {};
  }

  const calls = db
    .prepare(
      'SELECT c.*, u.name AS agent_name FROM calls c LEFT JOIN users u ON u.id = c.user_id ' +
        'WHERE c.lead_id = ? ORDER BY c.id DESC LIMIT 100'
    )
    .all(leadId);
  const msgs = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 100').all(leadId);
  const notes = db
    .prepare('SELECT * FROM ai_notes WHERE lead_id = ? ORDER BY id DESC LIMIT 40')
    .all(leadId)
    .map(parseAiNote);
  const openTasks = db
    .prepare("SELECT * FROM tasks WHERE lead_id = ? AND status = 'open' ORDER BY due_at")
    .all(leadId);

  const talk = calls.reduce((a, c) => a + (c.talk_seconds || 0), 0);
  const connects = calls.filter((c) => c.outcome === 'connected').length;

  return {
    ...lead,
    extra,
    phoneDisplay: phone.format(lead.phone),
    timezone: lead.timezone,
    localHour: phone.localHour(lead.phone),
    stageInfo: stages.stage(lead.stage),
    qualification: stages.qualify(lead),
    calls,
    messages: msgs,
    aiNotes: notes,
    openTasks,
    stats: { dials: calls.length, connects, talkSeconds: talk, texts: msgs.length },
    timeline: timeline(leadId),
  };
}

function parseAiNote(n) {
  const safe = (s, dflt) => {
    try {
      return JSON.parse(s);
    } catch {
      return dflt;
    }
  };
  return {
    ...n,
    objections: safe(n.objections, []),
    extracted: safe(n.extracted_json, {}),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function setStage(leadId, code, userId, { reason = '' } = {}) {
  if (!stages.isStage(code)) throw new Error('That is not a pipeline stage.');
  const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error('Lead not found.');
  if (lead.stage === code) return lead.stage;

  db.prepare("UPDATE leads SET stage = ?, stage_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(
    code,
    leadId
  );
  if (reason) db.prepare('UPDATE leads SET lost_reason = ? WHERE id = ?').run(reason, leadId);

  logActivity({
    leadId,
    userId,
    kind: 'stage',
    title: `${stages.stage(lead.stage).label} → ${stages.stage(code).label}`,
    body: reason,
    meta: { from: lead.stage, to: code },
  });
  realtime.toAdmins('crm:stage', { leadId, from: lead.stage, to: code });
  return code;
}

/** Only moves a deal forward, and never off a stage a human already set. */
function advanceStage(leadId, code, userId) {
  const lead = db.prepare('SELECT stage FROM leads WHERE id = ?').get(leadId);
  if (!lead || !stages.isStage(code)) return;
  if (stages.isClosed(lead.stage)) return;
  const from = stages.stage(lead.stage);
  const to = stages.stage(code);
  if (to.order <= from.order && to.kind === 'open') return;
  setStage(leadId, code, userId);
}

function setFields(leadId, fields, userId, { source = 'rep', onlyIfEmpty = false } = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error('Lead not found.');

  const sets = [];
  const vals = [];
  const changed = [];

  for (const [key, raw] of Object.entries(fields || {})) {
    if (!(key in DEAL_FIELDS)) continue;
    const value = coerce(key, raw);
    if (value === undefined) continue;
    const current = lead[key];
    if (onlyIfEmpty && current !== null && current !== undefined && current !== '') continue;
    if (String(current ?? '') === String(value ?? '')) continue;
    sets.push(`${key} = ?`);
    vals.push(value);
    changed.push({ field: key, label: DEAL_FIELDS[key].label, from: current, to: value });
  }

  if (!sets.length) return { changed: [] };

  db.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, leadId);

  logActivity({
    leadId,
    userId,
    kind: 'field',
    title: source === 'ai' ? 'AI filled in deal details' : 'Deal details updated',
    body: changed.map((c) => `${c.label}: ${format(c.to, c.field)}`).join(', '),
    meta: { changed, source },
  });

  return { changed };
}

function format(v, field) {
  if (v === null || v === undefined || v === '') return '-';
  const spec = DEAL_FIELDS[field];
  if (spec && spec.type === 'money') return `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return String(v);
}

function addNote(leadId, userId, body) {
  const text = String(body || '').trim();
  if (!text) throw new Error('The note is empty.');
  logActivity({ leadId, userId, kind: 'note', title: 'Note', body: text });
  db.prepare("UPDATE leads SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(text, leadId);
  return true;
}

function assignOwner(leadId, ownerId, byUserId) {
  const owner = ownerId ? db.prepare('SELECT name,email FROM users WHERE id = ?').get(ownerId) : null;
  db.prepare("UPDATE leads SET owner_id = ?, updated_at = datetime('now') WHERE id = ?").run(ownerId || null, leadId);
  logActivity({
    leadId,
    userId: byUserId,
    kind: 'system',
    title: owner ? `Assigned to ${owner.name || owner.email}` : 'Unassigned',
  });
}

// ---------------------------------------------------------------------------
// Search / lists
// ---------------------------------------------------------------------------

/**
 * The main CRM query. Everything is optional; an agent only ever sees leads on
 * lists assigned to them unless they are an admin.
 */
function search({ user, q = '', stage = '', ownerId = null, listId = null, mine = false, sort = 'recent', limit = 100, offset = 0 }) {
  const where = ['1=1'];
  const params = {};

  if (user.role !== 'admin') {
    where.push(
      '(l.owner_id = @uid OR EXISTS (SELECT 1 FROM assignments a WHERE a.list_id = l.list_id AND a.user_id = @uid))'
    );
    params.uid = user.id;
  }
  if (mine) {
    where.push('l.owner_id = @me');
    params.me = user.id;
  }
  if (stage) {
    if (stage === 'open') where.push("l.stage NOT IN ('funded','declined','dead')");
    else {
      where.push('l.stage = @stage');
      params.stage = stage;
    }
  }
  if (ownerId) {
    where.push('l.owner_id = @owner');
    params.owner = Number(ownerId);
  }
  if (listId) {
    where.push('l.list_id = @list');
    params.list = Number(listId);
  }
  if (q) {
    const term = String(q).trim();
    const digits = term.replace(/\D/g, '');
    where.push(
      '(l.first_name LIKE @like OR l.last_name LIKE @like OR l.company LIKE @like OR l.email LIKE @like' +
        (digits.length >= 4 ? ' OR l.phone LIKE @digits' : '') +
        ')'
    );
    params.like = `%${term}%`;
    if (digits.length >= 4) params.digits = `%${digits}%`;
  }

  const order =
    sort === 'value'
      ? 'COALESCE(l.approved_amount, l.requested_amount, 0) DESC, l.updated_at DESC'
      : sort === 'stage'
      ? 'l.stage, l.updated_at DESC'
      : sort === 'attempts'
      ? 'l.attempts DESC, l.updated_at DESC'
      : 'COALESCE(l.last_contact_at, l.updated_at) DESC';

  const rows = db
    .prepare(
      `SELECT l.*, li.name AS list_name, u.name AS owner_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.lead_id = l.id AND t.status='open') AS open_tasks,
        (SELECT summary FROM ai_notes n WHERE n.lead_id = l.id AND n.status='ready' ORDER BY n.id DESC LIMIT 1) AS last_ai_summary
       FROM leads l
       LEFT JOIN lists li ON li.id = l.list_id
       LEFT JOIN users u ON u.id = l.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${order} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: Math.min(500, limit), offset });

  const total = db
    .prepare(`SELECT COUNT(*) c FROM leads l WHERE ${where.join(' AND ')}`)
    .get(params).c;

  return {
    total,
    leads: rows.map((l) => ({
      ...l,
      phoneDisplay: phone.format(l.phone),
      stageInfo: stages.stage(l.stage),
      qualification: stages.qualify(l),
    })),
  };
}

/** Deal counts and dollars by stage, for the pipeline board. */
function pipeline({ user, ownerId = null, listId = null }) {
  const where = ['1=1'];
  const params = {};
  if (user.role !== 'admin') {
    where.push(
      '(l.owner_id = @uid OR EXISTS (SELECT 1 FROM assignments a WHERE a.list_id = l.list_id AND a.user_id = @uid))'
    );
    params.uid = user.id;
  }
  if (ownerId) {
    where.push('l.owner_id = @owner');
    params.owner = Number(ownerId);
  }
  if (listId) {
    where.push('l.list_id = @list');
    params.list = Number(listId);
  }

  const rows = db
    .prepare(
      `SELECT l.stage, COUNT(*) n, SUM(COALESCE(l.approved_amount, l.requested_amount, 0)) value
       FROM leads l WHERE ${where.join(' AND ')} GROUP BY l.stage`
    )
    .all(params);
  const byStage = new Map(rows.map((r) => [r.stage, r]));

  return stages.STAGES.map((s) => {
    const r = byStage.get(s.code);
    return { ...s, count: r ? r.n : 0, value: r ? r.value || 0 : 0 };
  });
}

module.exports = {
  DEAL_FIELDS,
  logActivity,
  timeline,
  leadRecord,
  parseAiNote,
  setStage,
  advanceStage,
  setFields,
  addNote,
  assignOwner,
  search,
  pipeline,
  stages,
  format,
};
