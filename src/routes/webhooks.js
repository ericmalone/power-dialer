'use strict';

const express = require('express');
const { db } = require('../db');
const engine = require('../dialer/engine');
const messenger = require('../sms/messenger');
const { verifyTwilio } = require('./twiml');

const router = express.Router();

router.post('/sms-status', verifyTwilio, (req, res) => {
  res.type('text/xml').send('<Response/>');
  try {
    messenger.updateStatus({
      messageSid: req.body.MessageSid || req.body.SmsSid,
      status: req.body.MessageStatus || req.body.SmsStatus,
      errorMessage: req.body.ErrorMessage || (req.body.ErrorCode ? `Twilio error ${req.body.ErrorCode}` : null),
    });
  } catch (err) {
    console.error('[webhook] sms-status', err);
  }
});

router.post('/call-status', verifyTwilio, (req, res) => {
  res.type('text/xml').send('<Response/>');
  try {
    engine.onCallStatus({
      callSid: req.body.CallSid,
      agentId: Number(req.query.agent),
      callStatus: req.body.CallStatus,
      duration: req.body.CallDuration,
      answeredBy: req.body.AnsweredBy,
    });
  } catch (err) {
    console.error('[webhook] call-status', err);
  }
});

router.post('/amd', verifyTwilio, (req, res) => {
  res.type('text/xml').send('<Response/>');
  try {
    engine.onAmd({
      callSid: req.body.CallSid,
      agentId: Number(req.query.agent),
      answeredBy: req.body.AnsweredBy,
    });
  } catch (err) {
    console.error('[webhook] amd', err);
  }
});

router.post('/recording', verifyTwilio, (req, res) => {
  res.type('text/xml').send('<Response/>');
  try {
    const url = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : '';
    if (req.body.CallSid && url) {
      db.prepare('UPDATE calls SET recording_url = ?, recording_sid = ? WHERE call_sid = ?').run(
        url,
        req.body.RecordingSid || '',
        req.body.CallSid
      );
      // The AI note worker was waiting on this.
      require('../ai/notes').tick().catch(() => {});
    }
  } catch (err) {
    console.error('[webhook] recording', err);
  }
});

router.post('/conference', verifyTwilio, (req, res) => {
  res.type('text/xml').send('<Response/>');
  try {
    const agentId = Number(req.query.agent);
    const event = req.body.StatusCallbackEvent;
    if (event === 'conference-end') {
      engine.agentOffline(agentId);
    }
  } catch (err) {
    console.error('[webhook] conference', err);
  }
});

module.exports = router;
