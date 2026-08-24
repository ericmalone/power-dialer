'use strict';

/**
 * Twilio auto-setup.
 *
 * The manual version of getting this app talking to Twilio is five console
 * screens and one value (PUBLIC_URL) that silently breaks everything if it is
 * a character off. So we do it here instead.
 *
 * Given nothing but TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, this will:
 *
 *   1. create a Standard API key for the browser softphones, and remember it
 *   2. create a TwiML App and point its Voice URL at this deployment
 *   3. re-point that Voice URL every time the deployment URL changes
 *   4. adopt voice-capable numbers on the account as caller IDs
 *   5. point those numbers' inbound SMS webhook back here, so replies land
 *
 * It is idempotent: run it a hundred times and you still have one API key and
 * one TwiML App. It never throws - a step that fails is recorded and the app
 * boots anyway, so a Twilio outage cannot take the dialer down.
 *
 * SHARING A TWILIO ACCOUNT WITH ANOTHER APPLICATION
 *
 * Steps 1 and 2 only ever create new resources, so they cannot disturb an API
 * key or TwiML App that belongs to somebody else. Steps 4 and 5 are the ones
 * that could, because they write to numbers - so they are governed by an
 * allowlist:
 *
 *   - CALLER_IDS set          -> those numbers and no others, ever.
 *   - TWILIO_SHARED_ACCOUNT=true with no CALLER_IDS -> refuse and say so,
 *     rather than guess which numbers are ours.
 *   - neither set             -> the account is assumed to be ours alone.
 *
 * On top of that it is deliberately timid about existing settings. It will
 * only overwrite a webhook URL that is empty, or that is already pointing at
 * this app on some other host (the stale-deployment case). A URL belonging to
 * another application is reported, never clobbered.
 */

const config = require('../config');
const { db, settings } = require('../db');
const twilioClient = require('../twilioClient');

const KEYS = {
  apiKeySid: 'twilio.auto.api_key_sid',
  apiKeySecret: 'twilio.auto.api_key_secret',
  twimlAppSid: 'twilio.auto.twiml_app_sid',
  ranAt: 'twilio.auto.ran_at',
  log: 'twilio.auto.log',
};

/**
 * What the resources we create are called in the Twilio console. On an account
 * shared with another application, the company name is what lets whoever else
 * works in that console tell our key and app apart from theirs.
 */
function friendlyName() {
  const co = config.companyName && config.companyName !== 'our team' ? ` - ${config.companyName}` : '';
  return `Power Dialer${co}`;
}

const AGENT_LEG_PATH = '/twiml/agent-leg';
const SMS_INBOUND_PATH = '/twiml/sms-inbound';

function agentLegUrl() {
  return `${config.publicUrl}${AGENT_LEG_PATH}`;
}

function smsInboundUrl() {
  return `${config.publicUrl}${SMS_INBOUND_PATH}`;
}

/** True when this URL is empty, or is a previous deployment of this same app. */
function safeToOverwrite(url, path) {
  if (!url) return true;
  try {
    return new URL(url).pathname === path;
  } catch {
    return false;
  }
}

/** A public https address Twilio can actually reach. */
function reachable() {
  return /^https:\/\//i.test(config.publicUrl) && !/localhost|127\.0\.0\.1/i.test(config.publicUrl);
}

// ---------------------------------------------------------------------------
// Stored values
// ---------------------------------------------------------------------------

/**
 * Pull anything a previous run created into the live config. Safe to call at
 * any time; touches nothing but the database. Environment variables always
 * win, so setting a value by hand overrides what we made.
 */
function loadStored() {
  const t = config.twilio;
  if (!t.apiKeySid || !t.apiKeySecret) {
    const sid = settings.get(KEYS.apiKeySid, '');
    const secret = settings.get(KEYS.apiKeySecret, '');
    if (sid && secret) {
      t.apiKeySid = sid;
      t.apiKeySecret = secret;
    }
  }
  if (!t.twimlAppSid) {
    const sid = settings.get(KEYS.twimlAppSid, '');
    if (sid) t.twimlAppSid = sid;
  }
  config.refresh();
  return config.twilioConfigured;
}

/** What the last run did, for the admin screen. */
function lastRun() {
  const ranAt = settings.get(KEYS.ranAt, null);
  if (!ranAt) return null;
  let steps = [];
  try {
    steps = JSON.parse(settings.get(KEYS.log, '[]'));
  } catch {
    steps = [];
  }
  return { ranAt, steps };
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

async function ensureApiKey(client, log) {
  if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
    return log('API key', 'skipped', 'Using the key set in TWILIO_API_KEY_SID.');
  }

  const storedSid = settings.get(KEYS.apiKeySid, '');
  const storedSecret = settings.get(KEYS.apiKeySecret, '');

  if (storedSid && storedSecret) {
    // Confirm it still exists - somebody may have deleted it in the console.
    try {
      await client.keys(storedSid).fetch();
      config.twilio.apiKeySid = storedSid;
      config.twilio.apiKeySecret = storedSecret;
      return log('API key', 'reused', `Existing key ${storedSid.slice(0, 8)}… still valid.`);
    } catch {
      log('API key', 'replacing', 'The key we made before no longer exists on the account.');
    }
  }

  const key = await client.newKeys.create({ friendlyName: `${friendlyName()} (auto)` });
  if (!key || !key.sid || !key.secret) throw new Error('Twilio returned a key with no secret.');

  settings.set(KEYS.apiKeySid, key.sid);
  settings.set(KEYS.apiKeySecret, key.secret);
  config.twilio.apiKeySid = key.sid;
  config.twilio.apiKeySecret = key.secret;

  // The secret is deliberately never logged.
  return log('API key', 'created', `New Standard key ${key.sid.slice(0, 8)}… - agents can get a softphone now.`);
}

async function ensureTwimlApp(client, log) {
  const wanted = agentLegUrl();
  const fromEnv = Boolean(process.env.TWILIO_TWIML_APP_SID);
  let sid = config.twilio.twimlAppSid || settings.get(KEYS.twimlAppSid, '');

  if (sid) {
    let app = null;
    try {
      app = await client.applications(sid).fetch();
    } catch {
      if (fromEnv) {
        return log('TwiML app', 'failed', `TWILIO_TWIML_APP_SID ${sid} is not on this account.`);
      }
      log('TwiML app', 'replacing', 'The app we made before no longer exists on the account.');
      sid = '';
    }

    if (app) {
      config.twilio.twimlAppSid = sid;
      if (!reachable()) {
        return log('TwiML app', 'skipped', `Voice URL left alone - ${config.publicUrl} is not a public https address.`);
      }
      if (app.voiceUrl === wanted && String(app.voiceMethod || '').toUpperCase() === 'POST') {
        return log('TwiML app', 'reused', 'Voice URL already points here.');
      }
      if (!safeToOverwrite(app.voiceUrl, AGENT_LEG_PATH)) {
        return log(
          'TwiML app',
          'failed',
          `Its Voice URL is ${app.voiceUrl}, which belongs to something else. Left it alone - ` +
            `point it at ${wanted} yourself, or use a different TwiML app.`
        );
      }
      await client.applications(sid).update({ voiceUrl: wanted, voiceMethod: 'POST' });
      return log('TwiML app', 'updated', `Voice URL re-pointed at ${wanted}.`);
    }
  }

  const created = await client.applications.create({
    friendlyName: friendlyName(),
    voiceUrl: reachable() ? wanted : undefined,
    voiceMethod: 'POST',
  });
  settings.set(KEYS.twimlAppSid, created.sid);
  config.twilio.twimlAppSid = created.sid;
  return log(
    'TwiML app',
    'created',
    reachable() ? `Created and pointed at ${wanted}.` : 'Created. Its Voice URL is blank until this app has a public address.'
  );
}

/**
 * Work out which of the account's numbers this dialer is allowed to manage.
 *
 * On a Twilio account shared with another application this is the whole ball
 * game: touch a number the other project is using and you break it. So an
 * explicit CALLER_IDS list is always treated as the complete allowlist, and a
 * shared account with no list is refused outright rather than guessed at.
 */
function managedNumbers(owned, log) {
  const voice = owned.filter((n) => !n.capabilities || n.capabilities.voice !== false);
  const listed = (process.env.CALLER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (listed.length) {
    const byPhone = new Map(voice.map((n) => [n.phoneNumber, n]));
    const mine = listed.map((p) => byPhone.get(p)).filter(Boolean);
    const unknown = listed.filter((p) => !byPhone.has(p));
    if (unknown.length) {
      log(
        'Caller IDs',
        'failed',
        `CALLER_IDS lists ${unknown.join(', ')}, which this Twilio account does not own (or which cannot make calls). ` +
          'Calls from a number you do not own fail with error 21210.'
      );
    }
    return { numbers: mine, scoped: true };
  }

  if (config.twilio.sharedAccount) {
    log(
      'Caller IDs',
      'failed',
      'TWILIO_SHARED_ACCOUNT is on but CALLER_IDS is empty, so auto-setup does not know which numbers are yours. ' +
        'List the dialer\'s own numbers in CALLER_IDS. Nothing on this Twilio account was touched.'
    );
    return { numbers: [], scoped: true, refused: true };
  }

  return { numbers: voice, scoped: false };
}

async function adoptNumbers(client, log) {
  let owned = [];
  try {
    owned = await client.incomingPhoneNumbers.list({ limit: 400 });
  } catch (err) {
    return log('Caller IDs', 'failed', `Could not list your numbers: ${err.message}`);
  }

  const { numbers, scoped, refused } = managedNumbers(owned, log);
  if (refused) return null;

  if (!numbers.length) {
    return log(
      'Caller IDs',
      'failed',
      scoped
        ? 'None of the numbers in CALLER_IDS are usable. Nothing else on this Twilio account was touched.'
        : 'This Twilio account owns no voice-capable numbers. Buy one before you dial.'
    );
  }

  let added = 0;
  const ins = db.prepare(
    'INSERT INTO caller_ids (phone, friendly_name) VALUES (?, ?) ON CONFLICT(phone) DO NOTHING'
  );
  for (const n of numbers) {
    const r = ins.run(n.phoneNumber, n.friendlyName || 'From Twilio');
    if (r.changes) added += 1;
  }
  config.callerIds = db.prepare('SELECT phone FROM caller_ids WHERE active = 1').all().map((r) => r.phone);

  const scope = scoped
    ? `Only the ${numbers.length} number${numbers.length === 1 ? '' : 's'} in CALLER_IDS ${
        numbers.length === 1 ? 'is' : 'are'
      } managed here; the other ${owned.length - numbers.length} on this Twilio account were left alone.`
    : `${numbers.length} voice-capable number${numbers.length === 1 ? '' : 's'} on this Twilio account.`;

  log(
    'Caller IDs',
    added ? 'created' : 'reused',
    added ? `Adopted ${added} number${added === 1 ? '' : 's'}. ${scope}` : `Nothing new to adopt. ${scope}`
  );

  return wireSmsWebhooks(client, numbers, log);
}

async function wireSmsWebhooks(client, numbers, log) {
  if (!config.sms.enabled) return log('Text replies', 'skipped', 'Texting is switched off.');
  if (!reachable()) {
    return log('Text replies', 'skipped', `Needs a public https address; this app thinks it is at ${config.publicUrl}.`);
  }

  const wanted = smsInboundUrl();
  let changed = 0;
  let alreadyRight = 0;
  const conflicts = [];

  for (const n of numbers) {
    if (n.capabilities && n.capabilities.sms === false) continue;
    if (n.smsUrl === wanted) {
      alreadyRight += 1;
      continue;
    }
    if (!safeToOverwrite(n.smsUrl, SMS_INBOUND_PATH)) {
      conflicts.push(n.phoneNumber);
      continue;
    }
    try {
      await client.incomingPhoneNumbers(n.sid).update({ smsUrl: wanted, smsMethod: 'POST' });
      changed += 1;
    } catch (err) {
      conflicts.push(`${n.phoneNumber} (${err.message})`);
    }
  }

  const bits = [];
  if (changed) bits.push(`pointed ${changed} number${changed === 1 ? '' : 's'} at ${wanted}`);
  if (alreadyRight) bits.push(`${alreadyRight} already correct`);
  if (conflicts.length) bits.push(`left alone: ${conflicts.join(', ')}`);

  return log(
    'Text replies',
    conflicts.length && !changed ? 'failed' : changed ? 'updated' : 'reused',
    bits.join('; ') || 'Nothing to do.'
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Do the whole thing. Never throws.
 *
 * @returns {Promise<{ran: boolean, ok: boolean, reason?: string, steps: Array}>}
 */
async function run({ reason = 'boot' } = {}) {
  loadStored();

  if (!config.autoSetup) {
    return { ran: false, ok: config.twilioConfigured, reason: 'AUTO_SETUP is off.', steps: [] };
  }
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    return {
      ran: false,
      ok: false,
      reason: 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and restart. Everything else is automatic.',
      steps: [],
    };
  }

  const steps = [];
  const log = (step, status, detail) => {
    steps.push({ step, status, detail });
    return steps[steps.length - 1];
  };

  let client;
  try {
    client = twilioClient.getClient();
  } catch (err) {
    return { ran: false, ok: false, reason: err.message, steps: [] };
  }

  for (const [name, fn] of [
    ['API key', ensureApiKey],
    ['TwiML app', ensureTwimlApp],
    ['Caller IDs', adoptNumbers],
  ]) {
    try {
      await fn(client, log);
    } catch (err) {
      log(name, 'failed', err.message);
    }
  }

  config.refresh();

  settings.set(KEYS.ranAt, new Date().toISOString());
  settings.set(KEYS.log, JSON.stringify(steps));

  const ok = config.twilioConfigured && !steps.some((s) => s.status === 'failed');
  console.log(`[setup] Twilio auto-setup (${reason}): ${ok ? 'ready' : 'needs attention'}`);
  for (const s of steps) console.log(`[setup]   ${s.step}: ${s.status} - ${s.detail}`);

  return { ran: true, ok, steps };
}

module.exports = { run, loadStored, lastRun, agentLegUrl, smsInboundUrl, KEYS };
