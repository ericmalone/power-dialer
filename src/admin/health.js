'use strict';

/**
 * "Is everything actually connected?"
 *
 * These checks make real calls to Twilio, the model, and the email provider
 * rather than just looking at whether an environment variable is set - a key
 * that is present but wrong is the failure people actually hit.
 *
 * Every check returns pass / warn / fail / skip, plus a plain-English fix.
 */

const config = require('../config');
const { db } = require('../db');
const twilioClient = require('../twilioClient');
const mailer = require('../email/mailer');
const transcribe = require('../ai/transcribe');

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for a reply.')), ms)),
  ]);
}

const pass = (detail, extra = {}) => ({ status: 'pass', detail, ...extra });
const warn = (detail, fix) => ({ status: 'warn', detail, fix });
const fail = (detail, fix) => ({ status: 'fail', detail, fix });
const skip = (detail) => ({ status: 'skip', detail });

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function checkDatabase() {
  try {
    const stamp = new Date().toISOString();
    db.prepare(
      "INSERT INTO settings (key,value) VALUES ('health_probe',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(stamp);
    const back = db.prepare("SELECT value FROM settings WHERE key='health_probe'").get();
    if (!back || back.value !== stamp) return fail('Wrote a value but read back something else.', 'The database file may be corrupt. Restore your last backup of data/dialer.db.');

    const counts = db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM leads) leads, (SELECT COUNT(*) FROM calls) calls, ' +
          '(SELECT COUNT(*) FROM users WHERE active=1) users'
      )
      .get();
    return pass(
      `Readable and writable. ${counts.leads.toLocaleString()} merchants, ${counts.calls.toLocaleString()} calls, ${counts.users} active accounts.`
    );
  } catch (err) {
    return fail(err.message, 'The app cannot write to its database. Check the disk is mounted and not full.');
  }
}

function checkPublicUrl(req) {
  const url = config.publicUrl;
  if (!url) return fail('PUBLIC_URL is not set.', 'Set PUBLIC_URL to the address Twilio should call, with no trailing slash.');

  const problems = [];
  if (config.isProd && !url.startsWith('https://')) {
    problems.push('It is not an https address, so browsers will refuse the microphone.');
  }
  try {
    const configured = new URL(url).host;
    const actual = req && req.get ? req.get('host') : null;
    if (actual && configured !== actual) {
      return fail(
        `PUBLIC_URL says ${configured} but you are reading this page on ${actual}.`,
        'These must match or Twilio webhooks will go to the wrong place. Update PUBLIC_URL and restart.'
      );
    }
  } catch {
    return fail(`"${url}" is not a valid URL.`, 'Set PUBLIC_URL to something like https://your-app.onrender.com');
  }
  if (problems.length) return warn(problems.join(' '), 'Put the app behind https.');
  return pass(`${url} - matches the address you are on.`);
}

async function checkTwilioAccount() {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    return fail('Account SID or auth token is missing.', 'Copy both from the Twilio console home page into your environment.');
  }
  try {
    const client = twilioClient.getClient();
    const acct = await withTimeout(client.api.v2010.accounts(config.twilio.accountSid).fetch());
    if (acct.status && acct.status !== 'active') {
      return fail(`Twilio says this account is "${acct.status}".`, 'Sort the account out in the Twilio console before dialing.');
    }
    const trial = acct.type && /trial/i.test(acct.type);
    if (trial) {
      return warn(
        `Connected as "${acct.friendlyName}", but this is a trial account.`,
        'Trial accounts can only call numbers you have personally verified. Upgrade before working a real list.'
      );
    }
    return pass(`Connected as "${acct.friendlyName}".`);
  } catch (err) {
    return fail(err.message, 'Usually a wrong Account SID or auth token. Re-copy both from the Twilio console.');
  }
}

async function checkTwilioBalance() {
  try {
    const client = twilioClient.getClient();
    const bal = await withTimeout(client.balance.fetch());
    const amount = Number(bal.balance);
    const text = `${bal.currency || 'USD'} ${amount.toFixed(2)} remaining.`;
    if (Number.isFinite(amount) && amount < 20) {
      return warn(text, 'Top up before your floor runs out mid-shift. Turn on auto-recharge in Twilio.');
    }
    return pass(text);
  } catch (err) {
    return skip(`Could not read the balance (${err.message}).`);
  }
}

async function checkApiKey() {
  if (!config.twilio.apiKeySid || !config.twilio.apiKeySecret) {
    return fail(
      'API key SID or secret is missing.',
      config.autoSetup
        ? 'Press "Run Twilio setup" above - it creates one for you. If that fails, your TWILIO_AUTH_TOKEN is wrong.'
        : 'Twilio console > Account > API keys & tokens > Create API key (Standard). Without it no agent phone can connect.'
    );
  }
  try {
    twilioClient.makeAccessToken('health_check', 60);
  } catch (err) {
    return fail(err.message, 'The API key values look malformed. Create a fresh Standard key and paste both parts.');
  }
  try {
    const client = twilioClient.getClient();
    const key = await withTimeout(client.keys(config.twilio.apiKeySid).fetch());
    return pass(`Key "${key.friendlyName || config.twilio.apiKeySid}" is live on this account.`);
  } catch (err) {
    return warn(
      `Tokens can be built, but Twilio would not confirm the key (${err.message}).`,
      'If agent phones fail to connect, create a new API key.'
    );
  }
}

async function checkTwimlApp() {
  const expected = `${config.publicUrl}/twiml/agent-leg`;
  if (!config.twilio.twimlAppSid) {
    return fail(
      'No TwiML App SID set.',
      config.autoSetup
        ? 'Press "Run Twilio setup" above - it creates the app and points it at this deployment.'
        : `Create a TwiML App in Twilio, point its Voice Request URL at ${expected}, and set TWILIO_TWIML_APP_SID.`
    );
  }
  try {
    const client = twilioClient.getClient();
    const app = await withTimeout(client.applications(config.twilio.twimlAppSid).fetch());
    const actual = app.voiceUrl || '';
    if (!actual) {
      return fail(`TwiML App "${app.friendlyName}" has no Voice Request URL.`, `Set it to ${expected} with method POST.`);
    }
    if (actual.replace(/\/$/, '') !== expected) {
      return fail(
        `TwiML App points at ${actual}`,
        `It must point at ${expected} (method POST), or agents will connect to silence.` +
          (config.autoSetup ? ' Press "Run Twilio setup" above to re-point it.' : '')
      );
    }
    if ((app.voiceMethod || 'POST').toUpperCase() !== 'POST') {
      return warn(`The URL is right but the method is ${app.voiceMethod}.`, 'Set it to HTTP POST.');
    }
    return pass(`"${app.friendlyName}" points here correctly.`);
  } catch (err) {
    return fail(err.message, 'Check TWILIO_TWIML_APP_SID is the SID of a TwiML App on this account.');
  }
}

async function checkNumbers() {
  const local = db.prepare('SELECT phone, active, sms_capable FROM caller_ids').all();
  const activeLocal = local.filter((n) => n.active);
  if (!activeLocal.length) {
    return fail(
      'No caller ID numbers are switched on.',
      config.autoSetup
        ? 'Press "Run Twilio setup" above to adopt every number on your Twilio account. If it finds none, buy one in Twilio first.'
        : 'Admin > Numbers > "Import all numbers from Twilio". Nothing can be dialed until you do.'
    );
  }
  try {
    const client = twilioClient.getClient();
    const owned = await withTimeout(client.incomingPhoneNumbers.list({ limit: 200 }));
    const ownedSet = new Map(owned.map((n) => [n.phoneNumber, n]));

    const missing = activeLocal.filter((n) => !ownedSet.has(n.phone)).map((n) => n.phone);
    if (missing.length) {
      return fail(
        `${missing.length} caller ID${missing.length === 1 ? '' : 's'} not on this Twilio account: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''}`,
        'Calls from a number you do not own fail with error 21210. Remove them, or buy them in Twilio.'
      );
    }
    const noVoice = activeLocal.filter((n) => {
      const t = ownedSet.get(n.phone);
      return t && t.capabilities && t.capabilities.voice === false;
    });
    if (noVoice.length) {
      return fail(`${noVoice.length} of your numbers cannot make voice calls.`, 'Replace them with voice-capable numbers.');
    }
    const smsReady = activeLocal.filter((n) => n.sms_capable).length;
    return pass(
      `${activeLocal.length} caller ID${activeLocal.length === 1 ? '' : 's'} live on this account, ${smsReady} marked for texting.`
    );
  } catch (err) {
    return warn(`Could not cross-check the numbers with Twilio (${err.message}).`, 'Verify Admin > Numbers matches what you own.');
  }
}

async function checkMessaging() {
  if (!config.sms.enabled) return skip('Texting is switched off.');
  if (!config.twilio.messagingServiceSid) {
    return warn(
      'No Messaging Service set, so texts go out from a bare number.',
      'US carriers silently filter unregistered business texts. Register an A2P 10DLC campaign and set TWILIO_MESSAGING_SERVICE_SID.'
    );
  }
  try {
    const client = twilioClient.getClient();
    const svc = await withTimeout(client.messaging.v1.services(config.twilio.messagingServiceSid).fetch());
    return pass(`Messaging Service "${svc.friendlyName}" is connected.`);
  } catch (err) {
    return fail(err.message, 'Check TWILIO_MESSAGING_SERVICE_SID is a Messaging Service on this account.');
  }
}

async function checkWebhooksReachable() {
  // Proof by evidence: has Twilio ever actually called us back?
  const lastCall = db
    .prepare("SELECT MAX(created_at) t FROM calls WHERE status NOT IN ('queued','')")
    .get().t;
  const lastMsg = db.prepare("SELECT MAX(created_at) t FROM messages WHERE message_sid IS NOT NULL").get().t;
  const latest = [lastCall, lastMsg].filter(Boolean).sort().pop();

  if (!latest) {
    return skip('No calls or texts have run yet, so there is nothing to prove this either way.');
  }
  const ageDays = (Date.now() - new Date(`${latest.replace(' ', 'T')}Z`).getTime()) / 86400000;
  if (ageDays > 14) {
    return warn(`Twilio last reached this app ${Math.round(ageDays)} days ago.`, 'If your floor has been dialing since, your webhook URLs may be pointing somewhere else.');
  }
  return pass(`Twilio last reached this app ${ageDays < 1 ? 'today' : `${Math.round(ageDays)} day(s) ago`}.`);
}

async function checkAi() {
  if (!config.ai.enabled) return skip('AI notes are switched off.');
  if (!config.ai.apiKey) {
    return fail('No Anthropic API key set.', 'Get one at console.anthropic.com and set ANTHROPIC_API_KEY. Without it no notes get written.');
  }
  try {
    const res = await withTimeout(
      fetch(`${config.ai.baseUrl}/v1/models`, {
        headers: { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
      })
    );
    if (res.status === 401) return fail('Anthropic rejected the API key.', 'Create a new key at console.anthropic.com.');
    if (!res.ok) return warn(`Anthropic replied ${res.status}.`, 'Notes may fail. Check your account is in good standing.');
    return pass(`Key accepted. Writing notes with ${config.ai.model}.`);
  } catch (err) {
    return warn(`Could not reach Anthropic (${err.message}).`, 'Check the server has outbound internet access.');
  }
}

async function checkTranscription() {
  if (!config.ai.enabled) return skip('AI notes are switched off.');
  if (!config.recordCalls) {
    const perList = db.prepare('SELECT COUNT(*) c FROM lists WHERE record_calls = 1').get().c;
    if (perList) return pass(`Recording is off globally but on for ${perList} list(s).`);
    return warn('Recording is off, so notes are written from typed notes only.', 'Set RECORD_CALLS=true - after checking your states\' consent laws - for notes worth reading.');
  }
  if (!transcribe.available()) {
    return fail(
      `Recording is on but the "${config.transcription.provider}" transcriber is not configured.`,
      'Set the matching key: TWILIO_INTELLIGENCE_SERVICE_SID, DEEPGRAM_API_KEY or OPENAI_API_KEY.'
    );
  }
  if (config.transcription.provider === 'twilio') {
    try {
      const client = twilioClient.getClient();
      const svc = await withTimeout(
        client.intelligence.v2.services(config.transcription.twilioServiceSid).fetch()
      );
      return pass(`Voice Intelligence service "${svc.friendlyName || svc.uniqueName}" is connected.`);
    } catch (err) {
      return fail(err.message, 'Check TWILIO_INTELLIGENCE_SERVICE_SID is a Voice Intelligence service on this account.');
    }
  }
  return pass(`Transcribing with ${config.transcription.provider}.`);
}

async function checkEmail() {
  if (!config.email.from) {
    return fail('No sending address set.', 'Set EMAIL_FROM. Without it nobody can reset a password.');
  }
  if (config.email.provider === 'console') {
    return warn('Email is in log-only mode.', 'Reset links are printed to the server log instead of being sent. Set EMAIL_PROVIDER=resend and RESEND_API_KEY.');
  }
  if (!mailer.configured()) {
    return fail(`No API key for the "${config.email.provider}" provider.`, 'Password resets and invites will not send until you add it.');
  }
  if (config.email.provider === 'resend') {
    try {
      const res = await withTimeout(
        fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${config.email.resendApiKey}` },
        })
      );
      if (res.status === 401) return fail('Resend rejected the API key.', 'Create a new key at resend.com.');
      if (!res.ok) return warn(`Resend replied ${res.status}.`, 'Check the key and the account.');
      const data = await res.json().catch(() => ({}));
      const domains = (data.data || []).filter((d) => d.status === 'verified').map((d) => d.name);
      const fromDomain = (config.email.from.match(/@([^\s>]+)/) || [])[1];
      if (fromDomain && domains.length && !domains.includes(fromDomain)) {
        return fail(
          `Sending as @${fromDomain} but that domain is not verified in Resend.`,
          `Verified domains: ${domains.join(', ') || 'none'}. Add the DNS records Resend gives you.`
        );
      }
      return pass(`Resend connected. Verified: ${domains.join(', ') || 'no domains yet'}.`);
    } catch (err) {
      return warn(`Could not reach Resend (${err.message}).`, 'Check outbound internet access.');
    }
  }
  return pass(`Sending through ${config.email.provider}.`);
}

function checkAccounts() {
  const rows = db
    .prepare(
      "SELECT SUM(CASE WHEN role='admin' AND active=1 AND pending_approval=0 THEN 1 ELSE 0 END) admins, " +
        'SUM(CASE WHEN active=1 AND pending_approval=0 THEN 1 ELSE 0 END) active, ' +
        'SUM(CASE WHEN pending_approval=1 THEN 1 ELSE 0 END) waiting FROM users'
    )
    .get();
  if (!rows.admins) return fail('There are no active administrators.', 'Promote someone in Admin > People before you lock yourself out.');
  if (rows.waiting) {
    return warn(`${rows.waiting} account(s) waiting for approval.`, 'Approve or reject them under Admin > People.');
  }
  if (!config.signup.allowedDomains.length && config.signup.enabled) {
    return warn('Self sign-up is open to any email domain.', 'Set SIGNUP_ALLOWED_DOMAINS so only your own people can create accounts.');
  }
  return pass(`${rows.active} active account(s), ${rows.admins} administrator(s).`);
}

function checkCompliance() {
  const notes = [];
  if (!config.enforceCallingHours) notes.push('calling hours are NOT enforced');
  if (!config.sms.appendOptOut) notes.push('texts do NOT carry an opt-out line');
  if (config.recordCalls && !config.recordingNotice) notes.push('recording is on with no consent announcement');
  const dnc = db.prepare('SELECT COUNT(*) c FROM dnc').get().c;

  if (notes.length) {
    return fail(`Guards switched off: ${notes.join('; ')}.`, 'These are the settings that get phone rooms fined. Turn them back on.');
  }
  return pass(`Guards on. ${dnc.toLocaleString()} number(s) on the Do Not Call list.`);
}

// ---------------------------------------------------------------------------

const CHECKS = [
  { key: 'database', group: 'This app', label: 'Database', run: () => checkDatabase() },
  { key: 'public_url', group: 'This app', label: 'Public address', run: (req) => checkPublicUrl(req) },
  { key: 'accounts', group: 'This app', label: 'Accounts', run: () => checkAccounts() },
  { key: 'compliance', group: 'This app', label: 'Compliance guards', run: () => checkCompliance() },
  { key: 'twilio_account', group: 'Twilio', label: 'Account', run: () => checkTwilioAccount() },
  { key: 'twilio_balance', group: 'Twilio', label: 'Balance', run: () => checkTwilioBalance() },
  { key: 'twilio_key', group: 'Twilio', label: 'API key (agent phones)', run: () => checkApiKey() },
  { key: 'twiml_app', group: 'Twilio', label: 'TwiML app wiring', run: () => checkTwimlApp() },
  { key: 'numbers', group: 'Twilio', label: 'Caller ID numbers', run: () => checkNumbers() },
  { key: 'messaging', group: 'Twilio', label: 'Texting', run: () => checkMessaging() },
  { key: 'webhooks', group: 'Twilio', label: 'Webhooks reaching us', run: () => checkWebhooksReachable() },
  { key: 'ai', group: 'AI notes', label: 'Anthropic', run: () => checkAi() },
  { key: 'transcription', group: 'AI notes', label: 'Recording and transcription', run: () => checkTranscription() },
  { key: 'email', group: 'Email', label: 'Sending', run: () => checkEmail() },
];

async function runAll(req) {
  const results = await Promise.all(
    CHECKS.map(async (c) => {
      const started = Date.now();
      let out;
      try {
        out = await c.run(req);
      } catch (err) {
        out = fail(err.message, 'Unexpected error while running this check.');
      }
      return { key: c.key, group: c.group, label: c.label, ms: Date.now() - started, ...out };
    })
  );

  const counts = results.reduce(
    (a, r) => {
      a[r.status] = (a[r.status] || 0) + 1;
      return a;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 }
  );

  return {
    ranAt: new Date().toISOString(),
    overall: counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass',
    counts,
    checks: results,
  };
}

module.exports = { runAll, CHECKS };
