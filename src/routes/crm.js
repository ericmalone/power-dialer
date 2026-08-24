'use strict';

/**
 * CRM API. Reps see the merchants on their lists plus anything assigned to
 * them; admins see everything.
 */

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const crm = require('../crm');
const stages = require('../crm/stages');
const tasks = require('../crm/tasks');
const aiNotes = require('../ai/notes');
const engine = require('../dialer/engine');
const phone = require('../util/phone');

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

/** Reps may only touch merchants on a list they work, or ones assigned to them. */
function assertCanSee(user, leadId) {
  const lead = db.prepare('SELECT id, list_id, owner_id FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw new Error('That merchant is not in the system.');
  if (user.role === 'admin') return lead;
  if (lead.owner_id === user.id) return lead;
  const assigned = db
    .prepare('SELECT 1 x FROM assignments WHERE list_id = ? AND user_id = ?')
    .get(lead.list_id, user.id);
  if (!assigned) throw new Error('That merchant is not on one of your lists.');
  return lead;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

router.get('/meta', wrap(async (req) => ({
  stages: stages.STAGES,
  dealFields: crm.DEAL_FIELDS,
  lostReasons: stages.LOST_REASONS,
  taskKinds: tasks.KINDS,
  ai: aiNotes.status(),
  isAdmin: req.user.role === 'admin',
  agents: db
    .prepare("SELECT id, name, email FROM users WHERE active = 1 AND pending_approval = 0 ORDER BY name, email")
    .all(),
})));

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

router.get('/search', wrap(async (req) =>
  crm.search({
    user: req.user,
    q: req.query.q || '',
    stage: req.query.stage || '',
    ownerId: req.query.owner || null,
    listId: req.query.list || null,
    mine: req.query.mine === '1',
    sort: req.query.sort || 'recent',
    limit: Number(req.query.limit) || 100,
    offset: Number(req.query.offset) || 0,
  })
));

router.get('/pipeline', wrap(async (req) => ({
  pipeline: crm.pipeline({
    user: req.user,
    ownerId: req.query.owner || null,
    listId: req.query.list || null,
  }),
})));

// ---------------------------------------------------------------------------
// One merchant
// ---------------------------------------------------------------------------

router.get('/lead/:id', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  const record = crm.leadRecord(Number(req.params.id));
  if (!record) throw new Error('That merchant is not in the system.');
  return { lead: record };
}));

router.patch('/lead/:id', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  const result = crm.setFields(Number(req.params.id), req.body.fields || req.body, req.user.id);
  return { changed: result.changed };
}));

router.post('/lead/:id/stage', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  const code = String(req.body.stage || '');
  crm.setStage(Number(req.params.id), code, req.user.id, { reason: req.body.reason || '' });
  return { stage: code };
}));

router.post('/lead/:id/note', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  crm.addNote(Number(req.params.id), req.user.id, req.body.body);
  return { ok: true };
}));

router.post('/lead/:id/owner', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  const ownerId = req.body.ownerId ? Number(req.body.ownerId) : null;
  if (ownerId && ownerId !== req.user.id && req.user.role !== 'admin') {
    throw new Error('Only an administrator can hand a merchant to someone else.');
  }
  crm.assignOwner(Number(req.params.id), ownerId, req.user.id);
  return { ok: true };
}));

router.get('/lead/:id/timeline', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  return { timeline: crm.timeline(Number(req.params.id), Number(req.query.limit) || 200) };
}));

/** Ring this merchant right now, straight from their record. */
router.post('/lead/:id/call', wrap(async (req) => {
  assertCanSee(req.user, req.params.id);
  return engine.dialOne(req.user.id, Number(req.params.id));
}));

// ---------------------------------------------------------------------------
// Callbacks and follow-ups
// ---------------------------------------------------------------------------

router.get('/tasks', wrap(async (req) => tasks.forUser(req.user.id, {
  horizonHours: Number(req.query.hours) || 72,
})));

router.post('/tasks', wrap(async (req) => {
  if (req.body.leadId) assertCanSee(req.user, req.body.leadId);
  const t = tasks.create({
    leadId: req.body.leadId ? Number(req.body.leadId) : null,
    userId: req.body.userId && req.user.role === 'admin' ? Number(req.body.userId) : req.user.id,
    kind: req.body.kind || 'callback',
    dueAt: req.body.dueAt,
    minutesFromNow: req.body.minutesFromNow,
    note: req.body.note || '',
    title: req.body.title || '',
    createdBy: req.user.id,
  });
  return { task: t };
}));

router.post('/tasks/:id/complete', wrap(async (req) => {
  tasks.complete(Number(req.params.id), req.user.id, { outcome: req.body.outcome || '' });
  return { ok: true };
}));

router.post('/tasks/:id/snooze', wrap(async (req) => ({
  task: tasks.snooze(Number(req.params.id), Number(req.body.minutes) || 30, req.user.id),
})));

router.delete('/tasks/:id', wrap(async (req) => {
  tasks.cancel(Number(req.params.id), req.user.id);
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// AI notes
// ---------------------------------------------------------------------------

router.get('/ai/note/:id', wrap(async (req) => {
  const note = db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(Number(req.params.id));
  if (!note) throw new Error('That note no longer exists.');
  assertCanSee(req.user, note.lead_id);
  return { note: crm.parseAiNote(note) };
}));

router.get('/ai/for-call/:callId', wrap(async (req) => {
  const note = db.prepare('SELECT * FROM ai_notes WHERE call_id = ?').get(Number(req.params.callId));
  if (!note) return { note: null };
  assertCanSee(req.user, note.lead_id);
  return { note: crm.parseAiNote(note) };
}));

router.post('/ai/note/:id/regenerate', wrap(async (req) => {
  const note = db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(Number(req.params.id));
  if (!note) throw new Error('That note no longer exists.');
  assertCanSee(req.user, note.lead_id);
  const fresh = await aiNotes.regenerate(note.id);
  return { note: crm.parseAiNote(fresh) };
}));

router.get('/ai/recent', wrap(async (req) => {
  const limit = Math.min(100, Number(req.query.limit) || 25);
  const rows =
    req.user.role === 'admin'
      ? db
          .prepare(
            "SELECT n.*, l.first_name, l.last_name, l.company, u.name AS agent_name FROM ai_notes n " +
              'LEFT JOIN leads l ON l.id = n.lead_id LEFT JOIN users u ON u.id = n.user_id ' +
              "WHERE n.status='ready' ORDER BY n.id DESC LIMIT ?"
          )
          .all(limit)
      : db
          .prepare(
            "SELECT n.*, l.first_name, l.last_name, l.company FROM ai_notes n " +
              'LEFT JOIN leads l ON l.id = n.lead_id ' +
              "WHERE n.status='ready' AND n.user_id = ? ORDER BY n.id DESC LIMIT ?"
          )
          .all(req.user.id, limit);
  return { notes: rows.map(crm.parseAiNote) };
}));

// ---------------------------------------------------------------------------
// Activity feed / dashboard
// ---------------------------------------------------------------------------

router.get('/my-day', wrap(async (req) => {
  const t = tasks.forUser(req.user.id, { horizonHours: 24 });
  const today = db
    .prepare(
      "SELECT COUNT(*) dials, SUM(CASE WHEN outcome='connected' THEN 1 ELSE 0 END) connects, " +
        "SUM(talk_seconds) talk FROM calls WHERE user_id = ? AND date(created_at) = date('now')"
    )
    .get(req.user.id);
  const pipeline = crm.pipeline({ user: req.user, ownerId: req.user.id });
  const recentNotes = db
    .prepare(
      "SELECT n.id, n.summary, n.interest, n.lead_id, l.first_name, l.last_name, l.company " +
        'FROM ai_notes n LEFT JOIN leads l ON l.id = n.lead_id ' +
        "WHERE n.user_id = ? AND n.status='ready' ORDER BY n.id DESC LIMIT 5"
    )
    .all(req.user.id);

  return {
    tasks: t,
    today: { dials: today.dials || 0, connects: today.connects || 0, talkSeconds: today.talk || 0 },
    pipeline: pipeline.filter((s) => s.count > 0),
    recentNotes,
  };
}));

/** Recent activity across the floor - admin only. */
router.get('/feed', wrap(async (req) => {
  if (req.user.role !== 'admin') throw new Error('Administrator access required.');
  const rows = db
    .prepare(
      'SELECT a.*, u.name AS user_name, l.first_name, l.last_name, l.company FROM activities a ' +
        'LEFT JOIN users u ON u.id = a.user_id LEFT JOIN leads l ON l.id = a.lead_id ' +
        'ORDER BY a.id DESC LIMIT ?'
    )
    .all(Math.min(200, Number(req.query.limit) || 60));
  return { feed: rows };
}));

module.exports = router;
