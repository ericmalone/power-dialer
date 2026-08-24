'use strict';

/**
 * Reporting.
 *
 * Everything a rep or a manager wants to know about dialing and talk time,
 * over any date range, grouped however they like. Reads straight from the
 * calls, sessions, messages and tasks tables - nothing is pre-aggregated, so
 * the numbers can never drift from reality.
 *
 * All dates are handled in the business's local timezone (REPORT_TIMEZONE),
 * not UTC, so "yesterday" means what a person means by it.
 */

const { db } = require('../db');
const config = require('../config');

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

/**
 * Hours to add to UTC to get local time in `tz`, on a given date.
 * Computed per report so a range that crosses a daylight-saving change still
 * lands on the right days for the bulk of it.
 */
function offsetHours(tz, at = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute)
    );
    return Math.round(((asUtc - at.getTime()) / 3600000) * 4) / 4;
  } catch {
    return 0;
  }
}

/** A SQLite datetime() modifier like '-4 hours' that shifts UTC into local. */
function tzModifier(tz, midpoint) {
  const h = offsetHours(tz, midpoint);
  return `${h >= 0 ? '+' : '-'}${Math.abs(h)} hours`;
}

// ---------------------------------------------------------------------------
// Range handling
// ---------------------------------------------------------------------------

const PRESETS = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  last_7: 'Last 7 days',
  last_30: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom range',
};

function localToday(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function startOfWeek(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((dow + 6) % 7)); // weeks start Monday
}

/** Turn a preset (or an explicit from/to) into inclusive local YYYY-MM-DD bounds. */
function resolveRange({ preset, from, to, tz }) {
  const today = localToday(tz);
  switch (preset) {
    case 'today':
      return { from: today, to: today, label: 'Today' };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1), label: 'Yesterday' };
    case 'this_week':
      return { from: startOfWeek(today), to: today, label: 'This week' };
    case 'last_week': {
      const start = addDays(startOfWeek(today), -7);
      return { from: start, to: addDays(start, 6), label: 'Last week' };
    }
    case 'last_30':
      return { from: addDays(today, -29), to: today, label: 'Last 30 days' };
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today, label: 'This month' };
    case 'last_month': {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev, label: 'Last month' };
    }
    case 'custom': {
      const f = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : addDays(today, -6);
      const t = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : today;
      return f <= t ? { from: f, to: t, label: 'Custom range' } : { from: t, to: f, label: 'Custom range' };
    }
    case 'last_7':
    default:
      return { from: addDays(today, -6), to: today, label: 'Last 7 days' };
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const GROUPINGS = {
  day: 'By day',
  hour: 'By hour of day',
  agent: 'By person',
  list: 'By call list',
  disposition: 'By disposition',
};

function groupExpression(groupBy, mod) {
  switch (groupBy) {
    case 'hour':
      return `strftime('%H', datetime(c.created_at, '${mod}'))`;
    case 'agent':
      return 'CAST(c.user_id AS TEXT)';
    case 'list':
      return 'CAST(COALESCE(l.list_id, 0) AS TEXT)';
    case 'disposition':
      return "CASE WHEN c.disposition = '' THEN '(none)' ELSE c.disposition END";
    case 'day':
    default:
      return `date(datetime(c.created_at, '${mod}'))`;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.user       the signed-in user (drives permissions)
 * @param {number[]} [opts.agentIds] whose numbers to include; admins only
 * @param {string} [opts.preset]
 * @param {string} [opts.from] YYYY-MM-DD
 * @param {string} [opts.to]   YYYY-MM-DD
 * @param {string} [opts.groupBy]
 * @param {number} [opts.listId]
 */
function run(opts) {
  const tz = config.reportTimezone;
  const range = resolveRange({ preset: opts.preset, from: opts.from, to: opts.to, tz });
  const mid = new Date(`${range.from}T12:00:00Z`);
  const mod = tzModifier(tz, mid);

  // Permissions: only an admin may look at anyone else's numbers.
  let agentIds;
  if (opts.user.role === 'admin') {
    agentIds = Array.isArray(opts.agentIds) && opts.agentIds.length ? opts.agentIds.map(Number) : null; // null = everyone
  } else {
    agentIds = [opts.user.id];
  }

  const groupBy = GROUPINGS[opts.groupBy] ? opts.groupBy : 'day';
  const listId = opts.listId ? Number(opts.listId) : null;

  const where = [`date(datetime(c.created_at, '${mod}')) BETWEEN @from AND @to`];
  const params = { from: range.from, to: range.to };
  if (agentIds) {
    where.push(`c.user_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})`);
    agentIds.forEach((id, i) => {
      params[`a${i}`] = id;
    });
  }
  if (listId) {
    where.push('l.list_id = @listId');
    params.listId = listId;
  }
  const whereSql = where.join(' AND ');
  const FROM = 'FROM calls c LEFT JOIN leads l ON l.id = c.lead_id';

  // --- headline numbers ----------------------------------------------------
  const totals = db
    .prepare(
      `SELECT
        COUNT(*) dials,
        SUM(CASE WHEN c.outcome='connected' THEN 1 ELSE 0 END) connects,
        SUM(CASE WHEN c.outcome='machine' THEN 1 ELSE 0 END) voicemails,
        SUM(CASE WHEN c.outcome='no_answer' THEN 1 ELSE 0 END) no_answers,
        SUM(CASE WHEN c.outcome='busy' THEN 1 ELSE 0 END) busy,
        SUM(CASE WHEN c.outcome='abandoned' THEN 1 ELSE 0 END) abandons,
        SUM(CASE WHEN c.outcome='failed' THEN 1 ELSE 0 END) failed,
        COALESCE(SUM(c.talk_seconds),0) talk_seconds,
        COALESCE(MAX(c.talk_seconds),0) longest_talk,
        SUM(CASE WHEN c.caller_id_match = 'area code' THEN 1 ELSE 0 END) local_dials,
        COUNT(DISTINCT c.lead_id) merchants_touched,
        COUNT(DISTINCT date(datetime(c.created_at, '${mod}'))) active_days
       ${FROM} WHERE ${whereSql}`
    )
    .get(params);

  // --- how long they were actually on the dialer ---------------------------
  const sessionWhere = [`date(datetime(s.started_at, '${mod}')) BETWEEN @from AND @to`];
  if (agentIds) sessionWhere.push(`s.user_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})`);
  const sessions = db
    .prepare(
      `SELECT COUNT(*) sessions,
        COALESCE(SUM(
          CAST((julianday(COALESCE(s.ended_at, datetime('now'))) - julianday(s.started_at)) * 86400 AS INTEGER)
        ),0) seconds
       FROM sessions_log s WHERE ${sessionWhere.join(' AND ')}`
    )
    .get(params);

  // Guard against a session left open overnight skewing everything.
  const sessionSeconds = Math.max(0, Math.min(sessions.seconds || 0, (totals.active_days || 1) * 16 * 3600 * (agentIds ? agentIds.length : 1)));

  // --- texts and callbacks in the same window ------------------------------
  const msgWhere = [`date(datetime(m.created_at, '${mod}')) BETWEEN @from AND @to`];
  if (agentIds) msgWhere.push(`m.user_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})`);
  const texts = db
    .prepare(
      `SELECT
        SUM(CASE WHEN m.direction='outbound' AND m.status <> 'blocked' THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN m.direction='inbound' THEN 1 ELSE 0 END) received
       FROM messages m WHERE ${msgWhere.join(' AND ')}`
    )
    .get(params);

  const taskWhere = [`date(datetime(t.created_at, '${mod}')) BETWEEN @from AND @to`];
  if (agentIds) taskWhere.push(`t.user_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})`);
  const callbacks = db
    .prepare(
      `SELECT COUNT(*) booked,
        SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN t.status='missed' THEN 1 ELSE 0 END) missed
       FROM tasks t WHERE ${taskWhere.join(' AND ')}`
    )
    .get(params);

  const actWhere = [`date(datetime(a.created_at, '${mod}')) BETWEEN @from AND @to`, "a.kind = 'stage'"];
  if (agentIds) actWhere.push(`a.user_id IN (${agentIds.map((_, i) => `@a${i}`).join(',')})`);
  const stageMoves = db
    .prepare(`SELECT COUNT(*) n FROM activities a WHERE ${actWhere.join(' AND ')}`)
    .get(params).n;
  const funded = db
    .prepare(
      `SELECT COUNT(*) n FROM activities a WHERE ${actWhere.join(' AND ')} AND a.meta_json LIKE '%"to":"funded"%'`
    )
    .get(params).n;

  // --- the series ----------------------------------------------------------
  const groupSql = groupExpression(groupBy, mod);
  const rows = db
    .prepare(
      `SELECT ${groupSql} AS bucket,
        COUNT(*) dials,
        SUM(CASE WHEN c.outcome='connected' THEN 1 ELSE 0 END) connects,
        COALESCE(SUM(c.talk_seconds),0) talk_seconds,
        COALESCE(MAX(c.talk_seconds),0) longest_talk
       ${FROM} WHERE ${whereSql} GROUP BY bucket ORDER BY bucket`
    )
    .all(params);

  const series = decorateSeries(rows, groupBy, range, mod, params, whereSql, FROM);

  // --- how long the conversations were -------------------------------------
  const spread = db
    .prepare(
      `SELECT
        SUM(CASE WHEN c.talk_seconds < 60 THEN 1 ELSE 0 END) under_1,
        SUM(CASE WHEN c.talk_seconds >= 60 AND c.talk_seconds < 180 THEN 1 ELSE 0 END) one_to_three,
        SUM(CASE WHEN c.talk_seconds >= 180 AND c.talk_seconds < 600 THEN 1 ELSE 0 END) three_to_ten,
        SUM(CASE WHEN c.talk_seconds >= 600 THEN 1 ELSE 0 END) over_ten
       ${FROM} WHERE ${whereSql} AND c.outcome='connected'`
    )
    .get(params);

  // --- what the calls turned into ------------------------------------------
  const dispositions = db
    .prepare(
      `SELECT COALESCE(NULLIF(c.disposition,''), '(none)') AS code, COUNT(*) n,
        COALESCE(SUM(c.talk_seconds),0) talk_seconds
       ${FROM} WHERE ${whereSql} AND c.outcome='connected' GROUP BY code ORDER BY n DESC`
    )
    .all(params);
  const dispLabels = new Map(db.prepare('SELECT code, label FROM dispositions').all().map((d) => [d.code, d.label]));

  const dials = totals.dials || 0;
  const connects = totals.connects || 0;
  const talk = totals.talk_seconds || 0;
  const hoursOnDialer = sessionSeconds / 3600;

  return {
    range: { ...range, timezone: tz },
    groupBy,
    groupLabel: GROUPINGS[groupBy],
    scope: agentIds ? agentIds : 'everyone',
    summary: {
      dials,
      connects,
      contactRate: dials ? connects / dials : 0,
      talkSeconds: talk,
      avgTalkSeconds: connects ? Math.round(talk / connects) : 0,
      longestTalkSeconds: totals.longest_talk || 0,
      voicemails: totals.voicemails || 0,
      noAnswers: totals.no_answers || 0,
      busy: totals.busy || 0,
      abandons: totals.abandons || 0,
      failed: totals.failed || 0,
      abandonRate: connects + (totals.abandons || 0) ? (totals.abandons || 0) / (connects + (totals.abandons || 0)) : 0,
      merchantsTouched: totals.merchants_touched || 0,
      localDials: totals.local_dials || 0,
      localRate: dials ? (totals.local_dials || 0) / dials : 0,
      activeDays: totals.active_days || 0,
      sessionSeconds,
      hoursOnDialer,
      dialsPerHour: hoursOnDialer > 0.05 ? dials / hoursOnDialer : null,
      talkPerHour: hoursOnDialer > 0.05 ? talk / hoursOnDialer : null,
      utilisation: sessionSeconds ? Math.min(1, talk / sessionSeconds) : null,
      dialsPerDay: totals.active_days ? dials / totals.active_days : 0,
      textsSent: texts.sent || 0,
      textsReceived: texts.received || 0,
      callbacksBooked: callbacks.booked || 0,
      callbacksCompleted: callbacks.completed || 0,
      callbacksMissed: callbacks.missed || 0,
      stageMoves: stageMoves || 0,
      funded: funded || 0,
    },
    series,
    talkSpread: [
      { label: 'Under 1 min', n: spread.under_1 || 0 },
      { label: '1 to 3 min', n: spread.one_to_three || 0 },
      { label: '3 to 10 min', n: spread.three_to_ten || 0 },
      { label: 'Over 10 min', n: spread.over_ten || 0 },
    ],
    dispositions: dispositions.map((d) => ({
      code: d.code,
      label: dispLabels.get(d.code) || (d.code === '(none)' ? 'Not dispositioned' : d.code),
      n: d.n,
      talkSeconds: d.talk_seconds,
    })),
  };
}

/** Turn raw bucket keys into readable labels, and fill in the empty days. */
function decorateSeries(rows, groupBy, range, mod, params, whereSql, FROM) {
  const byBucket = new Map(rows.map((r) => [String(r.bucket), r]));
  const blank = (bucket, label) => ({ bucket, label, dials: 0, connects: 0, talk_seconds: 0, longest_talk: 0 });

  if (groupBy === 'day') {
    const out = [];
    let d = range.from;
    let guard = 0;
    while (d <= range.to && guard++ < 400) {
      const hit = byBucket.get(d);
      const label = new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
      out.push(hit ? { ...hit, bucket: d, label } : blank(d, label));
      d = addDays(d, 1);
    }
    return out;
  }

  if (groupBy === 'hour') {
    const out = [];
    for (let h = 0; h < 24; h++) {
      const key = String(h).padStart(2, '0');
      const hit = byBucket.get(key);
      const label = `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
      out.push(hit ? { ...hit, bucket: key, label } : blank(key, label));
    }
    // Trim the dead hours at both ends so the chart is not mostly empty.
    const first = out.findIndex((r) => r.dials > 0);
    const last = out.length - 1 - [...out].reverse().findIndex((r) => r.dials > 0);
    return first === -1 ? out.slice(7, 21) : out.slice(Math.max(0, first - 1), Math.min(24, last + 2));
  }

  if (groupBy === 'agent') {
    const names = new Map(
      db.prepare('SELECT id, name, email FROM users').all().map((u) => [String(u.id), u.name || u.email])
    );
    return rows
      .map((r) => ({ ...r, label: names.get(String(r.bucket)) || 'Unknown' }))
      .sort((a, b) => b.dials - a.dials);
  }

  if (groupBy === 'list') {
    const names = new Map(db.prepare('SELECT id, name FROM lists').all().map((l) => [String(l.id), l.name]));
    return rows
      .map((r) => ({ ...r, label: names.get(String(r.bucket)) || 'No list' }))
      .sort((a, b) => b.dials - a.dials);
  }

  const dispLabels = new Map(db.prepare('SELECT code, label FROM dispositions').all().map((d) => [d.code, d.label]));
  return rows
    .map((r) => ({ ...r, label: dispLabels.get(r.bucket) || (r.bucket === '(none)' ? 'Not dispositioned' : r.bucket) }))
    .sort((a, b) => b.dials - a.dials);
}

/**
 * Side-by-side numbers for everyone on the floor. Reps can see this too - a
 * sales floor with a hidden leaderboard is a strange sales floor - but it is
 * switchable from Admin > Settings.
 */
function leaderboard({ preset, from, to, listId }) {
  const tz = config.reportTimezone;
  const range = resolveRange({ preset, from, to, tz });
  const mod = tzModifier(tz, new Date(`${range.from}T12:00:00Z`));

  const params = { from: range.from, to: range.to };
  const where = [`date(datetime(c.created_at, '${mod}')) BETWEEN @from AND @to`];
  if (listId) {
    where.push('l.list_id = @listId');
    params.listId = Number(listId);
  }

  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email,
        COUNT(c.id) dials,
        SUM(CASE WHEN c.outcome='connected' THEN 1 ELSE 0 END) connects,
        COALESCE(SUM(c.talk_seconds),0) talk_seconds,
        COALESCE(MAX(c.talk_seconds),0) longest_talk
       FROM users u
       LEFT JOIN calls c ON c.user_id = u.id AND ${where.join(' AND ')}
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE u.active = 1 AND u.pending_approval = 0
       GROUP BY u.id ORDER BY talk_seconds DESC, dials DESC`
    )
    .all(params);

  return {
    range,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name || r.email,
      dials: r.dials || 0,
      connects: r.connects || 0,
      contactRate: r.dials ? r.connects / r.dials : 0,
      talkSeconds: r.talk_seconds || 0,
      avgTalkSeconds: r.connects ? Math.round(r.talk_seconds / r.connects) : 0,
      longestTalkSeconds: r.longest_talk || 0,
    })),
  };
}

/** Raw call rows behind a report, for the table view and the export. */
function calls({ user, agentIds, preset, from, to, listId, limit = 5000 }) {
  const tz = config.reportTimezone;
  const range = resolveRange({ preset, from, to, tz });
  const mod = tzModifier(tz, new Date(`${range.from}T12:00:00Z`));

  let ids;
  if (user.role === 'admin') ids = Array.isArray(agentIds) && agentIds.length ? agentIds.map(Number) : null;
  else ids = [user.id];

  const where = [`date(datetime(c.created_at, '${mod}')) BETWEEN @from AND @to`];
  const params = { from: range.from, to: range.to, limit: Math.min(20000, limit) };
  if (ids) {
    where.push(`c.user_id IN (${ids.map((_, i) => `@a${i}`).join(',')})`);
    ids.forEach((id, i) => {
      params[`a${i}`] = id;
    });
  }
  if (listId) {
    where.push('l.list_id = @listId');
    params.listId = Number(listId);
  }

  return db
    .prepare(
      `SELECT datetime(c.created_at, '${mod}') AS local_time, u.name AS agent, l.company, l.first_name, l.last_name,
        c.to_number, c.outcome, c.disposition, c.talk_seconds, c.answered_by, li.name AS list_name
       FROM calls c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN lists li ON li.id = l.list_id
       WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT @limit`
    )
    .all(params);
}

module.exports = { run, leaderboard, calls, resolveRange, PRESETS, GROUPINGS, offsetHours, addDays };
