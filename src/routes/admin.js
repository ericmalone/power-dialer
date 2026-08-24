'use strict';

/**
 * Admin JSON API: people, lists, numbers, DNC, settings, reports.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db, settings } = require('../db');
const auth = require('../auth');
const audit = require('../audit');
const health = require('../admin/health');
const callerId = require('../dialer/callerId');
const engine = require('../dialer/engine');
const phone = require('../util/phone');
const sheet = require('../util/spreadsheet');
const { getClient } = require('../twilioClient');

const router = express.Router();
router.use(auth.requireLogin, auth.requireAdmin);

const uploadDir = path.resolve(process.cwd(), 'data', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-60);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function wrap(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (err) {
      console.error('[admin]', err);
      if (!res.headersSent) res.status(400).json({ error: err.message || 'Something went wrong.' });
    }
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

router.get('/overview', wrap(async () => {
  const today = db
    .prepare(
      "SELECT COUNT(*) calls, SUM(CASE WHEN outcome='connected' THEN 1 ELSE 0 END) connects, " +
        "SUM(CASE WHEN outcome='abandoned' THEN 1 ELSE 0 END) abandons, SUM(talk_seconds) talk " +
        "FROM calls WHERE date(created_at) = date('now')"
    )
    .get();
  const agents = db.prepare("SELECT COUNT(*) c FROM users WHERE role='agent' AND active=1").get().c;
  const leadsLeft = db.prepare("SELECT COUNT(*) c FROM leads WHERE status IN ('new','queued')").get().c;
  const dncCount = db.prepare('SELECT COUNT(*) c FROM dnc').get().c;

  const attempts = (today.connects || 0) + (today.abandons || 0);
  return {
    today: {
      calls: today.calls || 0,
      connects: today.connects || 0,
      abandons: today.abandons || 0,
      talkSeconds: today.talk || 0,
      abandonRate: attempts ? (today.abandons || 0) / attempts : 0,
    },
    agents,
    leadsLeft,
    dncCount,
    warnings: config.warnings(),
    advisories: config.advisories(),
    publicUrl: config.publicUrl,
    twimlUrl: `${config.publicUrl}/twiml/agent-leg`,
    smsInboundUrl: `${config.publicUrl}/twiml/sms-inbound`,
    sms: db
      .prepare(
        "SELECT SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) sent, " +
          "SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) received " +
          "FROM messages WHERE date(created_at) = date('now')"
      )
      .get(),
  };
}));

router.get('/stations', wrap(async () => ({ stations: engine.allStations() })));

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

router.get('/users', wrap(async () => ({
  users: db
    .prepare('SELECT * FROM users ORDER BY role, name, email')
    .all()
    .map(auth.publicUser),
})));

router.post('/users', wrap(async (req) => {
  const { email, name, password, role = 'agent', maxLines = 3, invite = false } = req.body;
  if (!email) throw new Error('An email address is required.');
  const cleanRole = role === 'admin' ? 'admin' : 'agent';
  const lines = Math.max(1, Math.min(config.maxLinesPerAgent, Number(maxLines) || 1));

  // Invite: they get an email and pick their own password.
  if (invite || !password) {
    const result = await auth.inviteUser({
      email,
      name,
      role: cleanRole,
      maxLines: lines,
      invitedBy: req.user.name || req.user.email,
    });
    audit.log(req, 'user.invited', { target: String(email).toLowerCase().trim(), detail: `role ${cleanRole}` });
    return {
      user: auth.publicUser(result.user),
      invited: true,
      emailed: result.emailed,
      link: result.emailed ? undefined : result.link,
    };
  }

  const problem = auth.checkPassword(password);
  if (problem) throw new Error(problem);
  if (auth.findByEmail(email)) throw new Error('Someone already uses that email.');
  const user = auth.createUser({ email, name, password, role: cleanRole, maxLines: lines });
  audit.log(req, 'user.created', { target: user.email, detail: `role ${cleanRole}` });
  return { user: auth.publicUser(user) };
}));

router.post('/users/:id/approve', wrap(async (req) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE users SET pending_approval = 0, active = 1 WHERE id = ?').run(id);
  const user = auth.findById(id);
  if (user) audit.log(req, 'user.approved', { target: user.email });
  if (user) {
    require('../email/mailer')
      .sendWelcome({ to: user.email, name: user.name, url: `${config.publicUrl}/login` })
      .catch(() => {});
  }
  return { user: auth.publicUser(user) };
}));

router.post('/users/:id/reset-link', wrap(async (req) => {
  const user = auth.findById(Number(req.params.id));
  if (!user) throw new Error('User not found.');
  const result = await auth.requestPasswordReset(user.email);
  return { sent: result.sent, link: require('../email/mailer').configured() ? undefined : result.url };
}));

/** How many people can still administer this system. */
function activeAdminCount(excludingId = null) {
  return db
    .prepare(
      "SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND pending_approval=0" +
        (excludingId ? ' AND id <> @ex' : '')
    )
    .get(excludingId ? { ex: excludingId } : {}).c;
}

router.patch('/users/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  const u = auth.findById(id);
  if (!u) throw new Error('User not found.');

  const wantsRole = req.body.role !== undefined ? (req.body.role === 'admin' ? 'admin' : 'agent') : null;
  const wantsActive = req.body.active !== undefined ? (req.body.active ? 1 : 0) : null;

  // Guards, so nobody can lock the company out of its own dialer.
  if (id === req.user.id && wantsRole === 'agent') {
    throw new Error('You cannot remove your own administrator access. Ask another admin to do it.');
  }
  if (id === req.user.id && wantsActive === 0) {
    throw new Error('You cannot switch off your own account.');
  }
  const losingAdmin = (wantsRole === 'agent' || wantsActive === 0) && u.role === 'admin' && u.active;
  if (losingAdmin && activeAdminCount(id) === 0) {
    throw new Error('That is the last administrator. Promote someone else first.');
  }

  const fields = [];
  const vals = [];
  const changes = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); vals.push(String(req.body.name)); changes.push('name'); }
  if (wantsActive !== null && wantsActive !== (u.active ? 1 : 0)) {
    fields.push('active = ?');
    vals.push(wantsActive);
    changes.push(wantsActive ? 'switched on' : 'switched off');
  }
  if (wantsRole && wantsRole !== u.role) {
    fields.push('role = ?');
    vals.push(wantsRole);
    changes.push(`role ${u.role} -> ${wantsRole}`);
  }
  if (req.body.maxLines !== undefined) {
    const lines = Math.max(1, Math.min(config.maxLinesPerAgent, Number(req.body.maxLines) || 1));
    if (lines !== u.max_lines) {
      fields.push('max_lines = ?');
      vals.push(lines);
      changes.push(`lines ${u.max_lines} -> ${lines}`);
    }
  }
  if (fields.length) db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id);

  if (req.body.password) {
    const problem = auth.checkPassword(req.body.password);
    if (problem) throw new Error(problem);
    auth.setPassword(id, req.body.password);
    changes.push('password set by admin');
  }

  if (changes.length) {
    const action =
      wantsRole && wantsRole !== u.role
        ? 'user.role_changed'
        : wantsActive === 0
        ? 'user.disabled'
        : wantsActive === 1
        ? 'user.enabled'
        : 'user.lines_changed';
    audit.log(req, action, { target: u.email, detail: changes.join(', ') });
  }
  return { user: auth.publicUser(auth.findById(id)) };
}));

/**
 * Remove someone for good. Their history stays - calls, texts and notes are
 * reassigned to whoever takes over, or left orphaned but intact.
 */
router.delete('/users/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  const u = auth.findById(id);
  if (!u) throw new Error('User not found.');
  if (id === req.user.id) throw new Error('You cannot remove your own account.');
  if (u.role === 'admin' && u.active && activeAdminCount(id) === 0) {
    throw new Error('That is the last administrator. Promote someone else first.');
  }

  const transferTo = req.body.transferTo ? Number(req.body.transferTo) : null;
  if (transferTo) {
    const target = auth.findById(transferTo);
    if (!target || !target.active) throw new Error('Pick an active person to take over their work.');
    if (transferTo === id) throw new Error('They cannot take over from themselves.');
  }

  const moved = { leads: 0, tasks: 0, calls: 0, messages: 0 };
  const tx = db.transaction(() => {
    if (transferTo) {
      moved.leads = db.prepare('UPDATE leads SET owner_id = ? WHERE owner_id = ?').run(transferTo, id).changes;
      db.prepare('UPDATE leads SET worked_by = ? WHERE worked_by = ?').run(transferTo, id);
      moved.tasks = db
        .prepare("UPDATE tasks SET user_id = ? WHERE user_id = ? AND status = 'open'")
        .run(transferTo, id).changes;
      moved.calls = db.prepare('UPDATE calls SET user_id = ? WHERE user_id = ?').run(transferTo, id).changes;
      moved.messages = db.prepare('UPDATE messages SET user_id = ? WHERE user_id = ?').run(transferTo, id).changes;
      db.prepare('UPDATE ai_notes SET user_id = ? WHERE user_id = ?').run(transferTo, id);
      db.prepare('UPDATE activities SET user_id = ? WHERE user_id = ?').run(transferTo, id);
      db.prepare('UPDATE sessions_log SET user_id = ? WHERE user_id = ?').run(transferTo, id);
      db.prepare('UPDATE tasks SET user_id = ? WHERE user_id = ?').run(transferTo, id);
    } else {
      // Keep the history, detach the person.
      db.prepare('UPDATE leads SET owner_id = NULL WHERE owner_id = ?').run(id);
      db.prepare('UPDATE leads SET worked_by = NULL WHERE worked_by = ?').run(id);
      db.prepare('UPDATE calls SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('UPDATE ai_notes SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('UPDATE activities SET user_id = NULL WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sessions_log WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE user_id = ?').run(id);
    }
    // Anything owned outright goes with them.
    db.prepare('DELETE FROM assignments WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM sms_rules WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM sms_templates WHERE owner_id = ?').run(id);
    db.prepare('UPDATE dnc SET added_by = NULL WHERE added_by = ?').run(id);
    db.prepare('UPDATE lists SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE tasks SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  tx();

  try {
    engine.agentOffline(id);
  } catch {
    /* they may not have been online */
  }

  audit.log(req, 'user.deleted', {
    target: u.email,
    detail: transferTo
      ? `work transferred to ${nameOf(transferTo)} (${moved.leads} merchants, ${moved.tasks} callbacks, ${moved.calls} calls)`
      : 'history kept, left unassigned',
  });
  return { removed: u.email, transferred: moved };
}));

function nameOf(id) {
  const u = auth.findById(id);
  return u ? u.name || u.email : `#${id}`;
}

/** Everything about one person, for the drill-down. */
router.get('/users/:id/detail', wrap(async (req) => {
  const id = Number(req.params.id);
  const u = auth.findById(id);
  if (!u) throw new Error('User not found.');

  const today = db
    .prepare(
      "SELECT COUNT(*) dials, SUM(CASE WHEN outcome='connected' THEN 1 ELSE 0 END) connects, " +
        "SUM(talk_seconds) talk FROM calls WHERE user_id = ? AND date(created_at) = date('now')"
    )
    .get(id);
  const week = db
    .prepare(
      "SELECT COUNT(*) dials, SUM(CASE WHEN outcome='connected' THEN 1 ELSE 0 END) connects, " +
        "SUM(talk_seconds) talk FROM calls WHERE user_id = ? AND created_at >= datetime('now','-7 days')"
    )
    .get(id);
  const station = engine.snapshot(id);

  return {
    user: auth.publicUser(u),
    station: { status: station.status, lines: station.lines, onCall: station.onCall, stats: station.stats },
    today: { dials: today.dials || 0, connects: today.connects || 0, talkSeconds: today.talk || 0 },
    week: { dials: week.dials || 0, connects: week.connects || 0, talkSeconds: week.talk || 0 },
    lists: db
      .prepare('SELECT l.id, l.name FROM assignments a JOIN lists l ON l.id = a.list_id WHERE a.user_id = ?')
      .all(id),
    openTasks: db.prepare("SELECT COUNT(*) c FROM tasks WHERE user_id = ? AND status='open'").get(id).c,
    ownedLeads: db.prepare('SELECT COUNT(*) c FROM leads WHERE owner_id = ?').get(id).c,
    recentCalls: db
      .prepare(
        'SELECT c.created_at, c.to_number, c.outcome, c.disposition, c.talk_seconds, l.company ' +
          'FROM calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 15'
      )
      .all(id),
    recentActivity: audit.list({ actorId: id, limit: 20 }),
  };
}));

// ---------------------------------------------------------------------------
// Audit trail and system health
// ---------------------------------------------------------------------------

router.get('/audit', wrap(async (req) => ({
  entries: audit.list({
    limit: Number(req.query.limit) || 150,
    actorId: req.query.actor || null,
    action: req.query.action || null,
  }),
  actions: audit.ACTIONS,
})));

/** Re-run Twilio auto-setup on demand: after a redeploy, or a URL change. */
router.post('/setup/twilio', wrap(async (req) => {
  const provision = require('../setup/provision');
  const result = await provision.run({ reason: `admin:${req.user.email}` });
  audit.log(req, 'twilio.provisioned', {
    detail: result.ran
      ? result.steps.map((s) => `${s.step}: ${s.status}`).join(', ')
      : `did not run - ${result.reason}`,
  });
  return result;
}));

router.get('/setup/twilio', wrap(async () => {
  const provision = require('../setup/provision');
  return {
    autoSetup: config.autoSetup,
    configured: config.twilioConfigured,
    voiceUrl: provision.agentLegUrl(),
    smsUrl: provision.smsInboundUrl(),
    last: provision.lastRun(),
  };
}));

router.get('/health', wrap(async (req) => {
  const result = await health.runAll(req);
  audit.log(req, 'health.checked', { detail: `${result.overall}: ${result.counts.fail} failing, ${result.counts.warn} warning` });
  return result;
}));

// ---------------------------------------------------------------------------
// Lists: upload -> preview -> import
// ---------------------------------------------------------------------------

router.post('/lists/preview', upload.single('file'), wrap(async (req) => {
  if (!req.file) throw new Error('No file received.');
  const buf = fs.readFileSync(req.file.path);
  const { headers, rows } = sheet.parseBuffer(buf, req.file.originalname);
  if (!headers.length) throw new Error('That file has no readable header row.');

  const mapping = sheet.guessMapping(headers);
  if (!mapping.phone) mapping.phone = sheet.detectPhoneColumn(headers, rows);

  const preview = sheet.toLeads(rows.slice(0, 8), mapping);
  const allLeads = sheet.toLeads(rows, mapping);
  const valid = allLeads.filter((l) => l.phone).length;

  return {
    token: req.file.filename,
    originalName: req.file.originalname,
    headers,
    mapping,
    rowCount: rows.length,
    validPhones: valid,
    invalidPhones: rows.length - valid,
    sample: preview,
  };
}));

router.post('/lists/import', wrap(async (req) => {
  const { token, name, mapping, assignTo = [], skipDuplicates = true, skipDnc = true } = req.body;
  if (!token) throw new Error('Upload the file first.');
  const filePath = path.join(uploadDir, path.basename(token));
  if (!fs.existsSync(filePath)) throw new Error('That upload expired. Please upload the file again.');
  if (!mapping || !mapping.phone) throw new Error('Choose which column holds the phone number.');

  const { headers, rows } = sheet.parseBuffer(fs.readFileSync(filePath));
  const leads = sheet.toLeads(rows, mapping);

  const listInfo = db
    .prepare('INSERT INTO lists (name, source_file, created_by, columns_json) VALUES (?,?,?,?)')
    .run(name || `Import ${new Date().toLocaleDateString()}`, path.basename(token), req.user.id, JSON.stringify(headers));
  const listId = listInfo.lastInsertRowid;

  const dncSet = new Set(db.prepare('SELECT phone FROM dnc').all().map((r) => r.phone));
  const seen = new Set();
  const existing = skipDuplicates
    ? new Set(db.prepare('SELECT DISTINCT phone FROM leads WHERE phone IS NOT NULL').all().map((r) => r.phone))
    : new Set();

  const ins = db.prepare(
    'INSERT INTO leads (list_id,row_index,first_name,last_name,company,email,phone_raw,phone,timezone,extra_json,status,' +
      'monthly_revenue,annual_revenue,time_in_business_months,requested_amount,industry,entity_state,open_positions,fico) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );

  let imported = 0;
  let skippedDup = 0;
  let skippedDncCount = 0;
  let invalid = 0;

  const tx = db.transaction(() => {
    for (const l of leads) {
      let status = 'new';
      if (!l.phone) {
        status = 'invalid';
        invalid++;
      } else if (skipDnc && dncSet.has(l.phone)) {
        status = 'dnc';
        skippedDncCount++;
      } else if (seen.has(l.phone) || (skipDuplicates && existing.has(l.phone))) {
        skippedDup++;
        continue;
      }
      if (l.phone) seen.add(l.phone);
      const d = l.deal || {};
      ins.run(
        listId,
        l.rowIndex,
        l.firstName,
        l.lastName,
        l.company,
        l.email,
        l.phoneRaw,
        l.phone,
        l.timezone,
        JSON.stringify(l.extra),
        status,
        d.monthly_revenue ?? null,
        d.annual_revenue ?? null,
        d.time_in_business_months ?? null,
        d.requested_amount ?? null,
        d.industry || '',
        d.entity_state || '',
        d.open_positions ?? null,
        d.fico ?? null
      );
      if (status === 'new') imported++;
    }
  });
  tx();

  const assign = db.prepare('INSERT OR IGNORE INTO assignments (list_id, user_id) VALUES (?,?)');
  for (const uid of assignTo) assign.run(listId, Number(uid));

  audit.log(req, 'list.imported', {
    target: name || `list ${listId}`,
    detail: `${imported} imported, ${skippedDup} duplicates, ${skippedDncCount} on DNC, ${invalid} unusable`,
  });
  return { listId, imported, skippedDuplicates: skippedDup, skippedDnc: skippedDncCount, invalid };
}));

router.get('/lists', wrap(async () => ({
  lists: db
    .prepare('SELECT * FROM lists ORDER BY created_at DESC')
    .all()
    .map((l) => {
      const c = db
        .prepare(
          "SELECT COUNT(*) total, SUM(CASE WHEN status IN ('new','queued') THEN 1 ELSE 0 END) remaining, " +
            "SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done, " +
            "SUM(CASE WHEN status='contacted' THEN 1 ELSE 0 END) contacted, " +
            "SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) invalid FROM leads WHERE list_id = ?"
        )
        .get(l.id);
      const assigned = db
        .prepare('SELECT u.id,u.name,u.email FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.list_id = ?')
        .all(l.id);
      return { ...l, counts: c, assigned };
    }),
})));

router.post('/lists/:id/assign', wrap(async (req) => {
  const listId = Number(req.params.id);
  const userIds = (req.body.userIds || []).map(Number);
  db.prepare('DELETE FROM assignments WHERE list_id = ?').run(listId);
  const ins = db.prepare('INSERT OR IGNORE INTO assignments (list_id,user_id) VALUES (?,?)');
  const tx = db.transaction((ids) => ids.forEach((id) => ins.run(listId, id)));
  tx(userIds);
  audit.log(req, 'list.assigned', { target: `list ${listId}`, detail: `${userIds.length} person(s)` });
  return { ok: true };
}));

router.post('/lists/:id/recording', wrap(async (req) => {
  const value = req.body.record === null || req.body.record === undefined ? null : req.body.record ? 1 : 0;
  db.prepare('UPDATE lists SET record_calls = ? WHERE id = ?').run(value, Number(req.params.id));
  audit.log(req, 'list.recording_changed', {
    target: `list ${req.params.id}`,
    detail: value === null ? 'use default' : value ? 'record' : 'do not record',
  });
  return { record: value };
}));

router.post('/lists/:id/archive', wrap(async (req) => {
  db.prepare('UPDATE lists SET archived = ? WHERE id = ?').run(req.body.archived ? 1 : 0, Number(req.params.id));
  return { ok: true };
}));

router.post('/lists/:id/reset', wrap(async (req) => {
  const r = db
    .prepare(
      "UPDATE leads SET status='new', locked_by=NULL, locked_at=NULL, next_attempt=NULL, attempts=0, " +
        "disposition='' WHERE list_id = ? AND status <> 'invalid' AND status <> 'dnc'"
    )
    .run(Number(req.params.id));
  audit.log(req, 'list.reset', { target: `list ${req.params.id}`, detail: `${r.changes} leads re-queued` });
  return { reset: r.changes };
}));

router.delete('/lists/:id', wrap(async (req) => {
  const list = db.prepare('SELECT name FROM lists WHERE id = ?').get(Number(req.params.id));
  const n = db.prepare('SELECT COUNT(*) c FROM leads WHERE list_id = ?').get(Number(req.params.id)).c;
  db.prepare('DELETE FROM lists WHERE id = ?').run(Number(req.params.id));
  audit.log(req, 'list.deleted', { target: list ? list.name : `list ${req.params.id}`, detail: `${n} merchants deleted with it` });
  return { ok: true };
}));

router.get('/lists/:id/export', (req, res) => {
  const listId = Number(req.params.id);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).send('List not found.');

  const leads = db
    .prepare(
      'SELECT l.*, u.name AS agent_name, ' +
        "(SELECT summary FROM ai_notes n WHERE n.lead_id = l.id AND n.status='ready' ORDER BY n.id DESC LIMIT 1) AS ai_summary " +
        'FROM leads l LEFT JOIN users u ON u.id = l.worked_by ' +
        'WHERE l.list_id = ? ORDER BY l.row_index'
    )
    .all(listId);
  const calls = db
    .prepare('SELECT * FROM calls WHERE lead_id IN (SELECT id FROM leads WHERE list_id = ?) ORDER BY created_at')
    .all(listId);
  const byLead = new Map();
  for (const c of calls) {
    if (!byLead.has(c.lead_id)) byLead.set(c.lead_id, []);
    byLead.get(c.lead_id).push(c);
  }
  require('../audit').log(req, 'list.exported', { target: list.name, detail: `${leads.length} rows` });
  const buf = sheet.buildExport(leads, byLead);
  const safeName = list.name.replace(/[^\w\-]+/g, '_');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}_results.xlsx"`);
  res.send(buf);
});

router.get('/lists/:id/leads', wrap(async (req) => {
  const listId = Number(req.params.id);
  const q = `%${(req.query.q || '').toString()}%`;
  const rows = db
    .prepare(
      'SELECT * FROM leads WHERE list_id = ? AND (? = "%%" OR first_name LIKE ? OR last_name LIKE ? ' +
        'OR company LIKE ? OR phone LIKE ?) ORDER BY row_index LIMIT 500'
    )
    .all(listId, q, q, q, q, q);
  return { leads: rows.map((l) => ({ ...l, phoneDisplay: phone.format(l.phone) })) };
}));

// ---------------------------------------------------------------------------
// Caller ID numbers
// ---------------------------------------------------------------------------

router.get('/numbers', wrap(async () => {
  callerId.backfillPlaces();
  return {
    numbers: db
      .prepare('SELECT * FROM caller_ids ORDER BY state, area_code, phone')
      .all()
      .map((n) => ({ ...n, region: n.state ? phone.regionName(n.state) : null, display: phone.format(n.phone) })),
  };
}));

/** How much of the book can we ring from a local number, and what to buy next. */
router.get('/numbers/coverage', wrap(async (req) => ({
  coverage: callerId.coverage({ listId: req.query.list || null }),
  strategies: callerId.STRATEGIES,
})));

router.post('/numbers', wrap(async (req) => {
  const e164 = phone.normalize(req.body.phone);
  if (!e164) throw new Error('That does not look like a phone number.');
  db.prepare('INSERT OR IGNORE INTO caller_ids (phone, friendly_name) VALUES (?,?)').run(
    e164,
    req.body.friendlyName || ''
  );
  audit.log(req, 'number.added', { target: e164 });
  return { ok: true };
}));

router.patch('/numbers/:id', wrap(async (req) => {
  db.prepare('UPDATE caller_ids SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, Number(req.params.id));
  return { ok: true };
}));

router.delete('/numbers/:id', wrap(async (req) => {
  const n = db.prepare('SELECT phone FROM caller_ids WHERE id = ?').get(Number(req.params.id));
  db.prepare('DELETE FROM caller_ids WHERE id = ?').run(Number(req.params.id));
  audit.log(req, 'number.removed', { target: n ? n.phone : String(req.params.id) });
  return { ok: true };
}));

/** Pull the numbers already on the Twilio account so they can be added in one click. */
router.post('/numbers/sync', wrap(async () => {
  const client = getClient();
  const nums = await client.incomingPhoneNumbers.list({ limit: 200 });
  const ins = db.prepare('INSERT OR IGNORE INTO caller_ids (phone, friendly_name) VALUES (?,?)');
  let added = 0;
  for (const n of nums) {
    const r = ins.run(n.phoneNumber, n.friendlyName || '');
    if (r.changes) added++;
  }
  return { found: nums.length, added };
}));

// ---------------------------------------------------------------------------
// Do Not Call
// ---------------------------------------------------------------------------

router.get('/dnc', wrap(async (req) => {
  const q = `%${(req.query.q || '').toString()}%`;
  return {
    dnc: db
      .prepare('SELECT * FROM dnc WHERE ? = "%%" OR phone LIKE ? ORDER BY created_at DESC LIMIT 500')
      .all(q, q)
      .map((d) => ({ ...d, phoneDisplay: phone.format(d.phone) })),
    total: db.prepare('SELECT COUNT(*) c FROM dnc').get().c,
  };
}));

router.post('/dnc', wrap(async (req) => {
  const raw = String(req.body.numbers || '');
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  const ins = db.prepare('INSERT OR IGNORE INTO dnc (phone, reason, added_by) VALUES (?,?,?)');
  let added = 0;
  const bad = [];
  const tx = db.transaction(() => {
    for (const p of parts) {
      const e164 = phone.normalize(p);
      if (!e164) { bad.push(p); continue; }
      const r = ins.run(e164, req.body.reason || 'Manual entry', req.user.id);
      if (r.changes) added++;
      db.prepare("UPDATE leads SET status='dnc', locked_by=NULL WHERE phone = ? AND status <> 'done'").run(e164);
    }
  });
  tx();
  audit.log(req, 'dnc.added', { detail: `${added} number(s) added, ${bad.length} unreadable` });
  return { added, invalid: bad };
}));

router.post('/dnc/upload', upload.single('file'), wrap(async (req) => {
  if (!req.file) throw new Error('No file received.');
  const { headers, rows } = sheet.parseBuffer(fs.readFileSync(req.file.path));
  const col = sheet.guessMapping(headers).phone || sheet.detectPhoneColumn(headers, rows) || headers[0];
  const ins = db.prepare('INSERT OR IGNORE INTO dnc (phone, reason, added_by) VALUES (?,?,?)');
  let added = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const e164 = phone.normalize(r[col]);
      if (!e164) continue;
      const res = ins.run(e164, 'Imported list', req.user.id);
      if (res.changes) added++;
      db.prepare("UPDATE leads SET status='dnc', locked_by=NULL WHERE phone = ? AND status <> 'done'").run(e164);
    }
  });
  tx();
  fs.unlink(req.file.path, () => {});
  return { added, column: col };
}));

router.delete('/dnc/:id', wrap(async (req) => {
  const d = db.prepare('SELECT phone FROM dnc WHERE id = ?').get(Number(req.params.id));
  db.prepare('DELETE FROM dnc WHERE id = ?').run(Number(req.params.id));
  audit.log(req, 'dnc.removed', { target: d ? d.phone : String(req.params.id) });
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// Settings & dispositions
// ---------------------------------------------------------------------------

const SETTING_KEYS = [
  'match_area_code',
  'caller_id_strategy',
  'auto_throttle',
  'drop_voicemail',
  'voicemail_message',
  'inbound_forward_to',
  'sms_from_number',
  'sms_optout_reply',
  'sms_optin_reply',
  'leaderboard_visible',
];

router.get('/settings', wrap(async () => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = settings.get(k, null);
  return {
    settings: out,
    env: {
      maxLinesPerAgent: config.maxLinesPerAgent,
      recordCalls: config.recordCalls,
      enableAmd: config.enableAmd,
      enforceCallingHours: config.enforceCallingHours,
      callingHoursStart: config.callingHoursStart,
      callingHoursEnd: config.callingHoursEnd,
      ringTimeout: config.ringTimeout,
      wrapUpSeconds: config.wrapUpSeconds,
      companyName: config.companyName,
      smsEnabled: config.sms.enabled,
      smsQuietHours: config.sms.quietHours,
      smsMaxPerBatch: config.sms.maxPerBatch,
      smsDailyCapPerAgent: config.sms.dailyCapPerAgent,
      messagingServiceSid: config.twilio.messagingServiceSid || '(not set)',
    },
    smsNumbers: db.prepare('SELECT phone FROM caller_ids WHERE active = 1 AND sms_capable = 1').all().map((r) => r.phone),
    advisories: config.advisories(),
  };
}));

// ---------------------------------------------------------------------------
// Texting oversight
// ---------------------------------------------------------------------------

router.get('/sms/log', wrap(async (req) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const dir = req.query.direction === 'inbound' ? 'inbound' : req.query.direction === 'outbound' ? 'outbound' : null;
  const rows = db
    .prepare(
      'SELECT m.*, u.name AS agent_name, l.first_name, l.last_name, l.company, t.name AS template_name ' +
        'FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN leads l ON l.id = m.lead_id ' +
        'LEFT JOIN sms_templates t ON t.id = m.template_id ' +
        'WHERE (@dir IS NULL OR m.direction = @dir) ORDER BY m.id DESC LIMIT @limit'
    )
    .all({ dir, limit });
  return { messages: rows.map((m) => ({ ...m, toDisplay: phone.format(m.to_number), fromDisplay: phone.format(m.from_number) })) };
}));

router.get('/sms/stats', wrap(async () => {
  const today = db
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) sent, " +
        "SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) received, " +
        "SUM(CASE WHEN status IN ('failed','undelivered') THEN 1 ELSE 0 END) failed, " +
        "SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) blocked, " +
        "SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued, " +
        "SUM(segments) segments FROM messages WHERE date(created_at) = date('now')"
    )
    .get();
  return {
    today: {
      sent: today.sent || 0,
      received: today.received || 0,
      failed: today.failed || 0,
      blocked: today.blocked || 0,
      queued: today.queued || 0,
      segments: today.segments || 0,
    },
    optOuts: db.prepare('SELECT COUNT(*) c FROM sms_optouts').get().c,
  };
}));

router.get('/sms/optouts', wrap(async () => ({
  optOuts: db
    .prepare('SELECT * FROM sms_optouts ORDER BY created_at DESC LIMIT 500')
    .all()
    .map((o) => ({ ...o, phoneDisplay: phone.format(o.phone) })),
})));

router.delete('/sms/optouts/:id', wrap(async (req) => {
  const o = db.prepare('SELECT phone FROM sms_optouts WHERE id = ?').get(Number(req.params.id));
  db.prepare('DELETE FROM sms_optouts WHERE id = ?').run(Number(req.params.id));
  audit.log(req, 'dnc.optout_removed', { target: o ? o.phone : String(req.params.id) });
  return { ok: true };
}));

router.get('/sms/templates', wrap(async () => ({
  templates: db
    .prepare(
      'SELECT t.*, u.name AS owner_name, u.email AS owner_email FROM sms_templates t ' +
        'LEFT JOIN users u ON u.id = t.owner_id WHERE t.archived = 0 ORDER BY (t.owner_id IS NULL) DESC, t.name'
    )
    .all(),
})));

router.get('/sms/rules', wrap(async () => ({
  rules: db
    .prepare(
      'SELECT r.*, t.name AS template_name, u.name AS owner_name, u.email AS owner_email, l.name AS list_name ' +
        'FROM sms_rules r JOIN sms_templates t ON t.id = r.template_id ' +
        'LEFT JOIN users u ON u.id = r.owner_id LEFT JOIN lists l ON l.id = r.list_id ORDER BY r.id'
    )
    .all(),
})));

router.post('/numbers/:id/sms', wrap(async (req) => {
  db.prepare('UPDATE caller_ids SET sms_capable = ? WHERE id = ?').run(req.body.smsCapable ? 1 : 0, Number(req.params.id));
  return { ok: true };
}));

router.post('/settings', wrap(async (req) => {
  const touched = [];
  for (const k of SETTING_KEYS) {
    if (req.body[k] !== undefined) {
      settings.set(k, req.body[k]);
      touched.push(k);
    }
  }
  if (touched.length) audit.log(req, 'settings.changed', { detail: touched.join(', ') });
  return { ok: true };
}));

router.get('/dispositions', wrap(async () => ({
  dispositions: db.prepare('SELECT * FROM dispositions ORDER BY sort').all(),
})));

router.post('/dispositions', wrap(async (req) => {
  const { code, label, kind = 'neutral', sort = 500, hotkey = '' } = req.body;
  if (!code || !label) throw new Error('Code and label are required.');
  db.prepare(
    'INSERT INTO dispositions (code,label,kind,sort,hotkey) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(code) DO UPDATE SET label=excluded.label, kind=excluded.kind, sort=excluded.sort, hotkey=excluded.hotkey'
  ).run(String(code).toLowerCase().replace(/\W+/g, '_'), label, kind, Number(sort) || 500, hotkey);
  return { ok: true };
}));

router.delete('/dispositions/:id', wrap(async (req) => {
  db.prepare('DELETE FROM dispositions WHERE id = ?').run(Number(req.params.id));
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

router.get('/reports/agents', wrap(async (req) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
  return {
    rows: db
      .prepare(
        "SELECT u.id, u.name, u.email, COUNT(c.id) calls, " +
          "SUM(CASE WHEN c.outcome='connected' THEN 1 ELSE 0 END) connects, " +
          "SUM(CASE WHEN c.outcome='abandoned' THEN 1 ELSE 0 END) abandons, " +
          'SUM(c.talk_seconds) talk_seconds ' +
          'FROM users u LEFT JOIN calls c ON c.user_id = u.id ' +
          "AND c.created_at >= datetime('now', '-' || ? || ' days') " +
          'GROUP BY u.id ORDER BY connects DESC'
      )
      .all(days),
  };
}));

router.get('/reports/calls', wrap(async (req) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
  return {
    calls: db
      .prepare(
        'SELECT c.*, l.first_name, l.last_name, l.company, u.name AS agent_name ' +
          'FROM calls c LEFT JOIN leads l ON l.id = c.lead_id LEFT JOIN users u ON u.id = c.user_id ' +
          'ORDER BY c.created_at DESC LIMIT ?'
      )
      .all(limit),
  };
}));

module.exports = router;
