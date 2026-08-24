'use strict';

/**
 * Turning a call recording into text.
 *
 * Four providers, chosen with TRANSCRIBE_PROVIDER:
 *   twilio    - Twilio Voice Intelligence. No new vendor, needs a Service SID.
 *   deepgram  - fastest and cheapest, needs a Deepgram key.
 *   openai    - Whisper, needs an OpenAI key.
 *   none      - skip transcription; notes fall back to the rep's typed notes.
 *
 * Every path returns { text, provider, speakers } or throws. Nothing here is
 * allowed to take the dialer down - callers treat a failure as "no transcript".
 */

const config = require('../config');
const { getClient } = require('../twilioClient');

let mockTranscript = null;

/** Tests inject a canned transcript instead of calling anyone. */
function setMock(text) {
  mockTranscript = text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Twilio recording media needs account auth, so we fetch the bytes ourselves. */
async function downloadRecording(url) {
  const mediaUrl = /\.(mp3|wav)$/i.test(url) ? url : `${url}.mp3`;
  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  const res = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Could not download the recording (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function viaDeepgram(recordingUrl) {
  if (!config.transcription.deepgramApiKey) throw new Error('DEEPGRAM_API_KEY is not set.');
  const audio = await downloadRecording(recordingUrl);

  const params = new URLSearchParams({
    model: 'nova-2-phonecall',
    punctuate: 'true',
    diarize: 'true',
    smart_format: 'true',
    utterances: 'true',
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.transcription.deepgramApiKey}`,
      'Content-Type': 'audio/mpeg',
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();

  const utterances = (data.results && data.results.utterances) || [];
  if (utterances.length) {
    const text = utterances
      .map((u) => `${u.speaker === 0 ? 'Rep' : 'Merchant'}: ${u.transcript}`)
      .join('\n');
    return { text, provider: 'deepgram', speakers: true };
  }
  const alt =
    data.results && data.results.channels && data.results.channels[0] && data.results.channels[0].alternatives[0];
  return { text: (alt && alt.transcript) || '', provider: 'deepgram', speakers: false };
}

async function viaOpenAI(recordingUrl) {
  if (!config.transcription.openaiApiKey) throw new Error('OPENAI_API_KEY is not set.');
  const audio = await downloadRecording(recordingUrl);

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'call.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.transcription.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { text: (await res.text()).trim(), provider: 'openai', speakers: false };
}

async function viaTwilio(callSid) {
  const serviceSid = config.transcription.twilioServiceSid;
  if (!serviceSid) throw new Error('TWILIO_INTELLIGENCE_SERVICE_SID is not set.');
  const client = getClient();

  const created = await client.intelligence.v2.transcripts.create({
    serviceSid,
    channel: { media_properties: { source_sid: callSid } },
  });

  const deadline = Date.now() + config.transcription.maxWaitMinutes * 60000;
  let status = created.status;
  while (status !== 'completed' && Date.now() < deadline) {
    if (status === 'failed') throw new Error('Twilio could not transcribe that recording.');
    await sleep(config.transcription.pollSeconds * 1000);
    const fetched = await client.intelligence.v2.transcripts(created.sid).fetch();
    status = fetched.status;
  }
  if (status !== 'completed') throw new Error('Transcription timed out.');

  const sentences = await client.intelligence.v2.transcripts(created.sid).sentences.list({ limit: 1000 });
  const text = sentences
    .map((s) => `${s.mediaChannel === 1 ? 'Rep' : 'Merchant'}: ${s.transcript}`)
    .join('\n');
  return { text, provider: 'twilio', speakers: true };
}

// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{text:string, provider:string, speakers:boolean}|null>}
 */
async function transcribe({ recordingUrl, callSid }) {
  if (mockTranscript !== null) {
    return { text: mockTranscript, provider: 'mock', speakers: true };
  }

  const provider = config.transcription.provider;
  if (provider === 'none') return null;

  if (provider === 'twilio') {
    if (!callSid) return null;
    return viaTwilio(callSid);
  }
  if (!recordingUrl) return null;
  if (provider === 'deepgram') return viaDeepgram(recordingUrl);
  if (provider === 'openai') return viaOpenAI(recordingUrl);

  throw new Error(`Unknown TRANSCRIBE_PROVIDER "${provider}".`);
}

function available() {
  const p = config.transcription.provider;
  if (mockTranscript !== null) return true;
  if (p === 'none') return false;
  if (p === 'twilio') return Boolean(config.transcription.twilioServiceSid);
  if (p === 'deepgram') return Boolean(config.transcription.deepgramApiKey);
  if (p === 'openai') return Boolean(config.transcription.openaiApiKey);
  return false;
}

module.exports = { transcribe, downloadRecording, available, setMock };
