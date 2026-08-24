'use strict';

/**
 * Reports API.
 *
 * A rep can always run their own numbers. Only an admin can look at someone
 * else's, or at the floor as a whole. The team leaderboard is the one shared
 * view, and it can be switched off in Admin > Settings.
 */

const express = require('express');
const XLSX = require('xlsx');
const config = require('../config');
const { db, settings } = require('../db');
const auth = require('../auth');
const reports = require('../reports');

const router = express.Router();
router.use(auth.requireLogin);

function wrap(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (err) {
      console.error('[reports]', err);
      if (!res.headersSent) res.status(400).json({ error: err.message || 'Could not run that report.' });
    }
  };
}

function parseAgents(req) {
  if (req.user.role !== 'admin') return [req.user.id];
  const raw = String(req.query.agents || '').trim();
  if (!raw || raw === 'all') return null; // everyone
  return raw
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function queryOptions(req) {
  return {
    user: req.user,
    agentIds: parseAgents(req),
    preset: req.query.preset || 'last_7',
    from: req.query.from,
    to: req.query.to,
    groupBy: req.query.groupBy || 'day',
    listId: req.query.list ? Number(req.query.list) : null,
  };
}

// ---------------------------------------------------------------------------

router.get('/meta', wrap(async (req) => ({
  presets: reports.PRESETS,
  groupings: reports.GROUPINGS,
  timezone: config.reportTimezone,
  isAdmin: req.user.role === 'admin',
  me: { id: req.user.id, name: req.user.name || req.user.email },
  leaderboardVisible: req.user.role === 'admin' || settings.getBool('leaderboard_visible', true),
  agents:
    req.user.role === 'admin'
      ? db
          .prepare("SELECT id, name, email FROM users WHERE active = 1 AND pending_approval = 0 ORDER BY name, email")
          .all()
      : [],
  lists:
    req.user.role === 'admin'
      ? db.prepare('SELECT id, name FROM lists WHERE archived = 0 ORDER BY created_at DESC').all()
      : db
          .prepare(
            'SELECT l.id, l.name FROM lists l JOIN assignments a ON a.list_id = l.id ' +
              'WHERE a.user_id = ? AND l.archived = 0 ORDER BY l.created_at DESC'
          )
          .all(req.user.id),
})));

router.get('/run', wrap(async (req) => reports.run(queryOptions(req))));

router.get('/leaderboard', wrap(async (req) => {
  if (req.user.role !== 'admin' && !settings.getBool('leaderboard_visible', true)) {
    throw new Error('The team leaderboard is switched off.');
  }
  return reports.leaderboard({
    preset: req.query.preset || 'last_7',
    from: req.query.from,
    to: req.query.to,
    listId: req.query.list ? Number(req.query.list) : null,
  });
}));

router.get('/calls', wrap(async (req) => ({
  calls: reports.calls({ ...queryOptions(req), limit: Number(req.query.limit) || 500 }),
})));

/**
 * Compare two ranges - "am I doing better than last week?" is the question a
 * rep actually asks.
 */
router.get('/compare', wrap(async (req) => {
  const current = reports.run(queryOptions(req));
  const days =
    Math.round(
      (new Date(`${current.range.to}T12:00:00Z`) - new Date(`${current.range.from}T12:00:00Z`)) / 86400000
    ) + 1;
  const prevTo = reports.addDays(current.range.from, -1);
  const prevFrom = reports.addDays(prevTo, -(days - 1));
  const previous = reports.run({ ...queryOptions(req), preset: 'custom', from: prevFrom, to: prevTo });

  const keys = ['dials', 'connects', 'talkSeconds', 'contactRate', 'avgTalkSeconds', 'callbacksBooked'];
  const change = {};
  for (const k of keys) {
    const a = current.summary[k] || 0;
    const b = previous.summary[k] || 0;
    change[k] = { now: a, before: b, delta: a - b, pct: b ? (a - b) / b : null };
  }
  return { current, previous: { range: previous.range, summary: previous.summary }, change };
}));

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

router.get('/export', (req, res) => {
  try {
    const opts = queryOptions(req);
    const report = reports.run(opts);
    const rows = reports.calls({ ...opts, limit: 20000 });

    const s = report.summary;
    const fmtMins = (sec) => Math.round((sec / 60) * 10) / 10;

    const summarySheet = [
      ['Report', `${report.range.label} (${report.range.from} to ${report.range.to})`],
      ['Timezone', report.range.timezone],
      ['Who', req.user.role === 'admin' && !Array.isArray(report.scope) ? 'Everyone' : (Array.isArray(report.scope) ? report.scope : []).map(nameOf).join(', ')],
      [],
      ['DIALING'],
      ['Dials', s.dials],
      ['Connects', s.connects],
      ['Contact rate', `${(s.contactRate * 100).toFixed(1)}%`],
      ['Voicemails', s.voicemails],
      ['No answer', s.noAnswers],
      ['Busy', s.busy],
      ['Abandoned', s.abandons],
      ['Abandon rate', `${(s.abandonRate * 100).toFixed(1)}%`],
      ['Merchants reached', s.merchantsTouched],
      ['Dialed from a matching area code', `${(s.localRate * 100).toFixed(1)}%`],
      [],
      ['TALK TIME'],
      ['Total talk time (minutes)', fmtMins(s.talkSeconds)],
      ['Average per connect (minutes)', fmtMins(s.avgTalkSeconds)],
      ['Longest call (minutes)', fmtMins(s.longestTalkSeconds)],
      ['Hours on the dialer', Math.round(s.hoursOnDialer * 10) / 10],
      ['Talk minutes per hour on the dialer', s.talkPerHour === null ? '' : fmtMins(s.talkPerHour)],
      ['Dials per hour', s.dialsPerHour === null ? '' : Math.round(s.dialsPerHour * 10) / 10],
      ['Share of dialer time spent talking', s.utilisation === null ? '' : `${(s.utilisation * 100).toFixed(0)}%`],
      ['Days worked', s.activeDays],
      ['Dials per day worked', Math.round(s.dialsPerDay * 10) / 10],
      [],
      ['FOLLOW-UP'],
      ['Texts sent', s.textsSent],
      ['Replies received', s.textsReceived],
      ['Callbacks booked', s.callbacksBooked],
      ['Callbacks completed', s.callbacksCompleted],
      ['Callbacks missed', s.callbacksMissed],
      ['Deals moved a stage', s.stageMoves],
      ['Deals funded', s.funded],
    ];

    const seriesSheet = report.series.map((r) => ({
      [report.groupLabel]: r.label,
      Dials: r.dials,
      Connects: r.connects,
      'Contact rate': r.dials ? `${((r.connects / r.dials) * 100).toFixed(1)}%` : '',
      'Talk time (minutes)': fmtMins(r.talk_seconds),
      'Longest call (minutes)': fmtMins(r.longest_talk),
    }));

    const dispSheet = report.dispositions.map((d) => ({
      Disposition: d.label,
      Calls: d.n,
      'Talk time (minutes)': fmtMins(d.talkSeconds),
    }));

    const callSheet = rows.map((c) => ({
      When: c.local_time,
      Agent: c.agent || '',
      Business: c.company || '',
      Contact: [c.first_name, c.last_name].filter(Boolean).join(' '),
      Number: c.to_number,
      List: c.list_name || '',
      Outcome: c.outcome,
      Disposition: c.disposition,
      'Talk time (seconds)': c.talk_seconds,
      'Answered by': c.answered_by,
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheet), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(seriesSheet), report.groupLabel.slice(0, 28));
    if (dispSheet.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dispSheet), 'Dispositions');
    if (callSheet.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(callSheet), 'Every call');

    require('../audit').log(req, 'report.exported', {
      detail: `${report.range.from} to ${report.range.to}, ${rows.length} call rows`,
    });

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const who = req.user.role === 'admin' ? 'team' : (req.user.name || req.user.email).split(/[\s@]/)[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="dialing_report_${who}_${report.range.from}_to_${report.range.to}.xlsx"`
    );
    res.send(buf);
  } catch (err) {
    console.error('[reports] export', err);
    res.status(400).json({ error: err.message });
  }
});

function nameOf(id) {
  const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(id);
  return u ? u.name || u.email : `#${id}`;
}

module.exports = router;
