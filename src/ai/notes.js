'use strict';

/**
 * AI notes: one written note per dial that turned into a conversation.
 *
 * The model is told it is a merchant cash advance sales assistant, so it pulls
 * out the things an MCA desk actually needs - monthly revenue, time in
 * business, how many advances they already have, what they want the money for -
 * and writes the note a good rep would have written if they had the time.
 *
 * Notes are produced by a background worker so nothing blocks the dialer. A
 * failure here never affects a call.
 */

const config = require('../config');
const { db } = require('../db');
const realtime = require('../realtime');
const crm = require('../crm');
const tasks = require('../crm/tasks');
const transcribe = require('./transcribe');

let mockResponse = null;
let working = false;

/** Tests inject a canned model response instead of calling Anthropic. */
function setMock(obj) {
  mockResponse = obj;
}

// ---------------------------------------------------------------------------
// The tool the model must fill in
// ---------------------------------------------------------------------------

const NOTE_TOOL = {
  name: 'save_call_note',
  description: 'Record what happened on this merchant cash advance sales call.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'Two to four sentences describing what actually happened, in plain past tense. Name the merchant and what they said. No preamble, no "the rep called".',
      },
      interest: {
        type: 'string',
        enum: ['hot', 'warm', 'cold', 'dead', 'unclear'],
        description:
          'hot = wants funding now and engaged. warm = open but not urgent. cold = not now, revisit later. dead = told us no or does not qualify at all. unclear = too little was said.',
      },
      next_step: {
        type: 'string',
        description: 'The single concrete next action for the rep. Empty string if there is genuinely none.',
      },
      callback_minutes: {
        type: 'integer',
        description:
          'If the merchant asked to be called back at a particular time, how many minutes from now that is. 0 if no callback was agreed.',
      },
      objections: {
        type: 'array',
        items: { type: 'string' },
        description: 'Each objection or concern the merchant raised, in their own words where possible.',
      },
      monthly_revenue: { type: 'number', description: 'Monthly gross revenue in dollars, if stated. Omit if not stated.' },
      time_in_business_months: { type: 'integer', description: 'Months in business, if stated. Omit if not stated.' },
      requested_amount: { type: 'number', description: 'How much funding they asked for, in dollars. Omit if not stated.' },
      open_positions: {
        type: 'integer',
        description: 'How many advances or loans they already have outstanding. Omit if not stated.',
      },
      industry: { type: 'string', description: 'What the business does, if mentioned. Omit if not mentioned.' },
      use_of_funds: { type: 'string', description: 'What they said they would use the money for. Omit if not stated.' },
      fico: { type: 'integer', description: 'Credit score, if stated. Omit if not stated.' },
      nsf_count: { type: 'integer', description: 'Number of NSFs or negative days mentioned. Omit if not stated.' },
      suggested_stage: {
        type: 'string',
        enum: ['contacted', 'qualified', 'app_out', 'docs_in', 'dead'],
        description: 'Where this deal now sits in the pipeline based on the call. Omit if the call does not justify a move.',
      },
      risk_flags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything that should worry an underwriter or a compliance officer: stacking, bankruptcy, tax liens, restricted industry, the merchant asking not to be called again.',
      },
      coaching: {
        type: 'string',
        description: 'One sentence of specific, kind coaching for the rep about how they handled this call.',
      },
    },
    required: ['summary', 'interest', 'next_step', 'objections'],
  },
};

const SYSTEM_PROMPT = `You are a sales assistant for a merchant cash advance shop. You read a phone call between a funding rep and a small business owner, and write the CRM note.

What matters on an MCA desk, in order:
1. Monthly gross revenue and time in business - these decide whether the deal is fundable at all.
2. How many advances the merchant already has open ("positions"). Three or more is a problem worth flagging.
3. How much they want and what for.
4. Whether they will send bank statements. That is the real close on a first call.
5. Anything that would sink it in underwriting: NSFs, negative days, tax liens, bankruptcy, a restricted industry.

Rules:
- Only record a number the merchant actually said. Never estimate, infer, or round up. If they said "about twenty grand a month" record 20000; if they said nothing, omit the field entirely.
- Write the summary the way a good rep writes to their own future self: short, concrete, specific. Name what the merchant said, not what the rep did.
- Never invent an objection or a next step that was not really there.
- If the transcript is too thin to say anything useful, say so in the summary and set interest to "unclear".
- If the merchant asked not to be contacted again, put that first in risk_flags.
- Coaching should be one specific thing, said kindly. Skip it entirely rather than filling space.`;

// ---------------------------------------------------------------------------
// Talking to the model
// ---------------------------------------------------------------------------

async function callModel(userContent) {
  if (mockResponse) return typeof mockResponse === 'function' ? mockResponse(userContent) : mockResponse;
  if (!config.ai.apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

  const res = await fetch(`${config.ai.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.ai.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens,
      system: SYSTEM_PROMPT,
      tools: [NOTE_TOOL],
      tool_choice: { type: 'tool', name: 'save_call_note' },
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === 'tool_use');
  if (!block) throw new Error('The model did not return a note.');
  return block.input;
}

function buildPrompt({ lead, call, transcriptText, typedNotes, disposition, agent }) {
  const merchant = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown';
  const known = [];
  if (lead.monthly_revenue) known.push(`monthly revenue on file: $${Number(lead.monthly_revenue).toLocaleString()}`);
  if (lead.time_in_business_months) known.push(`time in business on file: ${lead.time_in_business_months} months`);
  if (lead.open_positions !== null && lead.open_positions !== undefined) known.push(`open positions on file: ${lead.open_positions}`);
  if (lead.requested_amount) known.push(`previously asked for: $${Number(lead.requested_amount).toLocaleString()}`);

  let extra = {};
  try {
    extra = JSON.parse(lead.extra_json || '{}');
  } catch {
    extra = {};
  }
  const extraLines = Object.entries(extra)
    .slice(0, 10)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  const parts = [
    `MERCHANT`,
    `  Business: ${lead.company || 'unknown'}`,
    `  Owner: ${merchant}`,
    `  Stage before this call: ${crm.stages.stage(lead.stage).label}`,
    known.length ? `  Already known: ${known.join('; ')}` : '',
    extraLines ? `  From the lead list:\n${extraLines}` : '',
    '',
    `CALL`,
    `  Rep: ${agent ? agent.name || agent.email : 'unknown'}`,
    `  Talk time: ${call.talk_seconds || 0} seconds`,
    `  Attempt number: ${lead.attempts || 1}`,
    disposition ? `  Rep marked it: ${disposition}` : '',
    '',
  ].filter(Boolean);

  if (transcriptText) {
    parts.push('TRANSCRIPT', transcriptText.slice(0, 60000), '');
  } else {
    parts.push(
      'NO TRANSCRIPT AVAILABLE for this call. Work only from the rep notes and the call facts below, and keep the summary modest about what is actually known.',
      ''
    );
  }
  if (typedNotes) parts.push('REP NOTES', typedNotes, '');

  parts.push('Write the CRM note using the save_call_note tool.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Called when a connected call ends. Creates the placeholder row. */
function queueForCall(callId) {
  if (!config.ai.enabled) return null;
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || !call.lead_id) return null;
  const existing = db.prepare('SELECT id FROM ai_notes WHERE call_id = ?').get(callId);
  if (existing) return existing.id;

  const info = db
    .prepare("INSERT INTO ai_notes (call_id, lead_id, user_id, status) VALUES (?,?,?,'pending')")
    .run(callId, call.lead_id, call.user_id);
  return info.lastInsertRowid;
}

/** Background sweep. Safe to call often; it does nothing when there is nothing to do. */
async function tick() {
  if (working || !config.ai.enabled) return;
  working = true;
  try {
    const pending = db
      .prepare("SELECT * FROM ai_notes WHERE status = 'pending' ORDER BY id LIMIT 5")
      .all();
    for (const note of pending) {
      // eslint-disable-next-line no-await-in-loop
      await processNote(note).catch((err) => {
        db.prepare("UPDATE ai_notes SET status='failed', error=? WHERE id=?").run(
          String(err.message || err).slice(0, 400),
          note.id
        );
      });
    }
  } finally {
    working = false;
  }
}

function tooEarly(note, call) {
  // Give the recording webhook a chance to land before we give up on audio.
  if (!config.recordCalls || !transcribe.available()) return false;
  const needsRecording = ['twilio', 'deepgram', 'openai'].includes(config.transcription.provider);
  if (!needsRecording) return false;
  if (call.recording_url) return false;
  const ageMinutes = (Date.now() - new Date(`${note.created_at}Z`).getTime()) / 60000;
  return ageMinutes < Math.min(3, config.transcription.maxWaitMinutes);
}

async function processNote(note) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(note.call_id);
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(note.lead_id);
  if (!call || !lead) {
    db.prepare("UPDATE ai_notes SET status='skipped', error='The call or lead was deleted.' WHERE id=?").run(note.id);
    return;
  }

  if ((call.talk_seconds || 0) < config.ai.minTalkSeconds && !call.notes) {
    db.prepare("UPDATE ai_notes SET status='skipped', error='Too short to be worth a note.' WHERE id=?").run(note.id);
    return;
  }

  if (tooEarly(note, call)) return; // try again on the next sweep

  const agent = call.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(call.user_id) : null;

  // 1. Transcript, if we can get one.
  let transcriptText = '';
  let source = 'metadata';
  if (config.recordCalls && transcribe.available()) {
    db.prepare("UPDATE ai_notes SET status='transcribing' WHERE id=?").run(note.id);
    try {
      const result = await transcribe.transcribe({ recordingUrl: call.recording_url, callSid: call.call_sid });
      if (result && result.text && result.text.trim()) {
        transcriptText = result.text.trim();
        source = 'transcript';
      }
    } catch (err) {
      console.warn('[ai] transcription failed, falling back to typed notes:', err.message);
    }
  }
  if (!transcriptText && call.notes) source = 'typed_notes';

  // 2. Ask the model.
  db.prepare("UPDATE ai_notes SET status='writing', transcript=?, source=? WHERE id=?").run(
    transcriptText.slice(0, 100000),
    source,
    note.id
  );

  const prompt = buildPrompt({
    lead,
    call,
    transcriptText,
    typedNotes: call.notes || lead.notes || '',
    disposition: call.disposition,
    agent,
  });
  const out = await callModel(prompt);

  // 3. Save.
  const extracted = {};
  for (const key of [
    'monthly_revenue',
    'time_in_business_months',
    'requested_amount',
    'open_positions',
    'industry',
    'use_of_funds',
    'fico',
    'nsf_count',
  ]) {
    if (out[key] !== undefined && out[key] !== null && out[key] !== '') extracted[key] = out[key];
  }

  db.prepare(
    "UPDATE ai_notes SET status='ready', summary=?, interest=?, next_step=?, objections=?, extracted_json=?, " +
      "coaching=?, model=?, ready_at=datetime('now'), error='' WHERE id=?"
  ).run(
    String(out.summary || '').slice(0, 4000),
    String(out.interest || 'unclear'),
    String(out.next_step || '').slice(0, 500),
    JSON.stringify(out.objections || []),
    JSON.stringify({ ...extracted, risk_flags: out.risk_flags || [], suggested_stage: out.suggested_stage || '' }),
    String(out.coaching || '').slice(0, 500),
    mockResponse ? 'mock' : config.ai.model,
    note.id
  );

  // 4. Put it on the merchant's timeline.
  crm.logActivity({
    leadId: lead.id,
    userId: call.user_id,
    kind: 'ai_note',
    title: `AI note - ${out.interest || 'unclear'}`,
    body: out.summary || '',
    callId: call.id,
    meta: {
      noteId: note.id,
      nextStep: out.next_step || '',
      objections: out.objections || [],
      riskFlags: out.risk_flags || [],
      source,
    },
  });

  // 5. Fill in the deal fields the rep did not have time to type.
  if (config.ai.autoFillFields && Object.keys(extracted).length) {
    try {
      crm.setFields(lead.id, extracted, call.user_id, { source: 'ai', onlyIfEmpty: true });
    } catch (err) {
      console.warn('[ai] could not apply extracted fields:', err.message);
    }
  }

  // 6. Move the deal along, but never past what a human already set.
  if (out.suggested_stage) {
    try {
      crm.advanceStage(lead.id, out.suggested_stage, call.user_id);
    } catch {
      /* stage moves are best-effort */
    }
  }

  // 7. Book the callback the merchant actually asked for.
  if (config.ai.autoCreateCallbacks && Number(out.callback_minutes) > 0 && call.user_id) {
    const already = db
      .prepare("SELECT 1 x FROM tasks WHERE lead_id=? AND status='open' AND kind='callback'")
      .get(lead.id);
    if (!already) {
      try {
        tasks.create({
          leadId: lead.id,
          userId: call.user_id,
          kind: 'callback',
          minutesFromNow: Math.min(Number(out.callback_minutes), 60 * 24 * 30),
          note: out.next_step || 'Callback the merchant asked for',
          createdBy: null,
        });
      } catch (err) {
        console.warn('[ai] could not create the callback:', err.message);
      }
    }
  }

  if (call.user_id) {
    realtime.toUser(call.user_id, 'ai:note', {
      noteId: note.id,
      leadId: lead.id,
      callId: call.id,
      summary: out.summary,
      interest: out.interest,
      nextStep: out.next_step,
    });
  }
  realtime.toAdmins('ai:note', { leadId: lead.id, interest: out.interest });
}

/** Rewrite a note on demand - used by the "redo" button. */
async function regenerate(noteId) {
  db.prepare("UPDATE ai_notes SET status='pending', error='' WHERE id=?").run(noteId);
  const note = db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(noteId);
  if (!note) throw new Error('That note no longer exists.');
  await processNote(note);
  return db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(noteId);
}

function status() {
  return {
    enabled: config.ai.enabled,
    hasKey: Boolean(config.ai.apiKey) || Boolean(mockResponse),
    model: config.ai.model,
    recording: config.recordCalls,
    transcription: transcribe.available() ? config.transcription.provider : 'off',
    minTalkSeconds: config.ai.minTalkSeconds,
  };
}

module.exports = { queueForCall, tick, processNote, regenerate, buildPrompt, status, setMock, NOTE_TOOL, SYSTEM_PROMPT };
