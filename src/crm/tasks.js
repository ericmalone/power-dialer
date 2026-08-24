'use strict';

/**
 * Callbacks and follow-ups. A task is always owned by one rep and (almost
 * always) attached to one merchant.
 */

const { db } = require('../db');
const realtime = require('../realtime');
const crm = require('./index');

const KINDS = {
  callback: 'Call back',
  follow_up: 'Follow up',
  docs: 'Chase documents',
  other: 'To do',
};

function toIso(when) {
  if (when instanceof Date) return when.toISOString();
  if (typeof when === 'number') return new Date(Date.now() + when * 60000).toISOString();
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error('That is not a valid date and time.');
  return d.toISOString();
}

function create({ leadId, userId, kind = 'callback', dueAt, minutesFromNow = null, note = '', title = '', createdBy = null }) {
  const due = minutesFromNow !== null && minutesFromNow !== undefined ? toIso(Number(minutesFromNow)) : toIso(dueAt);
  const lead = leadId ? db.prepare('SELECT first_name,last_name,company FROM leads WHERE id = ?').get(leadId) : null;
  const who = lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company : '';

  const info = db
    .prepare('INSERT INTO tasks (lead_id,user_id,kind,title,note,due_at,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(leadId || null, userId, kind, title || `${KINDS[kind] || 'To do'}${who ? ` - ${who}` : ''}`, note, due, createdBy || userId);

  if (leadId) {
    crm.logActivity({
      leadId,
      userId,
      kind: 'task',
      title: `${KINDS[kind] || 'To do'} scheduled`,
      body: `${new Date(due).toLocaleString('en-US')}${note ? ` - ${note}` : ''}`,
      meta: { taskId: info.lastInsertRowid, dueAt: due },
    });
  }

  const row = get(info.lastInsertRowid);
  realtime.toUser(userId, 'task:created', row);
  return row;
}

function get(id) {
  return db
    .prepare(
      'SELECT t.*, l.first_name, l.last_name, l.company, l.phone, l.stage FROM tasks t ' +
        'LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?'
    )
    .get(id);
}

function complete(id, userId, { outcome = '' } = {}) {
  const t = get(id);
  if (!t) throw new Error('That task no longer exists.');
  if (t.user_id !== userId) {
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!u || u.role !== 'admin') throw new Error('That task belongs to someone else.');
  }
  db.prepare("UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?").run(id);
  if (t.lead_id) {
    crm.logActivity({ leadId: t.lead_id, userId, kind: 'task', title: 'Task completed', body: outcome || t.title });
  }
  realtime.toUser(t.user_id, 'task:changed', { id });
  return true;
}

function cancel(id, userId) {
  const t = get(id);
  if (!t) return false;
  db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(id);
  realtime.toUser(t.user_id, 'task:changed', { id });
  return true;
}

function snooze(id, minutes, userId) {
  const t = get(id);
  if (!t) throw new Error('That task no longer exists.');
  const due = new Date(Date.now() + Math.max(1, Number(minutes) || 30) * 60000).toISOString();
  db.prepare("UPDATE tasks SET due_at=?, status='open', reminded_at=NULL WHERE id=?").run(due, id);
  realtime.toUser(t.user_id, 'task:changed', { id });
  return get(id);
}

/**
 * The rep's day: what is overdue, what is due now, what is coming.
 */
function forUser(userId, { horizonHours = 72 } = {}) {
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + horizonHours * 3600 * 1000).toISOString();

  const rows = db
    .prepare(
      "SELECT t.*, l.first_name, l.last_name, l.company, l.phone, l.stage, l.monthly_revenue, l.requested_amount " +
        'FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id ' +
        "WHERE t.user_id = ? AND t.status = 'open' AND t.due_at <= ? ORDER BY t.due_at LIMIT 200"
    )
    .all(userId, soon);

  const overdue = rows.filter((r) => r.due_at < now);
  const due = rows.filter((r) => r.due_at >= now);

  return {
    overdue,
    upcoming: due,
    counts: {
      overdue: overdue.length,
      upcoming: due.length,
      total: db.prepare("SELECT COUNT(*) c FROM tasks WHERE user_id=? AND status='open'").get(userId).c,
    },
  };
}

/** Everything on the floor, for the admin view. */
function all({ status = 'open', limit = 200 } = {}) {
  return db
    .prepare(
      'SELECT t.*, u.name AS agent_name, l.first_name, l.last_name, l.company, l.phone ' +
        'FROM tasks t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN leads l ON l.id = t.lead_id ' +
        'WHERE (@status = \'\' OR t.status = @status) ORDER BY t.due_at LIMIT @limit'
    )
    .all({ status, limit });
}

/**
 * Nudge reps about callbacks that just came due. Runs on a timer.
 */
function sweepReminders() {
  const now = new Date().toISOString();
  const due = db
    .prepare(
      "SELECT t.*, l.first_name, l.last_name, l.company FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id " +
        "WHERE t.status='open' AND t.reminded_at IS NULL AND t.due_at <= ? LIMIT 100"
    )
    .all(now);

  for (const t of due) {
    const who = [t.first_name, t.last_name].filter(Boolean).join(' ') || t.company || 'a lead';
    realtime.toUser(t.user_id, 'task:due', { id: t.id, leadId: t.lead_id, who, title: t.title, note: t.note });
    realtime.toUser(t.user_id, 'toast', { kind: 'warn', text: `Callback due: ${who}` });
    db.prepare("UPDATE tasks SET reminded_at = datetime('now') WHERE id = ?").run(t.id);
  }

  // Anything more than a day past due and untouched is marked missed.
  db.prepare(
    "UPDATE tasks SET status='missed' WHERE status='open' AND due_at < datetime('now','-1 day')"
  ).run();

  return due.length;
}

module.exports = { KINDS, create, get, complete, cancel, snooze, forUser, all, sweepReminders };
