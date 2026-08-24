'use strict';

/**
 * The dialer engine.
 *
 * One agent = one "station". A station holds a persistent Twilio conference
 * (the agent's browser leg sits in it). When the agent is dialing we place up
 * to `lines` simultaneous outbound calls - a "burst". The first call that a
 * real human answers gets bridged into the agent's conference; the rest are
 * cancelled immediately. Anyone who answers after the agent is already taken
 * hears the abandon message and is re-queued.
 *
 * Everything here is in-memory + SQLite, single process. Run one instance.
 */

const { db, settings } = require('../db');
const config = require('../config');
const phone = require('../util/phone');
const realtime = require('../realtime');
const messenger = require('../sms/messenger');
const callerId = require('./callerId');
const crm = require('../crm');
const crmTasks = require('../crm/tasks');
const aiNotes = require('../ai/notes');
const { getClient, conferenceNameFor } = require('../twilioClient');

const STATUS = {
  OFFLINE: 'offline',
  READY: 'ready',
  DIALING: 'dialing',
  CONNECTED: 'connected',
  WRAP: 'wrap',
  PAUSED: 'paused',
};

/** @type {Map<number, Station>} */
const stations = new Map();
let burstCounter = 0;
let ticking = null;

// ---------------------------------------------------------------------------
// Station
// ---------------------------------------------------------------------------

function blankStats() {
  return { placed: 0, connects: 0, abandons: 0, machines: 0, noAnswers: 0, talkSeconds: 0 };
}

function getStation(userId) {
  let s = stations.get(userId);
  if (!s) {
    s = {
      userId,
      status: STATUS.OFFLINE,
      listId: null,
      lines: 1,
      sessionId: null,
      conference: conferenceNameFor(userId),
      agentCallSid: null,
      onCall: null, // { leadId, callSid, lead, startedAt }
      burst: null, // { id, calls: Map<sid, {leadId, phone}> }
      wrapUntil: 0,
      pendingDispositionCallId: null,
      lastError: null,
      stats: blankStats(),
      throttleNote: null,
    };
    stations.set(userId, s);
  }
  return s;
}

function snapshot(userId) {
  const s = getStation(userId);
  const lines = [];
  if (s.burst) {
    for (const [sid, info] of s.burst.calls) {
      lines.push({
        callSid: sid,
        leadId: info.leadId,
        name: info.name,
        phone: phone.format(info.phone),
        state: info.state,
      });
    }
  }
  return {
    userId,
    status: s.status,
    listId: s.listId,
    lines: s.lines,
    activeLines: lines,
    onCall: s.onCall
      ? {
          leadId: s.onCall.leadId,
          callSid: s.onCall.callSid,
          lead: s.onCall.lead,
          startedAt: s.onCall.startedAt,
        }
      : null,
    pendingDispositionCallId: s.pendingDispositionCallId,
    stats: s.stats,
    lastError: s.lastError,
    throttleNote: s.throttleNote,
    wrapRemaining: Math.max(0, Math.ceil((s.wrapUntil - Date.now()) / 1000)),
  };
}

function push(userId) {
  const snap = snapshot(userId);
  realtime.toUser(userId, 'station', snap);
  realtime.toAdmins('station:admin', snap);
}

function setStatus(s, status) {
  if (s.status === status) return;
  s.status = status;
  push(s.userId);
}

// ---------------------------------------------------------------------------
// Lead queue
// ---------------------------------------------------------------------------

const CANDIDATE_SQL = `
  SELECT l.* FROM leads l
  WHERE l.list_id = @listId
    AND l.phone IS NOT NULL
    AND l.status IN ('new','queued')
    AND l.locked_by IS NULL
    AND (l.next_attempt IS NULL OR l.next_attempt <= datetime('now'))
    AND NOT EXISTS (SELECT 1 FROM dnc d WHERE d.phone = l.phone)
  ORDER BY (l.attempts) ASC, l.row_index ASC
  LIMIT @limit
`;

/**
 * Claim up to `n` dialable leads for an agent. Returns array of lead rows.
 * Skips leads that fall outside legal calling hours in their own timezone.
 */
function claimLeads(userId, listId, n) {
  const candidates = db.prepare(CANDIDATE_SQL).all({ listId, limit: n * 6 + 10 });
  const picked = [];
  const deferred = [];

  for (const lead of candidates) {
    if (picked.length >= n) break;
    if (config.enforceCallingHours) {
      const hours = phone.withinCallingHours(
        lead.phone,
        config.callingHoursStart,
        config.callingHoursEnd
      );
      if (!hours.ok) {
        deferred.push(lead.id);
        continue;
      }
    }
    picked.push(lead);
  }

  if (deferred.length) {
    // Push out-of-hours leads to the next legal window so we stop re-scanning them.
    const stmt = db.prepare(
      "UPDATE leads SET next_attempt = datetime('now','+45 minutes') WHERE id = ?"
    );
    const tx = db.transaction((ids) => ids.forEach((id) => stmt.run(id)));
    tx(deferred);
  }

  if (!picked.length) return [];

  const lock = db.prepare(
    "UPDATE leads SET locked_by = ?, locked_at = datetime('now'), status = 'calling', " +
      "attempts = attempts + 1, last_attempt = datetime('now'), updated_at = datetime('now') " +
      'WHERE id = ? AND locked_by IS NULL'
  );
  const claimed = [];
  const tx = db.transaction((leads) => {
    for (const l of leads) {
      const res = lock.run(userId, l.id);
      if (res.changes === 1) claimed.push(l);
    }
  });
  tx(picked);
  return claimed;
}

function releaseLead(leadId, { status = 'queued', delayMinutes = 0 } = {}) {
  db.prepare(
    'UPDATE leads SET locked_by = NULL, locked_at = NULL, status = ?, ' +
      "next_attempt = CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' minutes') ELSE next_attempt END, " +
      "updated_at = datetime('now') WHERE id = ?"
  ).run(status, delayMinutes, delayMinutes, leadId);
}

function leadPublic(lead) {
  if (!lead) return null;
  let extra = {};
  try {
    extra = JSON.parse(lead.extra_json || '{}');
  } catch {
    extra = {};
  }
  return {
    id: lead.id,
    firstName: lead.first_name,
    lastName: lead.last_name,
    company: lead.company,
    email: lead.email,
    phone: lead.phone,
    phoneDisplay: phone.format(lead.phone),
    timezone: lead.timezone,
    localHour: phone.localHour(lead.phone),
    attempts: lead.attempts,
    notes: lead.notes,
    stage: lead.stage,
    deal: {
      monthlyRevenue: lead.monthly_revenue,
      timeInBusinessMonths: lead.time_in_business_months,
      requestedAmount: lead.requested_amount,
      openPositions: lead.open_positions,
      industry: lead.industry,
      fico: lead.fico,
      useOfFunds: lead.use_of_funds,
    },
    extra,
  };
}

// ---------------------------------------------------------------------------
// Caller ID selection
// ---------------------------------------------------------------------------

/**
 * Which number this merchant should see. Local first - see callerId.js.
 * Returns the E.164 string, or null when no caller ID is configured.
 */
function pickCallerId(leadPhone, leadId = null) {
  const choice = callerId.pick({ toNumber: leadPhone, leadId });
  return choice ? choice.phone : null;
}

// ---------------------------------------------------------------------------
// Public controls
// ---------------------------------------------------------------------------

function agentOnline(userId, agentCallSid) {
  const s = getStation(userId);
  s.agentCallSid = agentCallSid || s.agentCallSid;
  if (s.status === STATUS.OFFLINE) setStatus(s, STATUS.PAUSED);
  push(userId);
}

function agentOffline(userId) {
  const s = getStation(userId);
  cancelBurst(s, 'agent_offline');
  endSession(s);
  s.agentCallSid = null;
  s.onCall = null;
  s.listId = null;
  s.status = STATUS.OFFLINE;
  push(userId);
}

function start(userId, { listId, lines }) {
  const s = getStation(userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Unknown user.');
  if (!s.agentCallSid && s.status === STATUS.OFFLINE) {
    throw new Error('Your phone is not connected yet. Click "Connect phone" first.');
  }

  const list = db.prepare('SELECT * FROM lists WHERE id = ? AND archived = 0').get(listId);
  if (!list) throw new Error('That call list no longer exists.');

  const ceiling = Math.min(config.maxLinesPerAgent, user.max_lines || config.maxLinesPerAgent);
  s.lines = Math.max(1, Math.min(ceiling, Number(lines) || 1));
  s.listId = listId;
  s.lastError = null;

  if (!s.sessionId) {
    const info = db
      .prepare('INSERT INTO sessions_log (user_id, list_id, lines) VALUES (?,?,?)')
      .run(userId, listId, s.lines);
    s.sessionId = info.lastInsertRowid;
    s.stats = blankStats();
  }

  s.wrapUntil = 0;
  setStatus(s, STATUS.READY);
  ensureTicking();
  push(userId);
  return snapshot(userId);
}

function pause(userId, reason = 'break') {
  const s = getStation(userId);
  cancelBurst(s, 'paused');
  if (s.status !== STATUS.CONNECTED) {
    setStatus(s, STATUS.PAUSED);
  } else {
    // Finish the live conversation, then stop.
    s.pauseAfterCall = true;
  }
  s.pauseReason = reason;
  push(userId);
  return snapshot(userId);
}

function resume(userId) {
  const s = getStation(userId);
  if (!s.listId) throw new Error('Pick a call list first.');
  s.pauseAfterCall = false;
  s.wrapUntil = 0;
  setStatus(s, STATUS.READY);
  ensureTicking();
  push(userId);
  return snapshot(userId);
}

function stop(userId) {
  const s = getStation(userId);
  cancelBurst(s, 'stopped');
  hangupLead(userId).catch(() => {});
  if (s.onCall) {
    releaseLead(s.onCall.leadId, { status: 'queued', delayMinutes: 0 });
    s.onCall = null;
  }
  s.burst = null;
  s.wrapUntil = 0;
  endSession(s);
  s.pauseAfterCall = false;
  setStatus(s, s.agentCallSid ? STATUS.PAUSED : STATUS.OFFLINE);
  push(userId);
  return snapshot(userId);
}

function endSession(s) {
  if (!s.sessionId) return;
  db.prepare(
    "UPDATE sessions_log SET ended_at = datetime('now'), calls_placed = ?, connects = ?, " +
      'abandons = ?, talk_seconds = ? WHERE id = ?'
  ).run(s.stats.placed, s.stats.connects, s.stats.abandons, s.stats.talkSeconds, s.sessionId);
  s.sessionId = null;
}

/** Hang up just the lead, keeping the agent in their room. */
async function hangupLead(userId) {
  const s = getStation(userId);
  if (!s.onCall) return false;
  const sid = s.onCall.callSid;
  try {
    await getClient().calls(sid).update({ status: 'completed' });
  } catch (err) {
    // Already gone - the status webhook will tidy up.
  }
  return true;
}

/** Dial one specific lead on a single line (manual / callback). */
async function dialOne(userId, leadId) {
  const s = getStation(userId);
  if (!s.agentCallSid) throw new Error('Connect your phone first.');
  if (s.onCall) throw new Error('You are already on a call.');
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead || !lead.phone) throw new Error('That lead has no valid phone number.');
  const onDnc = db.prepare('SELECT 1 FROM dnc WHERE phone = ?').get(lead.phone);
  if (onDnc) throw new Error('That number is on your Do Not Call list.');

  db.prepare(
    "UPDATE leads SET locked_by = ?, locked_at = datetime('now'), status='calling', " +
      "attempts = attempts + 1, last_attempt = datetime('now') WHERE id = ?"
  ).run(userId, leadId);

  s.listId = s.listId || lead.list_id;
  if (!s.sessionId) {
    const info = db
      .prepare('INSERT INTO sessions_log (user_id, list_id, lines) VALUES (?,?,1)')
      .run(userId, lead.list_id);
    s.sessionId = info.lastInsertRowid;
  }
  setStatus(s, STATUS.DIALING);
  await placeBurst(s, [lead]);
  return snapshot(userId);
}

// ---------------------------------------------------------------------------
// Bursts
// ---------------------------------------------------------------------------

function ensureTicking() {
  if (ticking) return;
  ticking = setInterval(tick, 1000);
  if (ticking.unref) ticking.unref();
}

function tick() {
  let anyActive = false;
  for (const s of stations.values()) {
    if (s.status === STATUS.OFFLINE) continue;
    anyActive = true;
    if (s.status !== STATUS.READY) continue;
    if (Date.now() < s.wrapUntil) continue;
    if (s.burst && s.burst.calls.size) continue;
    if (s.onCall) continue;
    if (!s.listId) continue;
    startBurst(s).catch((err) => {
      s.lastError = err.message;
      setStatus(s, STATUS.PAUSED);
      push(s.userId);
    });
  }
  if (!anyActive && ticking) {
    clearInterval(ticking);
    ticking = null;
  }
}

async function startBurst(s) {
  const lines = effectiveLines(s);
  const leads = claimLeads(s.userId, s.listId, lines);
  if (!leads.length) {
    const remaining = db
      .prepare(
        "SELECT COUNT(*) c FROM leads WHERE list_id = ? AND status IN ('new','queued')"
      )
      .get(s.listId).c;
    s.lastError = remaining
      ? 'Waiting - remaining leads are outside calling hours or scheduled for later.'
      : 'This list is finished. Nice work.';
    setStatus(s, remaining ? STATUS.READY : STATUS.PAUSED);
    s.wrapUntil = Date.now() + 15000;
    push(s.userId);
    return;
  }
  s.lastError = null;
  setStatus(s, STATUS.DIALING);
  await placeBurst(s, leads);
}

/** Lower the line count automatically if we are abandoning too many calls. */
function effectiveLines(s) {
  if (!settings.getBool('auto_throttle', true)) return s.lines;
  const attempts = s.stats.connects + s.stats.abandons;
  if (attempts < 20) {
    s.throttleNote = null;
    return s.lines;
  }
  const rate = s.stats.abandons / attempts;
  if (rate > 0.03 && s.lines > 1) {
    const reduced = Math.max(1, s.lines - 1);
    s.throttleNote = `Abandon rate ${(rate * 100).toFixed(1)}% - lines trimmed to ${reduced} to stay under the 3% safe-harbour limit.`;
    return reduced;
  }
  s.throttleNote = null;
  return s.lines;
}

async function placeBurst(s, leads) {
  const burstId = `b${++burstCounter}-${s.userId}`;
  s.burst = { id: burstId, calls: new Map() };

  const answerUrl = `${config.publicUrl}/twiml/lead-answer`;
  const statusUrl = `${config.publicUrl}/webhooks/call-status`;
  const amdUrl = `${config.publicUrl}/webhooks/amd`;

  // A list can override the global recording switch, so you can record the
  // lists you have consent for and leave the rest alone.
  const list = s.listId ? db.prepare('SELECT record_calls FROM lists WHERE id = ?').get(s.listId) : null;
  const recordThisList =
    list && list.record_calls !== null && list.record_calls !== undefined
      ? Boolean(list.record_calls)
      : config.recordCalls;

  const results = await Promise.allSettled(
    leads.map(async (lead) => {
      const choice = callerId.pick({ toNumber: lead.phone, leadId: lead.id });
      if (!choice) throw new Error('No caller ID numbers configured. Add one in Admin > Numbers.');
      const from = choice.phone;

      const params = {
        to: lead.phone,
        from,
        url: `${answerUrl}?burst=${encodeURIComponent(burstId)}&agent=${s.userId}&lead=${lead.id}&rec=${recordThisList ? 1 : 0}`,
        method: 'POST',
        timeout: config.ringTimeout,
        statusCallback: `${statusUrl}?agent=${s.userId}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      };

      if (config.enableAmd) {
        params.machineDetection = 'Enable';
        params.machineDetectionTimeout = 15;
        params.asyncAmdStatusCallback = amdUrl;
      }
      if (recordThisList) {
        params.record = true;
        params.recordingChannels = 'dual';
        params.recordingStatusCallback = `${config.publicUrl}/webhooks/recording`;
        params.recordingStatusCallbackEvent = ['completed'];
      }

      const call = await getClient().calls.create(params);

      db.prepare(
        'INSERT INTO calls (call_sid, session_id, burst_id, lead_id, user_id, from_number, to_number, status, caller_id_match) ' +
          "VALUES (?,?,?,?,?,?,?,'queued',?)"
      ).run(call.sid, s.sessionId, burstId, lead.id, s.userId, from, lead.phone, choice.match);

      s.burst.calls.set(call.sid, {
        leadId: lead.id,
        phone: lead.phone,
        name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company || 'Lead',
        state: 'dialing',
        lead,
      });
      s.stats.placed += 1;
      return call.sid;
    })
  );

  const failures = results.filter((r) => r.status === 'rejected');
  for (const f of failures) {
    s.lastError = f.reason && f.reason.message ? f.reason.message : String(f.reason);
  }
  // Any lead whose call never got created must be released.
  const placedLeadIds = new Set([...s.burst.calls.values()].map((c) => c.leadId));
  for (const lead of leads) {
    if (!placedLeadIds.has(lead.id)) releaseLead(lead.id, { status: 'queued', delayMinutes: 5 });
  }

  if (!s.burst.calls.size) {
    s.burst = null;
    setStatus(s, STATUS.PAUSED);
  }
  push(s.userId);
}

function cancelBurst(s, why = 'cancel') {
  if (!s.burst) return;
  const client = safeClient();
  for (const [sid, info] of s.burst.calls) {
    if (s.onCall && s.onCall.callSid === sid) continue;
    if (client) {
      client
        .calls(sid)
        .update({ status: 'canceled' })
        .catch(() => {});
    }
    db.prepare("UPDATE calls SET outcome = COALESCE(NULLIF(outcome,''),'canceled') WHERE call_sid = ?").run(sid);
    releaseLead(info.leadId, { status: 'queued', delayMinutes: 0 });
  }
  s.burst = null;
}

function safeClient() {
  try {
    return getClient();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inbound events from Twilio
// ---------------------------------------------------------------------------

/**
 * A lead's call was answered. Decide what TwiML that lead should hear.
 * Returns { action: 'bridge'|'abandon'|'machine'|'reject', conference, station }
 */
function onLeadAnswered({ callSid, agentId, leadId, answeredBy }) {
  const s = getStation(Number(agentId));
  const burstInfo = s.burst && s.burst.calls.get(callSid);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

  const machine = answeredBy && /^(machine|fax)/i.test(answeredBy);

  db.prepare(
    "UPDATE calls SET status = 'in-progress', answered_at = datetime('now'), answered_by = ? WHERE call_sid = ?"
  ).run(answeredBy || '', callSid);

  if (machine) {
    s.stats.machines += 1;
    if (burstInfo) burstInfo.state = 'voicemail';
    db.prepare("UPDATE calls SET outcome = 'machine' WHERE call_sid = ?").run(callSid);
    db.prepare(
      "UPDATE leads SET status='queued', locked_by=NULL, locked_at=NULL, " +
        "next_attempt = datetime('now','+240 minutes'), updated_at=datetime('now') WHERE id = ?"
    ).run(leadId);
    fireSmsRules(s, 'voicemail', leadId, callSid);
    push(s.userId);
    return { action: 'machine', station: s, lead };
  }

  const agentAvailable =
    !s.onCall &&
    s.agentCallSid &&
    (s.status === STATUS.DIALING || s.status === STATUS.READY) &&
    s.burst &&
    s.burst.calls.has(callSid);

  if (!agentAvailable) {
    s.stats.abandons += 1;
    db.prepare("UPDATE calls SET outcome = 'abandoned' WHERE call_sid = ?").run(callSid);
    db.prepare(
      "UPDATE leads SET status='queued', locked_by=NULL, locked_at=NULL, " +
        "next_attempt = datetime('now','+90 minutes'), updated_at=datetime('now') WHERE id = ?"
    ).run(leadId);
    if (s.burst) s.burst.calls.delete(callSid);
    fireSmsRules(s, 'abandoned', leadId, callSid);
    push(s.userId);
    return { action: 'abandon', station: s, lead };
  }

  // Claim the agent. Synchronous - no other request can interleave here.
  s.onCall = {
    leadId: Number(leadId),
    callSid,
    lead: leadPublic(lead),
    startedAt: Date.now(),
  };
  s.stats.connects += 1;
  burstInfo.state = 'connected';
  db.prepare("UPDATE calls SET outcome = 'connected' WHERE call_sid = ?").run(callSid);
  db.prepare(
    "UPDATE leads SET status='contacted', worked_by=?, owner_id=COALESCE(owner_id, ?), " +
      "last_contact_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
  ).run(s.userId, s.userId, leadId);
  try {
    crm.advanceStage(leadId, 'contacted', s.userId);
  } catch {
    /* stage moves are best-effort */
  }

  // Drop every other line in this burst right now.
  const client = safeClient();
  for (const [sid, info] of s.burst.calls) {
    if (sid === callSid) continue;
    if (client) client.calls(sid).update({ status: 'canceled' }).catch(() => {});
    db.prepare("UPDATE calls SET outcome = COALESCE(NULLIF(outcome,''),'canceled') WHERE call_sid = ?").run(sid);
    releaseLead(info.leadId, { status: 'queued', delayMinutes: 0 });
    s.burst.calls.delete(sid);
  }

  setStatus(s, STATUS.CONNECTED);
  realtime.toUser(s.userId, 'connected', { lead: leadPublic(lead), callSid });
  push(s.userId);
  return { action: 'bridge', station: s, lead, conference: s.conference };
}

/**
 * Fire any auto-text rules for this outcome. Never let a texting problem take
 * the dialer down - the call is what matters.
 */
function fireSmsRules(station, trigger, leadId, callSid, disposition = '') {
  try {
    const call = callSid ? db.prepare('SELECT id FROM calls WHERE call_sid = ?').get(callSid) : null;
    messenger.runRules({
      trigger,
      disposition,
      leadId: Number(leadId),
      userId: station.userId,
      callId: call ? call.id : null,
      listId: station.listId,
    });
  } catch (err) {
    console.error('[engine] auto-text rule failed', err);
  }
}

/** Twilio status callback for a lead call. */
function onCallStatus({ callSid, agentId, callStatus, duration, answeredBy }) {
  const s = getStation(Number(agentId));
  const row = db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid);

  db.prepare('UPDATE calls SET status = ?, duration = ? WHERE call_sid = ?').run(
    callStatus,
    Number(duration) || 0,
    callSid
  );
  if (answeredBy) {
    db.prepare('UPDATE calls SET answered_by = ? WHERE call_sid = ?').run(answeredBy, callSid);
  }

  const info = s.burst && s.burst.calls.get(callSid);
  if (info && (callStatus === 'ringing' || callStatus === 'in-progress')) {
    info.state = callStatus === 'ringing' ? 'ringing' : info.state;
    push(s.userId);
  }

  if (!['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) return;

  db.prepare("UPDATE calls SET ended_at = datetime('now') WHERE call_sid = ?").run(callSid);

  const wasConnected = s.onCall && s.onCall.callSid === callSid;

  if (!wasConnected && row) {
    if (!row.outcome || row.outcome === '') {
      const outcome =
        callStatus === 'no-answer' ? 'no_answer' : callStatus === 'busy' ? 'busy' : callStatus === 'failed' ? 'failed' : 'canceled';
      db.prepare('UPDATE calls SET outcome = ? WHERE call_sid = ?').run(outcome, callSid);
      if (callStatus === 'no-answer') s.stats.noAnswers += 1;
      if (row.lead_id && (outcome === 'no_answer' || outcome === 'busy')) {
        fireSmsRules(s, outcome === 'busy' ? 'busy' : 'no_answer', row.lead_id, callSid);
      }
    }
    if (row.lead_id) {
      const delay = callStatus === 'busy' ? 20 : callStatus === 'no-answer' ? 180 : 0;
      const lead = db.prepare('SELECT status FROM leads WHERE id = ?').get(row.lead_id);
      if (lead && lead.status === 'calling') releaseLead(row.lead_id, { status: 'queued', delayMinutes: delay });
    }
  }

  if (s.burst) {
    s.burst.calls.delete(callSid);
    if (!s.burst.calls.size && !s.onCall) s.burst = null;
  }

  if (wasConnected) {
    const talk = Number(duration) || Math.round((Date.now() - s.onCall.startedAt) / 1000);
    s.stats.talkSeconds += talk;
    db.prepare('UPDATE calls SET talk_seconds = ? WHERE call_sid = ?').run(talk, callSid);
    const finishedLeadId = s.onCall.leadId;
    const finishedCallId = row ? row.id : null;

    try {
      crm.logActivity({
        leadId: finishedLeadId,
        userId: s.userId,
        kind: 'call',
        title: `Spoke for ${Math.round(talk / 60) || '<1'} min`,
        callId: finishedCallId,
        meta: { talkSeconds: talk, outcome: 'connected' },
      });
      if (finishedCallId) aiNotes.queueForCall(finishedCallId);
    } catch (err) {
      console.error('[engine] could not log the call', err);
    }

    fireSmsRules(s, 'answered', finishedLeadId, callSid);
    s.onCall = null;
    s.pendingDispositionCallId = finishedCallId;
    s.wrapUntil = Date.now() + config.wrapUpSeconds * 1000;
    setStatus(s, s.pauseAfterCall ? STATUS.PAUSED : STATUS.WRAP);
    realtime.toUser(s.userId, 'call:ended', {
      leadId: finishedLeadId,
      callId: finishedCallId,
      talkSeconds: talk,
    });
  } else if (s.status === STATUS.DIALING && !s.burst) {
    setStatus(s, s.pauseAfterCall ? STATUS.PAUSED : STATUS.READY);
  }

  push(s.userId);
}

/** Async AMD result (arrives after the call is already bridged). */
function onAmd({ callSid, agentId, answeredBy }) {
  const s = getStation(Number(agentId));
  db.prepare('UPDATE calls SET answered_by = ? WHERE call_sid = ?').run(answeredBy || '', callSid);
  if (s.onCall && s.onCall.callSid === callSid && /^(machine|fax)/i.test(answeredBy || '')) {
    realtime.toUser(s.userId, 'toast', {
      kind: 'warn',
      text: 'Answering machine detected on this line.',
    });
  }
}

/**
 * Save a disposition for the just-finished (or current) call and, unless the
 * agent asked to stop, immediately go back to dialing.
 */
function disposition(userId, { callId, code, notes, callbackMinutes }) {
  const s = getStation(userId);
  const id = callId || s.pendingDispositionCallId;
  const call = id ? db.prepare('SELECT * FROM calls WHERE id = ?').get(id) : null;

  const disp = code ? db.prepare('SELECT * FROM dispositions WHERE code = ?').get(code) : null;

  if (call) {
    db.prepare('UPDATE calls SET disposition = ?, notes = ? WHERE id = ?').run(code || '', notes || '', call.id);
    if (call.lead_id) {
      const finalStatus =
        disp && disp.kind === 'dnc'
          ? 'dnc'
          : disp && disp.kind === 'callback'
          ? 'queued'
          : disp && (disp.kind === 'good' || disp.kind === 'bad')
          ? 'done'
          : 'queued';

      db.prepare(
        'UPDATE leads SET disposition = ?, notes = CASE WHEN ? <> \'\' THEN ? ELSE notes END, ' +
          "status = ?, locked_by = NULL, locked_at = NULL, worked_by = ?, updated_at = datetime('now'), " +
          "next_attempt = CASE WHEN ? > 0 THEN datetime('now','+' || ? || ' minutes') ELSE NULL END " +
          'WHERE id = ?'
      ).run(
        code || '',
        notes || '',
        notes || '',
        finalStatus,
        userId,
        callbackMinutes || 0,
        callbackMinutes || 0,
        call.lead_id
      );

      if (disp && disp.kind === 'dnc') {
        const lead = db.prepare('SELECT phone FROM leads WHERE id = ?').get(call.lead_id);
        if (lead && lead.phone) {
          db.prepare(
            'INSERT OR IGNORE INTO dnc (phone, reason, added_by) VALUES (?,?,?)'
          ).run(lead.phone, 'Requested on call', userId);
        }
      }

      // CRM side: timeline entry, pipeline move, and the callback the rep asked for.
      try {
        if (notes) {
          crm.logActivity({
            leadId: call.lead_id,
            userId,
            kind: 'note',
            title: disp ? disp.label : 'Note',
            body: notes,
            callId: call.id,
          });
        }
        const nextStage = crm.stages.DISPOSITION_TO_STAGE[code];
        if (nextStage) {
          if (nextStage === 'dead' || nextStage === 'declined') {
            crm.setStage(call.lead_id, nextStage, userId, { reason: disp ? disp.label : '' });
          } else {
            crm.advanceStage(call.lead_id, nextStage, userId);
          }
        }
        if (callbackMinutes > 0) {
          crmTasks.create({
            leadId: call.lead_id,
            userId,
            kind: 'callback',
            minutesFromNow: callbackMinutes,
            note: notes || '',
          });
        }
      } catch (err) {
        console.error('[engine] CRM update after disposition failed', err);
      }
    }
  }

  if (call && call.lead_id && code) {
    const disp2 = disp;
    if (!disp2 || disp2.kind !== 'dnc') {
      fireSmsRules(s, 'disposition', call.lead_id, call.call_sid, code);
    }
  }

  s.pendingDispositionCallId = null;
  if (s.status === STATUS.WRAP && !s.pauseAfterCall) {
    s.wrapUntil = 0;
    setStatus(s, STATUS.READY);
    ensureTicking();
  }
  push(userId);
  return snapshot(userId);
}

function setLines(userId, lines) {
  const s = getStation(userId);
  const user = db.prepare('SELECT max_lines FROM users WHERE id = ?').get(userId);
  const ceiling = Math.min(config.maxLinesPerAgent, (user && user.max_lines) || config.maxLinesPerAgent);
  s.lines = Math.max(1, Math.min(ceiling, Number(lines) || 1));
  push(userId);
  return snapshot(userId);
}

/** All stations, for the admin live monitor. */
function allStations() {
  return [...stations.keys()].map((id) => {
    const u = db.prepare('SELECT id,name,email FROM users WHERE id = ?').get(id);
    return { ...snapshot(id), agent: u || { id, name: 'Unknown', email: '' } };
  });
}

/** Release any leads left locked by a crash / restart. */
function reclaimStaleLocks() {
  const res = db
    .prepare(
      "UPDATE leads SET locked_by = NULL, locked_at = NULL, status = 'queued' " +
        "WHERE locked_by IS NOT NULL AND locked_at < datetime('now','-10 minutes')"
    )
    .run();
  if (res.changes) console.log(`[engine] Released ${res.changes} stale lead lock(s).`);
}

module.exports = {
  STATUS,
  getStation,
  snapshot,
  allStations,
  agentOnline,
  agentOffline,
  start,
  pause,
  resume,
  stop,
  setLines,
  dialOne,
  hangupLead,
  disposition,
  onLeadAnswered,
  onCallStatus,
  onAmd,
  reclaimStaleLocks,
  claimLeads,
  releaseLead,
  pickCallerId,
  leadPublic,
  ensureTicking,
  _stations: stations,
};
