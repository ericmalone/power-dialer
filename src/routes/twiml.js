'use strict';

/**
 * TwiML endpoints. Twilio (not the browser) calls these.
 */

const express = require('express');
const twilio = require('twilio');
const config = require('../config');
const { db, settings } = require('../db');
const engine = require('../dialer/engine');
const { userIdFromIdentity, conferenceNameFor } = require('../twilioClient');

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/** Verify the request really came from Twilio. */
function verifyTwilio(req, res, next) {
  if (!config.twilio.authToken) return next(); // unconfigured dev box
  if (process.env.SKIP_TWILIO_SIGNATURE === 'true') return next();

  const signature = req.get('X-Twilio-Signature');
  const url = `${config.publicUrl}${req.originalUrl}`;
  const valid = twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {});
  if (valid) return next();

  console.warn(`[twiml] Rejected unsigned request to ${req.originalUrl}`);
  return res.status(403).type('text/plain').send('Invalid Twilio signature.');
}

function xml(res, twiml) {
  res.type('text/xml').send(twiml.toString());
}

// ---------------------------------------------------------------------------
// The agent's browser leg -> park them in their own conference room.
// Point your TwiML App's Voice Request URL at this endpoint.
// ---------------------------------------------------------------------------
router.post('/agent-leg', verifyTwilio, (req, res) => {
  const from = req.body.From || '';
  const identity = from.replace(/^client:/, '');
  const userId = userIdFromIdentity(identity);
  const twiml = new VoiceResponse();

  if (!userId) {
    twiml.say('This phone is not registered to an agent. Goodbye.');
    twiml.hangup();
    return xml(res, twiml);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
  if (!user) {
    twiml.say('Your account is not active. Goodbye.');
    twiml.hangup();
    return xml(res, twiml);
  }

  engine.agentOnline(userId, req.body.CallSid);

  const dial = twiml.dial({ answerOnBridge: false });
  dial.conference(
    {
      beep: 'false',
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      waitUrl: '', // silence instead of hold music while waiting for a lead
      statusCallback: `${config.publicUrl}/webhooks/conference?agent=${userId}`,
      statusCallbackEvent: 'start end join leave',
      statusCallbackMethod: 'POST',
    },
    conferenceNameFor(userId)
  );

  xml(res, twiml);
});

// ---------------------------------------------------------------------------
// A lead picked up. Bridge, abandon, or hang up on voicemail.
// ---------------------------------------------------------------------------
router.post('/lead-answer', verifyTwilio, (req, res) => {
  const callSid = req.body.CallSid;
  const answeredBy = req.body.AnsweredBy || '';
  const agentId = Number(req.query.agent);
  const leadId = Number(req.query.lead);

  const twiml = new VoiceResponse();

  let result;
  try {
    result = engine.onLeadAnswered({ callSid, agentId, leadId, answeredBy });
  } catch (err) {
    console.error('[twiml] lead-answer error', err);
    twiml.hangup();
    return xml(res, twiml);
  }

  if (result.action === 'machine') {
    const vm = settings.get('voicemail_message', '');
    if (vm && settings.getBool('drop_voicemail', false)) {
      twiml.pause({ length: 1 });
      twiml.say({ voice: 'Polly.Joanna' }, vm);
    }
    twiml.hangup();
    return xml(res, twiml);
  }

  if (result.action === 'abandon') {
    twiml.say({ voice: 'Polly.Joanna' }, config.abandonMessage);
    twiml.hangup();
    return xml(res, twiml);
  }

  // Bridge into the agent's room.
  const recording = req.query.rec === undefined ? config.recordCalls : req.query.rec === '1';
  if (recording && config.recordingNotice) {
    twiml.say({ voice: 'Polly.Joanna' }, config.recordingNotice);
  }
  const dial = twiml.dial();
  dial.conference(
    {
      beep: 'false',
      startConferenceOnEnter: true,
      endConferenceOnExit: false, // agent stays in the room for the next call
      waitUrl: '',
    },
    result.conference
  );
  xml(res, twiml);
});

// ---------------------------------------------------------------------------
// A lead texted us back.
// Point each SMS-capable number's "A message comes in" webhook here.
// ---------------------------------------------------------------------------
router.post('/sms-inbound', verifyTwilio, (req, res) => {
  const messenger = require('../sms/messenger');
  const twiml = new twilio.twiml.MessagingResponse();
  let result = { optOut: false, optIn: false };
  try {
    result = messenger.receive({
      messageSid: req.body.MessageSid || req.body.SmsSid,
      from: req.body.From,
      to: req.body.To,
      body: req.body.Body,
    });
  } catch (err) {
    console.error('[twiml] sms-inbound', err);
  }

  // Twilio's Advanced Opt-Out already replies for STOP/START on a Messaging
  // Service. Only answer ourselves when we are sending from a bare number.
  if (!config.twilio.messagingServiceSid) {
    const confirm = settings.get('sms_optout_reply', 'You have been unsubscribed and will not receive further messages.');
    const back = settings.get('sms_optin_reply', 'You are subscribed again. Reply STOP to opt out.');
    if (result.optOut && confirm) twiml.message(confirm);
    else if (result.optIn && back) twiml.message(back);
  }

  xml(res, twiml);
});

// A safety net: if anything ever calls one of our numbers back.
router.post('/inbound', verifyTwilio, (req, res) => {
  const twiml = new VoiceResponse();
  const forward = settings.get('inbound_forward_to', '');
  if (forward) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while we connect you.');
    twiml.dial({ callerId: req.body.To }, forward);
  } else {
    twiml.say(
      { voice: 'Polly.Joanna' },
      'Thank you for calling. Nobody is available right now. Please try again during business hours.'
    );
    twiml.hangup();
  }
  xml(res, twiml);
});

module.exports = { router, verifyTwilio };
