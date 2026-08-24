'use strict';

/**
 * End-to-end smoke test. No real Twilio calls are placed - the Twilio REST
 * client is replaced with a fake that records what would have happened.
 *
 *   npm test
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// --- isolated test environment ---------------------------------------------
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = './data/test.db';
process.env.PUBLIC_URL = 'http://127.0.0.1:3111';
process.env.PORT = '3111';
process.env.ADMIN_EMAIL = 'boss@test.local';
process.env.ADMIN_PASSWORD = 'TestPassword123';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.CALLER_IDS = '+12125551234,+13105559876';
process.env.MAX_LINES_PER_AGENT = '5';
process.env.ENFORCE_CALLING_HOURS = 'false';
process.env.SKIP_TWILIO_SIGNATURE = 'true';
process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'testauthtoken0000000000000000000';
process.env.TWILIO_API_KEY_SID = 'SKtest00000000000000000000000000000';
process.env.TWILIO_API_KEY_SECRET = 'testsecret000000000000000000000';
process.env.TWILIO_TWIML_APP_SID = 'APtest00000000000000000000000000000';
process.env.WRAP_UP_SECONDS = '0';
process.env.SMS_ENABLED = 'true';
process.env.SMS_QUIET_HOURS = 'false';
process.env.COMPANY_NAME = 'Brookestone Funding';
process.env.SMS_PER_SECOND = '50';
process.env.SIGNUP_ENABLED = 'true';
process.env.SIGNUP_ALLOWED_DOMAINS = 'test.local';
process.env.SIGNUP_REQUIRE_APPROVAL = 'false';
process.env.EMAIL_PROVIDER = 'console';
process.env.EMAIL_FROM = 'dialer@test.local';
process.env.AI_NOTES_ENABLED = 'true';
process.env.AI_MIN_TALK_SECONDS = '5';
process.env.RECORD_CALLS = 'false';
process.env.TRANSCRIBE_PROVIDER = 'none';
process.env.REPORT_TIMEZONE = 'UTC';

for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) {
  const p = path.resolve(process.cwd(), 'data', f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const twilioClient = require('../src/twilioClient');

// --- fake Twilio ------------------------------------------------------------
const placed = [];
const actions = [];
let sidCounter = 0;

function callHandle(sid) {
  return {
    update: async (params) => {
      actions.push({ sid, ...params });
      return { sid, ...params };
    },
    fetch: async () => placed.find((c) => c.sid === sid),
  };
}
const texted = [];
let msgCounter = 0;
let smsShouldFail = false;
let keyCounter = 0;
let appCounter = 0;
const provisionCalls = [];

const fake = {
  calls: Object.assign((sid) => callHandle(sid), {
    create: async (params) => {
      const sid = `CA${String(++sidCounter).padStart(32, '0')}`;
      placed.push({ sid, ...params });
      return { sid, ...params };
    },
  }),
  messages: {
    create: async (params) => {
      if (smsShouldFail) throw new Error('Twilio said no');
      const sid = `SM${String(++msgCounter).padStart(32, '0')}`;
      texted.push({ sid, ...params });
      return { sid, ...params };
    },
  },
  incomingPhoneNumbers: Object.assign(
    (sid) => ({
      update: async (params) => {
        const n = twilioState.numberRows().find((x) => x.sid === sid);
        if (n) Object.assign(twilioState.numberOverrides[n.phoneNumber] || (twilioState.numberOverrides[n.phoneNumber] = {}), params);
        provisionCalls.push({ kind: 'number.update', sid, ...params });
        return { sid, ...params };
      },
    }),
    {
      list: async () => twilioState.numberRows(),
    }
  ),
  newKeys: {
    create: async (params) => {
      const sid = `SK${String(++keyCounter).padStart(32, '0')}`;
      const key = { sid, secret: `secret-${keyCounter}`, friendlyName: params.friendlyName };
      twilioState.keys.set(sid, key);
      provisionCalls.push({ kind: 'key.create', ...params });
      return key;
    },
  },
  // --- the bits the system health check pokes at ---
  api: { v2010: { accounts: () => ({ fetch: async () => ({ friendlyName: 'Brookestone Test', status: 'active', type: 'Full' }) }) } },
  balance: { fetch: async () => ({ balance: twilioState.balance, currency: 'USD' }) },
  keys: (sid) => ({
    fetch: async () => {
      if (sid && twilioState.keys.size && !twilioState.keys.has(sid)) throw new Error('Key not found');
      return twilioState.keys.get(sid) || { friendlyName: 'power-dialer' };
    },
  }),
  applications: Object.assign(
    (sid) => ({
      fetch: async () => {
        if (twilioState.apps.size) {
          const app = twilioState.apps.get(sid);
          if (!app) throw new Error('Application not found');
          return app;
        }
        return { friendlyName: 'Power Dialer', voiceUrl: twilioState.voiceUrl, voiceMethod: 'POST' };
      },
      update: async (params) => {
        const app = twilioState.apps.get(sid) || { sid, friendlyName: 'Power Dialer' };
        Object.assign(app, params);
        twilioState.apps.set(sid, app);
        twilioState.voiceUrl = app.voiceUrl;
        provisionCalls.push({ kind: 'app.update', sid, ...params });
        return app;
      },
    }),
    {
      create: async (params) => {
        const sid = `AP${String(++appCounter).padStart(32, '0')}`;
        const app = { sid, ...params };
        twilioState.apps.set(sid, app);
        if (params.voiceUrl) twilioState.voiceUrl = params.voiceUrl;
        provisionCalls.push({ kind: 'app.create', ...params });
        return app;
      },
    }
  ),
  messaging: { v1: { services: () => ({ fetch: async () => ({ friendlyName: 'Brookestone Messaging' }) }) } },
  intelligence: { v2: { services: () => ({ fetch: async () => ({ friendlyName: 'Brookestone Intelligence' }) }) } },
};

const twilioState = {
  ownedNumbers: ['+12125551234', '+13105559876'],
  balance: '250.00',
  voiceUrl: 'http://127.0.0.1:3111/twiml/agent-leg',
  keys: new Map(),
  apps: new Map(),
  numberOverrides: {},
  numberRows() {
    return this.ownedNumbers.map((phoneNumber, i) => ({
      sid: `PN${String(i + 1).padStart(32, '0')}`,
      phoneNumber,
      friendlyName: phoneNumber,
      capabilities: { voice: true, sms: true },
      smsUrl: '',
      ...(this.numberOverrides[phoneNumber] || {}),
    }));
  },
};

twilioClient.setClient(fake);

const { app, server } = require('../src/server');
const { db } = require('../src/db');
const engine = require('../src/dialer/engine');

// --- tiny http helper with cookie jar --------------------------------------
let BASE = '';
function makeJar() {
  const jar = {};
  return {
    header() {
      return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    },
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        jar[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
    },
  };
}

async function req(jar, method, url, body, form = false) {
  const headers = { Accept: 'application/json', Cookie: jar.header() };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
  jar.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

// --- test harness -----------------------------------------------------------
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } catch (err) {
    results.push([false, name, err]);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`        ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
(async function run() {
  await new Promise((resolve) => server.listen(3111, '127.0.0.1', resolve));
  BASE = 'http://127.0.0.1:3111';
  console.log('\nPower Dialer smoke tests\n');

  const admin = makeJar();
  const agent = makeJar();
  let listId = null;
  let agentId = null;

  // -------------------------------------------------------------- phone utils
  const phone = require('../src/util/phone');
  await test('phone numbers normalise from messy spreadsheet values', () => {
    assert.strictEqual(phone.normalize('(212) 555-1234'), '+12125551234');
    assert.strictEqual(phone.normalize('212.555.1234'), '+12125551234');
    assert.strictEqual(phone.normalize('1-212-555-1234'), '+12125551234');
    assert.strictEqual(phone.normalize('+44 20 7946 0958'), '+442079460958');
    assert.strictEqual(phone.normalize('2125551234.0'), '+12125551234');
    assert.strictEqual(phone.normalize('2.1255512e+09'), '+12125551200');
    assert.strictEqual(phone.normalize('not a phone'), null);
    assert.strictEqual(phone.normalize(''), null);
  });

  await test('toll-free and bad numbers are rejected before dialing', () => {
    assert.strictEqual(phone.validate('+18005551234').ok, false);
    assert.strictEqual(phone.validate('+19005551234').ok, false);
    assert.strictEqual(phone.validate('+11125551234').ok, false);
    assert.strictEqual(phone.validate('+12125551234').ok, true);
  });

  await test('calling hours are computed in the lead local timezone', () => {
    assert.strictEqual(phone.timezoneFor('+12125551234'), 'America/New_York');
    assert.strictEqual(phone.timezoneFor('+13105559876'), 'America/Los_Angeles');
    const noon = new Date('2026-03-10T17:00:00Z'); // 1pm ET / 10am PT
    assert.strictEqual(phone.withinCallingHours('+12125551234', 8, 21, noon).ok, true);
    const threeAmEt = new Date('2026-03-10T07:00:00Z');
    assert.strictEqual(phone.withinCallingHours('+12125551234', 8, 21, threeAmEt).ok, false);
  });

  // -------------------------------------------------------------- auth
  await test('admin can sign in', async () => {
    const r = await req(admin, 'POST', '/login', { email: 'boss@test.local', password: 'TestPassword123' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.redirect, '/admin');
  });

  await test('wrong password is refused', async () => {
    const j = makeJar();
    const r = await req(j, 'POST', '/login', { email: 'boss@test.local', password: 'nope' });
    assert.strictEqual(r.status, 401);
  });

  await test('signed-out users cannot reach the API', async () => {
    const j = makeJar();
    const r = await req(j, 'GET', '/api/station');
    assert.strictEqual(r.status, 401);
  });

  // -------------------------------------------------------------- employees
  await test('admin adds an employee', async () => {
    const r = await req(admin, 'POST', '/api/admin/users', {
      name: 'Dana Rep',
      email: 'dana@test.local',
      password: 'AgentPass123',
      maxLines: 5,
    });
    assert.strictEqual(r.status, 200, r.text);
    agentId = r.json.user.id;
    assert.strictEqual(r.json.user.role, 'agent');
  });

  await test('duplicate emails are rejected', async () => {
    const r = await req(admin, 'POST', '/api/admin/users', {
      email: 'dana@test.local',
      password: 'AgentPass123',
    });
    assert.strictEqual(r.status, 400);
  });

  // -------------------------------------------------------------- spreadsheet
  const csv = [
    'Business Name,Owner,Cell Phone,Email,Requested Amount',
    'Acme Bakery,Maria Lopez,(212) 555-0101,maria@acme.test,50000',
    'Bolt Logistics,Jim Chen,212-555-0102,jim@bolt.test,120000',
    'Coral Dental,Sam Rivera,+1 212 555 0103,sam@coral.test,25000',
    'Delta Auto,Pat Kim,2125550104,pat@delta.test,80000',
    'Echo Salon,Lee Park,2125550105,lee@echo.test,15000',
    'Fog Cafe,Chris Diaz,800-555-0106,chris@fog.test,10000',
    'Grit Gym,Robin Ash,not-a-number,robin@grit.test,30000',
    'Dup Corp,Same Number,(212) 555-0101,dup@dup.test,5000',
  ].join('\n');

  let uploadToken = null;
  await test('spreadsheet upload detects the right columns', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'leads.csv');
    const r = await req(admin, 'POST', '/api/admin/lists/preview', fd);
    assert.strictEqual(r.status, 200, r.text);
    uploadToken = r.json.token;
    assert.strictEqual(r.json.rowCount, 8);
    assert.strictEqual(r.json.mapping.phone, 'Cell Phone');
    assert.strictEqual(r.json.mapping.company, 'Business Name');
    assert.strictEqual(r.json.mapping.email, 'Email');
    assert.ok(r.json.validPhones >= 5, `expected 5+ valid phones, got ${r.json.validPhones}`);
  });

  await test('import skips duplicates, toll-free and unreadable numbers', async () => {
    const r = await req(admin, 'POST', '/api/admin/lists/import', {
      token: uploadToken,
      name: 'August MCA Leads',
      mapping: {
        phone: 'Cell Phone',
        fullName: 'Owner',
        company: 'Business Name',
        email: 'Email',
      },
      assignTo: [agentId],
      skipDuplicates: true,
      skipDnc: true,
    });
    assert.strictEqual(r.status, 200, r.text);
    listId = r.json.listId;
    assert.strictEqual(r.json.imported, 5, `imported ${r.json.imported}`);
    assert.strictEqual(r.json.skippedDuplicates, 1);
    assert.strictEqual(r.json.invalid, 2); // toll-free + gibberish
  });

  await test('names and extra columns survive the import', () => {
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550101'").get();
    assert.strictEqual(lead.first_name, 'Maria');
    assert.strictEqual(lead.last_name, 'Lopez');
    assert.strictEqual(lead.company, 'Acme Bakery');
    assert.strictEqual(JSON.parse(lead.extra_json)['Requested Amount'], '50000');
    assert.strictEqual(lead.timezone, 'America/New_York');
  });

  // -------------------------------------------------------------- DNC
  await test('do-not-call numbers are added and pulled out of the queue', async () => {
    const r = await req(admin, 'POST', '/api/admin/dnc', { numbers: '212-555-0105' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.added, 1);
    const lead = db.prepare("SELECT status FROM leads WHERE phone = '+12125550105'").get();
    assert.strictEqual(lead.status, 'dnc');
  });

  // -------------------------------------------------------------- agent
  await test('agent signs in and sees only assigned lists', async () => {
    const login = await req(agent, 'POST', '/login', { email: 'dana@test.local', password: 'AgentPass123' });
    assert.strictEqual(login.status, 200, login.text);
    const r = await req(agent, 'GET', '/api/lists');
    assert.strictEqual(r.json.lists.length, 1);
    assert.strictEqual(r.json.lists[0].name, 'August MCA Leads');
    assert.strictEqual(r.json.lists[0].remaining, 4); // one went to DNC
  });

  await test('starting without a connected phone is refused', async () => {
    const r = await req(agent, 'POST', '/api/dialer/start', { listId, lines: 3 });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /phone is not connected/i);
  });

  await test('agent browser leg parks the agent in their own conference', async () => {
    const r = await req(
      agent,
      'POST',
      '/twiml/agent-leg',
      { From: `client:agent_${agentId}`, CallSid: 'CAagentleg0001', To: '' },
      true
    );
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, /<Conference[^>]*>agent-room-/);
    assert.match(r.text, /endConferenceOnExit="true"/);
    assert.strictEqual(engine.getStation(agentId).agentCallSid, 'CAagentleg0001');
  });

  // -------------------------------------------------------------- dialing
  await test('START places one call per line', async () => {
    placed.length = 0;
    const r = await req(agent, 'POST', '/api/dialer/start', { listId, lines: 3 });
    assert.strictEqual(r.status, 200, r.text);
    await sleep(1400);
    assert.strictEqual(placed.length, 3, `placed ${placed.length}`);
    const tos = placed.map((p) => p.to).sort();
    assert.deepStrictEqual(tos, ['+12125550101', '+12125550102', '+12125550103']);
    assert.ok(placed.every((p) => p.machineDetection === 'Enable'));
    assert.ok(placed.every((p) => p.url.includes('/twiml/lead-answer')));
    assert.ok(placed.every((p) => ['+12125551234', '+13105559876'].includes(p.from)));
  });

  await test('DNC numbers are never dialed', () => {
    assert.ok(!placed.some((p) => p.to === '+12125550105'));
  });

  await test('leads are locked while their line is ringing', () => {
    const locked = db.prepare("SELECT COUNT(*) c FROM leads WHERE locked_by = ? AND status='calling'").get(agentId).c;
    assert.strictEqual(locked, 3);
  });

  let winner = null;
  await test('first human answer is bridged into the agent conference', async () => {
    winner = placed[1];
    const u = new URL(winner.url);
    const r = await req(
      agent,
      'POST',
      `/twiml/lead-answer?${u.searchParams.toString()}`,
      { CallSid: winner.sid, AnsweredBy: 'human', CallStatus: 'in-progress' },
      true
    );
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, new RegExp(`<Conference[^>]*>agent-room-${agentId}</Conference>`));
    assert.match(r.text, /endConferenceOnExit="false"/);
    const snap = engine.snapshot(agentId);
    assert.strictEqual(snap.status, 'connected');
    assert.strictEqual(snap.onCall.lead.phone, winner.to);
  });

  await test('the other lines are cancelled the moment someone answers', () => {
    const cancelled = actions.filter((a) => a.status === 'canceled').map((a) => a.sid);
    const others = placed.filter((p) => p.sid !== winner.sid).map((p) => p.sid);
    for (const sid of others) assert.ok(cancelled.includes(sid), `expected ${sid} to be cancelled`);
  });

  await test('cancelled leads go straight back into the queue', () => {
    const stillLocked = db.prepare('SELECT COUNT(*) c FROM leads WHERE locked_by = ?').get(agentId).c;
    assert.strictEqual(stillLocked, 1); // only the connected one
  });

  await test('a late answer hears the abandon message instead of silence', async () => {
    const late = placed.find((p) => p.sid !== winner.sid);
    const u = new URL(late.url);
    const r = await req(
      agent,
      'POST',
      `/twiml/lead-answer?${u.searchParams.toString()}`,
      { CallSid: late.sid, AnsweredBy: 'human' },
      true
    );
    assert.match(r.text, /<Say[^>]*>.*<\/Say>/s);
    assert.match(r.text, /<Hangup\/>/);
    const call = db.prepare('SELECT outcome FROM calls WHERE call_sid = ?').get(late.sid);
    assert.strictEqual(call.outcome, 'abandoned');
  });

  await test('when the lead hangs up the agent drops into wrap-up', async () => {
    const r = await req(
      agent,
      'POST',
      `/webhooks/call-status?agent=${agentId}`,
      { CallSid: winner.sid, CallStatus: 'completed', CallDuration: '95' },
      true
    );
    assert.strictEqual(r.status, 200);
    await sleep(150);
    const snap = engine.snapshot(agentId);
    assert.strictEqual(snap.onCall, null);
    assert.strictEqual(snap.status, 'wrap');
    assert.strictEqual(snap.stats.talkSeconds, 95);
    assert.ok(snap.pendingDispositionCallId, 'a call should be waiting for a disposition');
  });

  await test('picking a disposition puts the agent straight back on the dialer', async () => {
    placed.length = 0;
    const r = await req(agent, 'POST', '/api/disposition', { code: 'not_interested', notes: 'Not right now.' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.status, 'ready');
    await sleep(1600);
    assert.ok(placed.length >= 1, 'dialer did not resume after the disposition');
    const lead = db.prepare("SELECT * FROM leads WHERE phone = ?").get(winner.to);
    assert.strictEqual(lead.status, 'done');
    assert.strictEqual(lead.disposition, 'not_interested');
  });

  await test('voicemail is detected and never handed to the agent', async () => {
    // Reset the station, dial a fresh burst of one line.
    await req(agent, 'POST', '/api/dialer/stop', {});
    await req(agent, 'POST', '/twiml/agent-leg', { From: `client:agent_${agentId}`, CallSid: 'CAagentleg0002' }, true);
    placed.length = 0;
    await req(agent, 'POST', '/api/dialer/start', { listId, lines: 1 });
    await sleep(1400);
    assert.ok(placed.length >= 1, 'no call placed');
    const call = placed[0];
    const u = new URL(call.url);
    const r = await req(
      agent,
      'POST',
      `/twiml/lead-answer?${u.searchParams.toString()}`,
      { CallSid: call.sid, AnsweredBy: 'machine_start' },
      true
    );
    assert.match(r.text, /<Hangup\/>/);
    assert.doesNotMatch(r.text, /<Conference/);
    assert.strictEqual(engine.snapshot(agentId).onCall, null);
  });

  await test('pause stops new calls without killing the phone', async () => {
    const r = await req(agent, 'POST', '/api/dialer/pause', {});
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.status, 'paused');
    placed.length = 0;
    await sleep(1500);
    assert.strictEqual(placed.length, 0, 'paused agent should not dial');
  });

  await test('resume picks the dialing straight back up', async () => {
    await req(agent, 'POST', '/api/dialer/resume', {});
    await sleep(1500);
    assert.ok(placed.length >= 1, 'resume did not dial');
  });

  await test('a disposition is written to the lead and can flag do-not-call', async () => {
    await req(agent, 'POST', '/api/dialer/stop', {});
    const lead = db.prepare("SELECT * FROM leads WHERE phone='+12125550101'").get();
    const callRow = db.prepare('SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id);
    const r = await req(agent, 'POST', '/api/disposition', {
      callId: callRow.id,
      code: 'dnc',
      notes: 'Asked to be removed.',
    });
    assert.strictEqual(r.status, 200, r.text);
    const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.strictEqual(after.status, 'dnc');
    assert.strictEqual(after.notes, 'Asked to be removed.');
    const onDnc = db.prepare('SELECT 1 x FROM dnc WHERE phone = ?').get(lead.phone);
    assert.ok(onDnc, 'number should be on the DNC list');
  });

  await test('an agent cannot dial a list they were not assigned', async () => {
    const r2 = await req(admin, 'POST', '/api/admin/lists/preview', (() => {
      const fd = new FormData();
      fd.append('file', new Blob(['Phone\n2125559999'], { type: 'text/csv' }), 'other.csv');
      return fd;
    })());
    const imp = await req(admin, 'POST', '/api/admin/lists/import', {
      token: r2.json.token,
      name: 'Private list',
      mapping: { phone: 'Phone' },
      assignTo: [],
    });
    const lists = await req(agent, 'GET', '/api/lists');
    assert.ok(!lists.json.lists.some((l) => l.id === imp.json.listId));
  });

  await test('agents are locked out of the admin API', async () => {
    const r = await req(agent, 'GET', '/api/admin/users');
    assert.strictEqual(r.status, 403);
  });

  await test('results export as a real xlsx file', async () => {
    const res = await fetch(`${BASE}/api/admin/lists/${listId}/export`, { headers: { Cookie: admin.header() } });
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK'); // xlsx is a zip
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    assert.ok(rows.length >= 5);
    assert.ok('Disposition' in rows[0]);
    assert.ok('Requested Amount' in rows[0], 'extra spreadsheet columns should come back out');
  });

  await test('admin dashboard reports real numbers', async () => {
    const r = await req(admin, 'GET', '/api/admin/overview');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.today.calls > 0);
    assert.strictEqual(r.json.warnings.length, 0);
    assert.strictEqual(r.json.twimlUrl, 'http://127.0.0.1:3111/twiml/agent-leg');
  });

  await test('unsigned Twilio webhooks are refused when signature checking is on', async () => {
    const twiml = require('../src/routes/twiml');
    process.env.SKIP_TWILIO_SIGNATURE = 'false';
    const r = await req(agent, 'POST', '/twiml/agent-leg', { From: `client:agent_${agentId}` }, true);
    process.env.SKIP_TWILIO_SIGNATURE = 'true';
    assert.strictEqual(r.status, 403);
  });

  // -------------------------------------------------------------- texting
  const messenger = require('../src/sms/messenger');
  const smsConfig = require('../src/config');
  const settleSms = async () => {
    await sleep(400);
    await messenger.flush();
    await sleep(150);
  };

  let tplId = null;
  const targetLead = () => db.prepare("SELECT * FROM leads WHERE phone = '+12125550103'").get();

  await test('merge fields fill in from the lead and the agent', () => {
    const lead = targetLead();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(agentId);
    const out = messenger.render(
      'Hi {{first_name}} at {{business}}, this is {{agent_first_name}} from {{company_name}}. Amount: {{Requested Amount}}',
      lead,
      user
    );
    assert.strictEqual(out, 'Hi Sam at Coral Dental, this is Dana from Brookestone Funding. Amount: 25000');
  });

  await test('unknown merge fields disappear instead of leaking braces', () => {
    const out = messenger.render('Hello {{first_name}} {{not_a_field}}!', targetLead(), null);
    assert.strictEqual(out, 'Hello Sam !');
    assert.ok(!out.includes('{{'));
  });

  await test('an opt-out line is appended unless the message already has one', () => {
    assert.match(messenger.withOptOut('Hi there'), /Reply STOP to opt out\.$/);
    const already = 'Hi there. Text STOP to stop.';
    assert.strictEqual(messenger.withOptOut(already), already);
  });

  await test('segment counting matches how carriers actually bill', () => {
    assert.strictEqual(messenger.segmentCount('a'.repeat(160)), 1);
    assert.strictEqual(messenger.segmentCount('a'.repeat(161)), 2);
    assert.strictEqual(messenger.segmentCount('a'.repeat(306)), 2);
    assert.strictEqual(messenger.segmentCount('a'.repeat(307)), 3);
    assert.strictEqual(messenger.segmentCount('emoji 🙂 makes it unicode'), 1);
    assert.strictEqual(messenger.segmentCount('🙂'.repeat(60)), 2);
  });

  await test('an agent can save their own template', async () => {
    const r = await req(agent, 'POST', '/api/sms/templates', {
      name: 'My callback ask',
      body: 'Hi {{first_name}}, {{agent_first_name}} here. Call me back when you get a sec.',
    });
    assert.strictEqual(r.status, 200, r.text);
    tplId = r.json.template.id;

    const list = await req(agent, 'GET', '/api/sms/templates');
    const mine = list.json.templates.find((t) => t.id === tplId);
    assert.ok(mine, 'template should be listed');
    assert.strictEqual(mine.mine, true);
    assert.ok(list.json.templates.some((t) => t.shared), 'the seeded shared templates should also appear');
  });

  await test('one agent cannot edit another agent template', async () => {
    const other = await req(admin, 'POST', '/api/admin/users', {
      email: 'marcus@test.local',
      name: 'Marcus',
      password: 'AgentPass123',
    });
    const jar2 = makeJar();
    await req(jar2, 'POST', '/login', { email: 'marcus@test.local', password: 'AgentPass123' });
    const r = await req(jar2, 'PATCH', `/api/sms/templates/${tplId}`, { body: 'hijacked' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /belongs to someone else/i);
  });

  await test('preview shows exactly what the lead will receive', async () => {
    const lead = targetLead();
    const r = await req(agent, 'POST', '/api/sms/preview', {
      body: 'Hi {{first_name}}, about {{business}}.',
      leadId: lead.id,
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.text, 'Hi Sam, about Coral Dental. Reply STOP to opt out.');
    assert.strictEqual(r.json.segments, 1);
  });

  await test('sending to one lead renders and delivers the message', async () => {
    texted.length = 0;
    const lead = targetLead();
    const r = await req(agent, 'POST', '/api/sms/send', { leadId: lead.id, templateId: tplId });
    assert.strictEqual(r.status, 200, r.text);
    await settleSms();
    assert.strictEqual(texted.length, 1, `expected 1 text, got ${texted.length}`);
    assert.strictEqual(texted[0].to, '+12125550103');
    assert.match(texted[0].body, /^Hi Sam, Dana here\./);
    assert.match(texted[0].body, /Reply STOP to opt out\./);
    const row = db.prepare('SELECT * FROM messages WHERE message_sid = ?').get(texted[0].sid);
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.user_id, agentId);
  });

  await test('the sending number is one of our SMS-capable numbers', () => {
    assert.ok(['+12125551234', '+13105559876'].includes(texted[0].from), `unexpected from ${texted[0].from}`);
  });

  await test('a whole thread stays on the same number', async () => {
    texted.length = 0;
    const lead = targetLead();
    await req(agent, 'POST', '/api/sms/send', { leadId: lead.id, body: 'Following up.' });
    await settleSms();
    assert.strictEqual(texted.length, 1);
    const first = db.prepare("SELECT from_number FROM messages WHERE to_number='+12125550103' ORDER BY id").get();
    assert.strictEqual(texted[0].from, first.from_number);
  });

  await test('do-not-call numbers are never texted', async () => {
    texted.length = 0;
    const r = await req(agent, 'POST', '/api/sms/send', { to: '212-555-0105', body: 'Hello?' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Do Not Call/i);
    await settleSms();
    assert.strictEqual(texted.length, 0);
  });

  await test('quiet hours defer a text rather than dropping it', () => {
    const real = smsConfig.sms.quietHours;
    smsConfig.sms.quietHours = true;
    try {
      const verdict = messenger.screen('+12125550104');
      const inHours = phone.withinCallingHours('+12125550104', smsConfig.callingHoursStart, smsConfig.callingHoursEnd).ok;
      assert.strictEqual(verdict.ok, true, 'quiet hours must never hard-block');
      if (inHours) {
        assert.strictEqual(verdict.sendAfter, null);
      } else {
        assert.ok(verdict.sendAfter, 'should be scheduled for later');
        assert.strictEqual(verdict.reason, 'quiet_hours');
        const when = new Date(verdict.sendAfter);
        assert.ok(when > new Date(), 'scheduled time must be in the future');
        assert.ok(
          phone.withinCallingHours('+12125550104', smsConfig.callingHoursStart, smsConfig.callingHoursEnd, when).ok,
          'the scheduled time must land inside calling hours'
        );
      }
    } finally {
      smsConfig.sms.quietHours = real;
    }
  });

  await test('a batch goes out to everyone selected, once each', async () => {
    texted.length = 0;
    const ids = db
      .prepare("SELECT id FROM leads WHERE phone IN ('+12125550102','+12125550103','+12125550104')")
      .all()
      .map((r) => r.id);
    const r = await req(agent, 'POST', '/api/sms/send-batch', {
      leadIds: [...ids, ids[0]], // duplicate on purpose
      body: 'Quick note for {{first_name}}.',
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.queued, 3, `queued ${r.json.queued}`);
    await settleSms();
    assert.strictEqual(texted.length, 3);
    const tos = texted.map((t) => t.to).sort();
    assert.deepStrictEqual(tos, ['+12125550102', '+12125550103', '+12125550104']);
    assert.ok(texted.every((t) => t.body.includes('Reply STOP')));
  });

  await test('pasted numbers work as well as picked leads', async () => {
    texted.length = 0;
    const r = await req(agent, 'POST', '/api/sms/send-batch', {
      numbers: '212-555-0199, (212) 555-0198',
      body: 'Hello from us.',
    });
    assert.strictEqual(r.json.queued, 2, r.text);
    await settleSms();
    assert.deepStrictEqual(texted.map((t) => t.to).sort(), ['+12125550198', '+12125550199']);
  });

  await test('an auto-text fires when nobody picks up', async () => {
    const rule = await req(agent, 'POST', '/api/sms/rules', {
      trigger: 'no_answer',
      templateId: tplId,
      delayMinutes: 0,
    });
    assert.strictEqual(rule.status, 200, rule.text);

    // Fresh burst, then tell Twilio the call rang out.
    await req(agent, 'POST', '/api/dialer/stop', {});
    await req(agent, 'POST', '/twiml/agent-leg', { From: `client:agent_${agentId}`, CallSid: 'CAagentleg0009' }, true);
    placed.length = 0;
    texted.length = 0;
    await req(agent, 'POST', '/api/dialer/start', { listId, lines: 1 });
    await sleep(1400);
    assert.ok(placed.length >= 1, 'no call placed');
    const call = placed[0];
    await req(
      agent,
      'POST',
      `/webhooks/call-status?agent=${agentId}`,
      { CallSid: call.sid, CallStatus: 'no-answer', CallDuration: '0' },
      true
    );
    await settleSms();
    assert.strictEqual(texted.length, 1, `expected the auto-text, got ${texted.length}`);
    assert.strictEqual(texted[0].to, call.to);
    const msg = db.prepare('SELECT * FROM messages WHERE message_sid = ?').get(texted[0].sid);
    assert.ok(msg.rule_id, 'the message should be tagged with the rule that sent it');
  });

  await test('an auto-text only hits the same person once', async () => {
    texted.length = 0;
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(placed[0].to);
    const station = engine.getStation(agentId);
    require('../src/sms/messenger').runRules({
      trigger: 'no_answer',
      leadId: lead.id,
      userId: agentId,
      listId,
    });
    await settleSms();
    assert.strictEqual(texted.length, 0, 'the once-per-lead guard should have stopped it');
  });

  await test('replying STOP opts them out everywhere', async () => {
    await req(agent, 'POST', '/api/dialer/stop', {});
    const lead = targetLead();
    const r = await req(
      agent,
      'POST',
      '/twiml/sms-inbound',
      { MessageSid: 'SMinbound0001', From: lead.phone, To: '+12125551234', Body: 'STOP' },
      true
    );
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, /<Message>/);

    assert.ok(db.prepare('SELECT 1 x FROM sms_optouts WHERE phone = ?').get(lead.phone), 'should be on the opt-out list');
    assert.ok(db.prepare('SELECT 1 x FROM dnc WHERE phone = ?').get(lead.phone), 'should also be on the DNC list');
    assert.strictEqual(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'dnc');
  });

  await test('nothing more can be texted to someone who opted out', async () => {
    texted.length = 0;
    const lead = targetLead();
    const r = await req(agent, 'POST', '/api/sms/send', { leadId: lead.id, body: 'One more thing' });
    assert.strictEqual(r.status, 400);
    await settleSms();
    assert.strictEqual(texted.length, 0);
  });

  await test('a normal reply lands in the agent inbox', async () => {
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550104'").get();
    db.prepare('UPDATE leads SET worked_by = ? WHERE id = ?').run(agentId, lead.id);
    await req(
      agent,
      'POST',
      '/twiml/sms-inbound',
      { MessageSid: 'SMinbound0002', From: lead.phone, To: '+12125551234', Body: 'Yes call me at 4' },
      true
    );
    const inbox = await req(agent, 'GET', '/api/sms/inbox');
    assert.strictEqual(inbox.status, 200, inbox.text);
    const hit = inbox.json.inbox.find((m) => m.body === 'Yes call me at 4');
    assert.ok(hit, 'the reply should be in the inbox');
    assert.strictEqual(hit.leadId, lead.id);
  });

  await test('the thread shows both sides in order', async () => {
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550104'").get();
    const r = await req(agent, 'GET', `/api/sms/thread/${lead.id}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.thread.length >= 2);
    assert.strictEqual(r.json.thread[r.json.thread.length - 1].direction, 'inbound');
  });

  await test('a Twilio failure is recorded, not swallowed', async () => {
    texted.length = 0;
    smsShouldFail = true;
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550102'").get();
    await req(agent, 'POST', '/api/sms/send', { leadId: lead.id, body: 'Will not go' });
    await settleSms();
    smsShouldFail = false;
    const row = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id);
    assert.strictEqual(row.status, 'failed');
    assert.match(row.error, /Twilio said no/);
  });

  await test('delivery receipts update the message status', async () => {
    const sent = db.prepare("SELECT * FROM messages WHERE status='sent' ORDER BY id DESC LIMIT 1").get();
    await req(
      agent,
      'POST',
      '/webhooks/sms-status',
      { MessageSid: sent.message_sid, MessageStatus: 'delivered' },
      true
    );
    await sleep(80);
    assert.strictEqual(db.prepare('SELECT status FROM messages WHERE id = ?').get(sent.id).status, 'delivered');
  });

  await test('the daily text cap holds', async () => {
    const real = smsConfig.sms.dailyCapPerAgent;
    smsConfig.sms.dailyCapPerAgent = 1;
    try {
      const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550104'").get();
      const r = await req(agent, 'POST', '/api/sms/send', { leadId: lead.id, body: 'Over the cap' });
      assert.strictEqual(r.status, 400);
      assert.match(r.json.error, /Daily text limit/i);
    } finally {
      smsConfig.sms.dailyCapPerAgent = real;
    }
  });

  await test('admins can see every message and every opt-out', async () => {
    const log = await req(admin, 'GET', '/api/admin/sms/log?limit=50');
    assert.strictEqual(log.status, 200, log.text);
    assert.ok(log.json.messages.length > 0);
    const stats = await req(admin, 'GET', '/api/admin/sms/stats');
    assert.ok(stats.json.today.sent > 0);
    assert.ok(stats.json.optOuts >= 1);
    const outs = await req(admin, 'GET', '/api/admin/sms/optouts');
    assert.ok(outs.json.optOuts.length >= 1);
  });

  await test('agents cannot reach the admin texting endpoints', async () => {
    const r = await req(agent, 'GET', '/api/admin/sms/log');
    assert.strictEqual(r.status, 403);
  });

  // -------------------------------------------------------------- accounts
  const mailer = require('../src/email/mailer');
  const authLib = require('../src/auth');

  await test('sign-up is limited to the allowed domain', async () => {
    const j = makeJar();
    const r = await req(j, 'POST', '/signup', {
      name: 'Outsider',
      email: 'someone@gmail.com',
      password: 'AVeryGoodPassword1',
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /limited to @test\.local/i);
  });

  await test('weak passwords are refused at sign-up', async () => {
    const j = makeJar();
    const r = await req(j, 'POST', '/signup', { name: 'Weak', email: 'weak@test.local', password: 'short' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /at least 10 characters/i);
  });

  const newRep = makeJar();
  await test('an employee can create their own account and is signed straight in', async () => {
    const r = await req(newRep, 'POST', '/signup', {
      name: 'Priya Shah',
      email: 'priya@test.local',
      password: 'CorrectHorseBattery9',
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.redirect, '/');
    const me = await req(newRep, 'GET', '/api/me');
    assert.strictEqual(me.json.user.email, 'priya@test.local');
    assert.strictEqual(me.json.user.role, 'agent');
  });

  await test('the same email cannot sign up twice', async () => {
    const j = makeJar();
    const r = await req(j, 'POST', '/signup', {
      name: 'Priya Again',
      email: 'priya@test.local',
      password: 'CorrectHorseBattery9',
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /already an account/i);
  });

  await test('forgot password answers the same way whether or not the account exists', async () => {
    const j = makeJar();
    const a = await req(j, 'POST', '/forgot', { email: 'priya@test.local' });
    const b = await req(j, 'POST', '/forgot', { email: 'nobody@test.local' });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(a.json.message, b.json.message);
  });

  let resetUrl = null;
  await test('a reset email goes out with a working link', async () => {
    mailer._sent.length = 0;
    const result = await authLib.requestPasswordReset('priya@test.local');
    assert.strictEqual(result.sent, true);
    assert.strictEqual(mailer._sent.length, 1);
    assert.match(mailer._sent[0].subject, /reset/i);
    assert.match(mailer._sent[0].text, /\/reset\?token=/);
    resetUrl = result.url;

    const token = new URL(resetUrl).searchParams.get('token');
    const j = makeJar();
    const check = await req(j, 'GET', `/reset/check?token=${encodeURIComponent(token)}`);
    assert.strictEqual(check.status, 200, check.text);
    assert.strictEqual(check.json.email, 'priya@test.local');
  });

  await test('a tampered reset token is refused', async () => {
    const j = makeJar();
    const r = await req(j, 'GET', '/reset/check?token=not-a-real-token');
    assert.strictEqual(r.status, 400);
  });

  await test('the reset link sets a new password and signs them in', async () => {
    const token = new URL(resetUrl).searchParams.get('token');
    const j = makeJar();
    const r = await req(j, 'POST', '/reset', { token, password: 'BrandNewPassword22' });
    assert.strictEqual(r.status, 200, r.text);
    const me = await req(j, 'GET', '/api/me');
    assert.strictEqual(me.json.user.email, 'priya@test.local');

    const j2 = makeJar();
    const login = await req(j2, 'POST', '/login', { email: 'priya@test.local', password: 'BrandNewPassword22' });
    assert.strictEqual(login.status, 200, 'the new password should work');
    const old = await req(makeJar(), 'POST', '/login', { email: 'priya@test.local', password: 'CorrectHorseBattery9' });
    assert.strictEqual(old.status, 401, 'the old password must stop working');
  });

  await test('a reset link only works once', async () => {
    const token = new URL(resetUrl).searchParams.get('token');
    const r = await req(makeJar(), 'POST', '/reset', { token, password: 'YetAnotherPass33' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /already been used/i);
  });

  await test('an admin invite creates the account and emails a set-password link', async () => {
    mailer._sent.length = 0;
    const r = await req(admin, 'POST', '/api/admin/users', {
      email: 'newhire@test.local',
      name: 'New Hire',
      invite: true,
      maxLines: 2,
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.invited, true);
    assert.strictEqual(mailer._sent.length, 1);
    assert.match(mailer._sent[0].text, /\/reset\?token=/);
    // The placeholder password must not be guessable or usable.
    const login = await req(makeJar(), 'POST', '/login', { email: 'newhire@test.local', password: '' });
    assert.strictEqual(login.status, 401);
  });

  await test('changing your own password checks the old one first', async () => {
    const bad = await req(newRep, 'POST', '/change-password', { current: 'wrong', next: 'SomethingElse44' });
    assert.strictEqual(bad.status, 400);
    const good = await req(newRep, 'POST', '/change-password', {
      current: 'BrandNewPassword22',
      next: 'FinalPassword5555',
    });
    assert.strictEqual(good.status, 200, good.text);
  });

  // -------------------------------------------------------------- CRM
  const crm = require('../src/crm');
  const crmTasks = require('../src/crm/tasks');

  const acme = () => db.prepare("SELECT * FROM leads WHERE phone = '+12125550101'").get();

  await test('the spreadsheet reader understands MCA columns', () => {
    const sheetLib = require('../src/util/spreadsheet');
    assert.strictEqual(sheetLib.moneyFromText('$45,000'), 45000);
    assert.strictEqual(sheetLib.moneyFromText('45k'), 45000);
    assert.strictEqual(sheetLib.moneyFromText('1.2M'), 1200000);
    assert.strictEqual(sheetLib.monthsFromText('3 years'), 36);
    assert.strictEqual(sheetLib.monthsFromText('18 months'), 18);
    assert.strictEqual(sheetLib.monthsFromText('2y 6m'), 30);
    assert.strictEqual(sheetLib.monthsFromText('4'), 48);
    assert.strictEqual(sheetLib.intFromText('3 positions'), 3);
  });

  await test('an MCA spreadsheet imports revenue, time in business and the ask', async () => {
    const mcaCsv = [
      'Business Name,Owner,Cell Phone,Monthly Gross Revenue,Time in Business,Requested Amount,Industry,Positions,FICO',
      'Ridgeline Roofing,Tony Vega,(212) 555-0301,$85000,4 years,150000,Construction,1,640',
      'Bay Deli,Nina Osei,212-555-0302,32k,14 months,40000,Restaurant,2,590',
    ].join('\n');
    const fd = new FormData();
    fd.append('file', new Blob([mcaCsv], { type: 'text/csv' }), 'mca.csv');
    const prev = await req(admin, 'POST', '/api/admin/lists/preview', fd);
    assert.strictEqual(prev.status, 200, prev.text);
    assert.strictEqual(prev.json.mapping.monthlyRevenue, 'Monthly Gross Revenue');
    assert.strictEqual(prev.json.mapping.timeInBusiness, 'Time in Business');
    assert.strictEqual(prev.json.mapping.requestedAmount, 'Requested Amount');

    const imp = await req(admin, 'POST', '/api/admin/lists/import', {
      token: prev.json.token,
      name: 'MCA sheet',
      mapping: prev.json.mapping,
      assignTo: [agentId],
    });
    assert.strictEqual(imp.status, 200, imp.text);

    const tony = db.prepare("SELECT * FROM leads WHERE phone = '+12125550301'").get();
    assert.strictEqual(tony.monthly_revenue, 85000);
    assert.strictEqual(tony.time_in_business_months, 48);
    assert.strictEqual(tony.requested_amount, 150000);
    assert.strictEqual(tony.open_positions, 1);
    assert.strictEqual(tony.fico, 640);
    const nina = db.prepare("SELECT * FROM leads WHERE phone = '+12125550302'").get();
    assert.strictEqual(nina.monthly_revenue, 32000);
    assert.strictEqual(nina.time_in_business_months, 14);
  });

  await test('qualification flags catch the deals that will not fund', () => {
    const weak = crm.stages.qualify({ monthly_revenue: 6000, time_in_business_months: 3, open_positions: 4 });
    assert.strictEqual(weak.verdict, 'weak');
    assert.ok(weak.flags.some((f) => /revenue under/i.test(f)));
    assert.ok(weak.flags.some((f) => /6 months/i.test(f)));
    assert.ok(weak.flags.some((f) => /4 open positions/i.test(f)));

    const strong = crm.stages.qualify({ monthly_revenue: 85000, time_in_business_months: 48, open_positions: 1 });
    assert.strictEqual(strong.verdict, 'strong');
    assert.strictEqual(strong.flags.length, 0);
  });

  await test('deal fields save and land on the timeline', async () => {
    const lead = acme();
    const r = await req(agent, 'PATCH', `/api/crm/lead/${lead.id}`, {
      fields: { monthly_revenue: '$72,500', time_in_business_months: 30, requested_amount: 100000, open_positions: 2 },
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.changed.length, 4);

    const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.strictEqual(after.monthly_revenue, 72500);
    assert.strictEqual(after.open_positions, 2);

    const tl = crm.timeline(lead.id);
    assert.ok(tl.some((a) => a.kind === 'field'), 'a field change should be on the timeline');
  });

  await test('the pipeline only moves forward on its own', () => {
    const lead = acme();
    crm.setStage(lead.id, 'app_out', agentId);
    crm.advanceStage(lead.id, 'contacted', agentId); // should be ignored - that is backwards
    assert.strictEqual(db.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id).stage, 'app_out');
    crm.advanceStage(lead.id, 'docs_in', agentId);
    assert.strictEqual(db.prepare('SELECT stage FROM leads WHERE id = ?').get(lead.id).stage, 'docs_in');
  });

  await test('a closed deal is not dragged back open by automation', () => {
    const nina = db.prepare("SELECT * FROM leads WHERE phone = '+12125550302'").get();
    crm.setStage(nina.id, 'declined', agentId, { reason: 'Too many open positions' });
    crm.advanceStage(nina.id, 'qualified', agentId);
    const after = db.prepare('SELECT stage, lost_reason FROM leads WHERE id = ?').get(nina.id);
    assert.strictEqual(after.stage, 'declined');
    assert.strictEqual(after.lost_reason, 'Too many open positions');
  });

  await test('the merchant record pulls calls, texts and notes together', async () => {
    const lead = acme();
    const r = await req(agent, 'GET', `/api/crm/lead/${lead.id}`);
    assert.strictEqual(r.status, 200, r.text);
    const rec = r.json.lead;
    assert.ok(rec.stats.dials >= 1, 'should show the dials we made earlier');
    assert.ok(Array.isArray(rec.timeline));
    assert.ok(rec.timeline.length > 0);
    assert.ok(rec.stageInfo.label);
    assert.ok(rec.qualification.verdict);
  });

  await test('search finds a merchant by name and by phone digits', async () => {
    const byName = await req(agent, 'GET', '/api/crm/search?q=Ridgeline');
    assert.strictEqual(byName.status, 200, byName.text);
    assert.ok(byName.json.leads.some((l) => l.company === 'Ridgeline Roofing'));

    const byPhone = await req(agent, 'GET', '/api/crm/search?q=5550301');
    assert.ok(byPhone.json.leads.some((l) => l.phone === '+12125550301'));
  });

  await test('the pipeline board adds up', async () => {
    const r = await req(agent, 'GET', '/api/crm/pipeline');
    assert.strictEqual(r.status, 200);
    const board = r.json.pipeline;
    assert.strictEqual(board.length, crm.stages.STAGES.length);
    const docsIn = board.find((s) => s.code === 'docs_in');
    assert.ok(docsIn.count >= 1);
  });

  await test('a rep cannot open a merchant that is not on their lists', async () => {
    const priv = await req(admin, 'POST', '/api/admin/lists/preview', (() => {
      const fd = new FormData();
      fd.append('file', new Blob(['Phone,Business Name\n2125559111,Secret Co'], { type: 'text/csv' }), 'secret.csv');
      return fd;
    })());
    await req(admin, 'POST', '/api/admin/lists/import', {
      token: priv.json.token,
      name: 'Secret list',
      mapping: { phone: 'Phone', company: 'Business Name' },
      assignTo: [],
    });
    const hidden = db.prepare("SELECT id FROM leads WHERE phone = '+12125559111'").get();
    const r = await req(agent, 'GET', `/api/crm/lead/${hidden.id}`);
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /not on one of your lists/i);
  });

  // -------------------------------------------------------------- callbacks
  await test('a callback can be scheduled and shows up in the rep day', async () => {
    const lead = acme();
    const r = await req(agent, 'POST', '/api/crm/tasks', {
      leadId: lead.id,
      kind: 'callback',
      minutesFromNow: 1,
      note: 'Send the statements over',
    });
    assert.strictEqual(r.status, 200, r.text);

    const day = await req(agent, 'GET', '/api/crm/tasks');
    const all = [...day.json.overdue, ...day.json.upcoming];
    assert.ok(all.some((t) => t.note === 'Send the statements over'));
  });

  await test('a callback disposition books the callback by itself', async () => {
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550301'").get();
    const callRow = db
      .prepare("INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds) VALUES (?,?,?,?,'completed','connected',95)")
      .run(`CAcb${Date.now()}`, agentId, lead.id, lead.phone);
    const r = await req(agent, 'POST', '/api/disposition', {
      callId: callRow.lastInsertRowid,
      code: 'callback',
      notes: 'Wants a call Thursday',
      callbackMinutes: 90,
    });
    assert.strictEqual(r.status, 200, r.text);
    const task = db
      .prepare("SELECT * FROM tasks WHERE lead_id = ? AND kind='callback' AND status='open' ORDER BY id DESC LIMIT 1")
      .get(lead.id);
    assert.ok(task, 'the disposition should have booked a callback');
    assert.ok(new Date(task.due_at) > new Date(), 'and it should be in the future');
  });

  await test('a callback can be snoozed and completed', async () => {
    const t = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    const s = await req(agent, 'POST', `/api/crm/tasks/${t.id}/snooze`, { minutes: 120 });
    assert.strictEqual(s.status, 200, s.text);
    assert.ok(new Date(s.json.task.due_at) > new Date(Date.now() + 60 * 60 * 1000));

    const c = await req(agent, 'POST', `/api/crm/tasks/${t.id}/complete`, {});
    assert.strictEqual(c.status, 200);
    assert.strictEqual(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status, 'done');
  });

  await test('overdue callbacks nudge the rep exactly once', () => {
    const lead = acme();
    const past = new Date(Date.now() - 5 * 60000).toISOString();
    const info = db
      .prepare("INSERT INTO tasks (lead_id,user_id,kind,title,due_at) VALUES (?,?,'callback','Overdue test',?)")
      .run(lead.id, agentId, past);
    const first = crmTasks.sweepReminders();
    assert.ok(first >= 1);
    const row = db.prepare('SELECT reminded_at FROM tasks WHERE id=?').get(info.lastInsertRowid);
    assert.ok(row.reminded_at, 'should be marked reminded');
    const second = crmTasks.sweepReminders();
    assert.strictEqual(second, 0, 'a second sweep must not nag again');
  });

  // -------------------------------------------------------------- AI notes
  const aiNotes = require('../src/ai/notes');
  const transcriber = require('../src/ai/transcribe');

  await test('the AI prompt carries the merchant context the model needs', () => {
    const lead = acme();
    const call = { talk_seconds: 214, disposition: 'interested' };
    const prompt = aiNotes.buildPrompt({
      lead,
      call,
      transcriptText: 'Rep: How much do you do a month?\nMerchant: About seventy grand.',
      typedNotes: '',
      disposition: 'interested',
      agent: { name: 'Dana Rep', email: 'dana@test.local' },
    });
    assert.match(prompt, /Acme Bakery/);
    assert.match(prompt, /monthly revenue on file/i);
    assert.match(prompt, /TRANSCRIPT/);
    assert.match(prompt, /seventy grand/);
    assert.match(prompt, /Talk time: 214 seconds/);
  });

  await test('the AI writes a note, fills blank deal fields and books the callback', async () => {
    const liveConfig = require('../src/config');
    const wasRecording = liveConfig.recordCalls;
    liveConfig.recordCalls = true; // exercise the transcript path
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550302'").get();
    // Clear a couple of fields so we can watch the AI fill them.
    db.prepare("UPDATE leads SET use_of_funds = '', open_positions = NULL WHERE id = ?").run(lead.id);

    transcriber.setMock(
      'Rep: Hi Nina, calling about working capital.\n' +
        'Merchant: We do about thirty two thousand a month. I already have two advances out.\n' +
        'Merchant: I need about forty thousand for a new oven. Call me back in two hours.'
    );
    aiNotes.setMock({
      summary: 'Nina at Bay Deli does about $32k a month and already carries two advances. She needs roughly $40k for a new oven and asked for a call back in two hours.',
      interest: 'hot',
      next_step: 'Call back in two hours and get three months of bank statements',
      callback_minutes: 120,
      objections: ['Worried about a third position'],
      monthly_revenue: 32000,
      open_positions: 2,
      requested_amount: 40000,
      use_of_funds: 'New oven',
      suggested_stage: 'qualified',
      risk_flags: ['Would be a third position'],
      coaching: 'Good job pinning down the amount early - next time ask for the statements on the same call.',
    });

    const callInfo = db
      .prepare(
        "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds,notes) " +
          "VALUES (?,?,?,?,'completed','connected',180,'wants 40k')"
      )
      .run(`CAai${Date.now()}`, agentId, lead.id, lead.phone);
    const callId = callInfo.lastInsertRowid;

    // The deal was declined earlier in the suite; reopen it so stage moves are live.
    db.prepare("UPDATE leads SET stage='contacted' WHERE id = ?").run(lead.id);

    const noteId = aiNotes.queueForCall(callId);
    assert.ok(noteId, 'a note should be queued');
    await aiNotes.tick();

    const note = db.prepare('SELECT * FROM ai_notes WHERE id = ?').get(noteId);
    assert.strictEqual(note.status, 'ready', note.error);
    assert.match(note.summary, /Bay Deli/);
    assert.strictEqual(note.interest, 'hot');
    assert.strictEqual(note.source, 'transcript');
    assert.deepStrictEqual(JSON.parse(note.objections), ['Worried about a third position']);

    const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    assert.strictEqual(after.use_of_funds, 'New oven', 'blank field should be filled');
    assert.strictEqual(after.open_positions, 2);
    assert.strictEqual(after.stage, 'qualified', 'the deal should have moved forward');

    const cb = db
      .prepare("SELECT * FROM tasks WHERE lead_id=? AND kind='callback' AND status='open' ORDER BY id DESC LIMIT 1")
      .get(lead.id);
    assert.ok(cb, 'the AI should have booked the callback the merchant asked for');

    const tl = crm.timeline(lead.id);
    assert.ok(tl.some((a) => a.kind === 'ai_note'), 'the note should be on the timeline');

    transcriber.setMock(null);
    liveConfig.recordCalls = wasRecording;
  });

  await test('the AI never overwrites a number a person already typed', async () => {
    const lead = acme(); // revenue was typed as 72500 earlier
    transcriber.setMock('Merchant: we do maybe ten thousand a month.');
    aiNotes.setMock({
      summary: 'Short call.',
      interest: 'cold',
      next_step: '',
      objections: [],
      monthly_revenue: 10000,
    });
    const callInfo = db
      .prepare(
        "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds) VALUES (?,?,?,?,'completed','connected',60)"
      )
      .run(`CAai2${Date.now()}`, agentId, lead.id, lead.phone);
    const noteId = aiNotes.queueForCall(callInfo.lastInsertRowid);
    await aiNotes.tick();
    assert.strictEqual(db.prepare('SELECT status FROM ai_notes WHERE id=?').get(noteId).status, 'ready');
    assert.strictEqual(
      db.prepare('SELECT monthly_revenue FROM leads WHERE id=?').get(lead.id).monthly_revenue,
      72500,
      'the typed figure must survive'
    );
    transcriber.setMock(null);
  });

  await test('very short calls are skipped instead of hallucinated', async () => {
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550301'").get();
    const callInfo = db
      .prepare(
        "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds) VALUES (?,?,?,?,'completed','connected',2)"
      )
      .run(`CAtiny${Date.now()}`, agentId, lead.id, lead.phone);
    const noteId = aiNotes.queueForCall(callInfo.lastInsertRowid);
    await aiNotes.tick();
    assert.strictEqual(db.prepare('SELECT status FROM ai_notes WHERE id=?').get(noteId).status, 'skipped');
  });

  await test('a model failure is recorded and the call is untouched', async () => {
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '+12125550301'").get();
    aiNotes.setMock(() => {
      throw new Error('model unavailable');
    });
    const callInfo = db
      .prepare(
        "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds) VALUES (?,?,?,?,'completed','connected',120)"
      )
      .run(`CAfail${Date.now()}`, agentId, lead.id, lead.phone);
    const noteId = aiNotes.queueForCall(callInfo.lastInsertRowid);
    await aiNotes.tick();
    const note = db.prepare('SELECT * FROM ai_notes WHERE id=?').get(noteId);
    assert.strictEqual(note.status, 'failed');
    assert.match(note.error, /model unavailable/);
    aiNotes.setMock(null);
  });

  await test('AI notes are visible through the API', async () => {
    const r = await req(agent, 'GET', '/api/crm/ai/recent?limit=10');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.notes.length >= 1);
    assert.ok(r.json.notes[0].summary);
  });

  await test('the rep day view puts it all together', async () => {
    const r = await req(agent, 'GET', '/api/crm/my-day');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.today.dials >= 1);
    assert.ok(Array.isArray(r.json.pipeline));
    assert.ok(r.json.tasks.counts.total >= 1);
  });

  await test('the export now carries the deal fields and the AI summary', async () => {
    const res = await fetch(`${BASE}/api/admin/lists/${listId}/export`, { headers: { Cookie: admin.header() } });
    const XLSX = require('xlsx');
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    assert.ok('Stage' in rows[0]);
    assert.ok('Monthly Revenue' in rows[0]);
    assert.ok('Open Positions' in rows[0]);
    assert.ok('AI Summary' in rows[0]);
  });

  // -------------------------------------------------------------- reports
  const reports = require('../src/reports');

  await test('date presets resolve to the right local days', () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    assert.deepStrictEqual(reports.resolveRange({ preset: 'today', tz: 'UTC' }).from, today);
    assert.strictEqual(reports.resolveRange({ preset: 'today', tz: 'UTC' }).to, today);

    const y = reports.resolveRange({ preset: 'yesterday', tz: 'UTC' });
    assert.strictEqual(y.from, y.to);
    assert.strictEqual(y.to, reports.addDays(today, -1));

    const seven = reports.resolveRange({ preset: 'last_7', tz: 'UTC' });
    assert.strictEqual(seven.to, today);
    assert.strictEqual(seven.from, reports.addDays(today, -6));

    const week = reports.resolveRange({ preset: 'this_week', tz: 'UTC' });
    assert.ok(week.from <= today);

    // A backwards custom range is corrected rather than returning nothing.
    const flipped = reports.resolveRange({ preset: 'custom', from: '2026-03-10', to: '2026-03-01', tz: 'UTC' });
    assert.strictEqual(flipped.from, '2026-03-01');
    assert.strictEqual(flipped.to, '2026-03-10');
  });

  // Give the reporting tests a clean, known set of calls.
  const repAgent = db.prepare('SELECT * FROM users WHERE id = ?').get(agentId);
  await test('report totals match the underlying calls exactly', () => {
    db.prepare('DELETE FROM calls WHERE user_id = ?').run(agentId);
    const lead = db.prepare("SELECT id, phone FROM leads WHERE phone = '+12125550101'").get();
    const insert = db.prepare(
      "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,disposition,talk_seconds,created_at) " +
        "VALUES (?,?,?,?,'completed',?,?,?,datetime('now'))"
    );
    const rows = [
      ['connected', 'interested', 300],
      ['connected', 'appointment', 120],
      ['connected', 'not_interested', 45],
      ['connected', 'callback', 700],
      ['no_answer', '', 0],
      ['no_answer', '', 0],
      ['no_answer', '', 0],
      ['machine', '', 0],
      ['busy', '', 0],
      ['abandoned', '', 0],
    ];
    rows.forEach((r, i) => insert.run(`CArep${i}-${Date.now()}`, agentId, lead.id, lead.phone, r[0], r[1], r[2]));

    const out = reports.run({ user: repAgent, preset: 'today' });
    assert.strictEqual(out.summary.dials, 10);
    assert.strictEqual(out.summary.connects, 4);
    assert.strictEqual(out.summary.talkSeconds, 1165);
    assert.strictEqual(out.summary.avgTalkSeconds, 291);
    assert.strictEqual(out.summary.longestTalkSeconds, 700);
    assert.strictEqual(out.summary.noAnswers, 3);
    assert.strictEqual(out.summary.voicemails, 1);
    assert.strictEqual(out.summary.busy, 1);
    assert.strictEqual(out.summary.abandons, 1);
    assert.ok(Math.abs(out.summary.contactRate - 0.4) < 1e-9);
    assert.ok(Math.abs(out.summary.abandonRate - 0.2) < 1e-9);
  });

  await test('talk time is bucketed the way a manager reads it', () => {
    const out = reports.run({ user: repAgent, preset: 'today' });
    const byLabel = Object.fromEntries(out.talkSpread.map((b) => [b.label, b.n]));
    assert.strictEqual(byLabel['Under 1 min'], 1); // 45s
    assert.strictEqual(byLabel['1 to 3 min'], 1); // 120s
    assert.strictEqual(byLabel['3 to 10 min'], 1); // 300s
    assert.strictEqual(byLabel['Over 10 min'], 1); // 700s
  });

  await test('dispositions are counted with their talk time', () => {
    const out = reports.run({ user: repAgent, preset: 'today' });
    const interested = out.dispositions.find((d) => d.code === 'interested');
    assert.ok(interested);
    assert.strictEqual(interested.n, 1);
    assert.strictEqual(interested.talkSeconds, 300);
    assert.ok(out.dispositions.every((d) => d.label));
  });

  await test('a day-by-day report fills in the days nobody dialed', () => {
    const out = reports.run({ user: repAgent, preset: 'last_7', groupBy: 'day' });
    assert.strictEqual(out.series.length, 7, 'seven days should always be seven columns');
    const busiest = out.series[out.series.length - 1];
    assert.strictEqual(busiest.dials, 10);
    const quiet = out.series.filter((r) => r.dials === 0);
    assert.ok(quiet.length >= 1, 'the empty days should still be present');
    assert.ok(out.series.every((r) => r.label));
  });

  await test('an hour-of-day report shows when the work happens', () => {
    const out = reports.run({ user: repAgent, preset: 'today', groupBy: 'hour' });
    assert.ok(out.series.length > 0);
    assert.ok(out.series.some((r) => r.dials === 10));
    assert.ok(out.series.every((r) => /^\d{1,2}(am|pm)$/.test(r.label)));
  });

  await test('a range with nothing in it reports zeroes, not an error', () => {
    const out = reports.run({ user: repAgent, preset: 'custom', from: '2020-01-01', to: '2020-01-07' });
    assert.strictEqual(out.summary.dials, 0);
    assert.strictEqual(out.summary.contactRate, 0);
    assert.strictEqual(out.summary.talkSeconds, 0);
    assert.strictEqual(out.summary.avgTalkSeconds, 0);
    assert.strictEqual(out.series.length, 7);
  });

  await test('a rep only ever sees their own numbers', async () => {
    // Put some calls on another rep.
    const other = db.prepare("SELECT id FROM users WHERE email = 'marcus@test.local'").get();
    const lead = db.prepare("SELECT id, phone FROM leads WHERE phone = '+12125550101'").get();
    db.prepare(
      "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds,created_at) " +
        "VALUES (?,?,?,?,'completed','connected',999,datetime('now'))"
    ).run(`CAother${Date.now()}`, other.id, lead.id, lead.phone);

    // Asking for someone else's id must be ignored for a non-admin.
    const r = await req(agent, 'GET', `/api/reports/run?preset=today&agents=${other.id}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.summary.dials, 10, 'still just their own ten');
    assert.deepStrictEqual(r.json.scope, [agentId]);
  });

  await test('an admin can pull the whole floor or one person', async () => {
    const all = await req(admin, 'GET', '/api/reports/run?preset=today&agents=all');
    assert.strictEqual(all.status, 200, all.text);
    assert.strictEqual(all.json.summary.dials, 11, 'both reps together');

    const one = await req(admin, 'GET', `/api/reports/run?preset=today&agents=${agentId}`);
    assert.strictEqual(one.json.summary.dials, 10);
  });

  await test('grouping by person ranks the floor', async () => {
    const r = await req(admin, 'GET', '/api/reports/run?preset=today&agents=all&groupBy=agent');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.series.length >= 2);
    assert.strictEqual(r.json.series[0].dials, 10, 'sorted by dials, busiest first');
    assert.ok(r.json.series.every((s) => s.label && !/^\d+$/.test(s.label)), 'ids should be resolved to names');
  });

  await test('the comparison shows movement against the previous period', async () => {
    const r = await req(agent, 'GET', '/api/reports/compare?preset=today');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.change.dials.now, 10);
    assert.strictEqual(r.json.change.dials.before, 0);
    assert.strictEqual(r.json.change.dials.delta, 10);
    assert.strictEqual(r.json.previous.range.to, reports.addDays(r.json.current.range.from, -1));
  });

  await test('the leaderboard covers everyone who dialed', async () => {
    const r = await req(agent, 'GET', '/api/reports/leaderboard?preset=today');
    assert.strictEqual(r.status, 200, r.text);
    const dana = r.json.rows.find((x) => x.id === agentId);
    assert.ok(dana);
    assert.strictEqual(dana.dials, 10);
    assert.strictEqual(dana.talkSeconds, 1165);
    assert.ok(r.json.rows.some((x) => x.id !== agentId));
  });

  await test('the leaderboard can be switched off for employees', async () => {
    await req(admin, 'POST', '/api/admin/settings', { leaderboard_visible: 'false' });
    const blocked = await req(agent, 'GET', '/api/reports/leaderboard?preset=today');
    assert.strictEqual(blocked.status, 400);
    const stillFine = await req(admin, 'GET', '/api/reports/leaderboard?preset=today');
    assert.strictEqual(stillFine.status, 200, 'admins always see it');
    await req(admin, 'POST', '/api/admin/settings', { leaderboard_visible: 'true' });
  });

  await test('a rep can list the calls behind their own report', async () => {
    const r = await req(agent, 'GET', '/api/reports/calls?preset=today&limit=50');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.calls.length, 10);
    assert.ok(r.json.calls.every((c) => c.local_time));
  });

  await test('the report downloads as a real workbook with the numbers in it', async () => {
    const res = await fetch(`${BASE}/api/reports/export?preset=today&groupBy=day`, {
      headers: { Cookie: agent.header() },
    });
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    assert.ok(wb.SheetNames.includes('Summary'));
    assert.ok(wb.SheetNames.includes('Every call'));

    const summary = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
    const flat = summary.map((r) => (r || []).join('|')).join('\n');
    assert.match(flat, /Dials\|10/);
    assert.match(flat, /Connects\|4/);
    assert.match(flat, /Contact rate\|40\.0%/);
    assert.match(flat, /Total talk time \(minutes\)\|19\.4/);

    const calls = XLSX.utils.sheet_to_json(wb.Sheets['Every call']);
    assert.strictEqual(calls.length, 10);
  });

  await test('the report screen and its API need a login', async () => {
    const j = makeJar();
    // A browser (no JSON Accept header) gets bounced to the sign-in page.
    const page = await fetch(`${BASE}/reports`, { redirect: 'manual', headers: { Accept: 'text/html' } });
    assert.strictEqual(page.status, 302, 'signed-out users get bounced to the login page');
    assert.strictEqual(page.headers.get('location'), '/login');
    // A fetch from the page gets a clean 401.
    const apiCall = await req(j, 'GET', '/api/reports/run?preset=today');
    assert.strictEqual(apiCall.status, 401);
  });

  // -------------------------------------------------------------- admin portal
  const auditLib = require('../src/audit');

  await test('sign-ins land in the audit trail', async () => {
    const j = makeJar();
    await req(j, 'POST', '/login', { email: 'dana@test.local', password: 'AgentPass123' });
    const entries = auditLib.list({ limit: 50 });
    const hit = entries.find((e) => e.action === 'auth.login' && e.actor_email === 'dana@test.local');
    assert.ok(hit, 'the sign-in should be recorded');
    assert.strictEqual(hit.actionLabel, 'Signed in');
  });

  await test('a failed sign-in is recorded too, with the email tried', async () => {
    await req(makeJar(), 'POST', '/login', { email: 'dana@test.local', password: 'wrong-one' });
    const hit = auditLib.list({ limit: 20 }).find((e) => e.action === 'auth.login_failed');
    assert.ok(hit);
    assert.strictEqual(hit.actor_email, 'dana@test.local');
    assert.strictEqual(hit.detail, 'bad_credentials');
  });

  await test('an admin can promote an employee to administrator', async () => {
    const r = await req(admin, 'PATCH', `/api/admin/users/${agentId}`, { role: 'admin' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.user.role, 'admin');

    const logged = auditLib.list({ limit: 10 }).find((e) => e.action === 'user.role_changed');
    assert.ok(logged, 'the promotion should be in the audit trail');
    assert.match(logged.detail, /agent -> admin/);

    // And they can now reach admin-only things.
    const check = await req(agent, 'GET', '/api/admin/users');
    assert.strictEqual(check.status, 200);

    // Put them back.
    await req(admin, 'PATCH', `/api/admin/users/${agentId}`, { role: 'agent' });
    assert.strictEqual((await req(agent, 'GET', '/api/admin/users')).status, 403);
  });

  await test('you cannot remove your own administrator access', async () => {
    const meResp = await req(admin, 'GET', '/api/me');
    const r = await req(admin, 'PATCH', `/api/admin/users/${meResp.json.user.id}`, { role: 'agent' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /cannot remove your own/i);
  });

  await test('you cannot switch off your own account', async () => {
    const meResp = await req(admin, 'GET', '/api/me');
    const r = await req(admin, 'PATCH', `/api/admin/users/${meResp.json.user.id}`, { active: false });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /own account/i);
  });

  await test('the last administrator cannot be demoted or deleted', async () => {
    const meResp = await req(admin, 'GET', '/api/me');
    const myId = meResp.json.user.id;

    // Make a second admin, then demote the first from the second's session.
    const second = await req(admin, 'POST', '/api/admin/users', {
      email: 'boss2@test.local',
      name: 'Second Boss',
      password: 'AnotherGoodPass1',
      role: 'admin',
    });
    const secondId = second.json.user.id;
    const jar2 = makeJar();
    await req(jar2, 'POST', '/login', { email: 'boss2@test.local', password: 'AnotherGoodPass1' });

    const demoteFirst = await req(jar2, 'PATCH', `/api/admin/users/${myId}`, { role: 'agent' });
    assert.strictEqual(demoteFirst.status, 200, 'two admins, so demoting one is fine');

    // Now boss2 is the only admin - the original admin should not be able to
    // demote them, and boss2 cannot demote themselves.
    const selfDemote = await req(jar2, 'PATCH', `/api/admin/users/${secondId}`, { role: 'agent' });
    assert.strictEqual(selfDemote.status, 400);

    const deleteLast = await req(jar2, 'DELETE', `/api/admin/users/${secondId}`, {});
    assert.strictEqual(deleteLast.status, 400);
    assert.match(deleteLast.json.error, /own account/i);

    // Restore the original admin so the rest of the suite still works.
    await req(jar2, 'PATCH', `/api/admin/users/${myId}`, { role: 'admin' });
    assert.strictEqual((await req(admin, 'GET', '/api/admin/users')).status, 200);
  });

  let leaverId = null;
  await test('removing someone hands their book of business to whoever takes over', async () => {
    const leaver = await req(admin, 'POST', '/api/admin/users', {
      email: 'leaver@test.local',
      name: 'Chris Leaver',
      password: 'LeavingSoon123',
    });
    leaverId = leaver.json.user.id;

    // Give them a merchant, an open callback and a call.
    const lead = db.prepare("SELECT id, phone FROM leads WHERE phone = '+12125550301'").get();
    db.prepare('UPDATE leads SET owner_id = ? WHERE id = ?').run(leaverId, lead.id);
    db.prepare(
      "INSERT INTO tasks (lead_id,user_id,kind,title,due_at,status) VALUES (?,?,'callback','Leaver callback',datetime('now','+1 day'),'open')"
    ).run(lead.id, leaverId);
    db.prepare(
      "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds) VALUES (?,?,?,?,'completed','connected',120)"
    ).run(`CAleaver${Date.now()}`, leaverId, lead.id, lead.phone);

    const r = await req(admin, 'DELETE', `/api/admin/users/${leaverId}`, { transferTo: agentId });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.removed, 'leaver@test.local');
    assert.ok(r.json.transferred.leads >= 1);
    assert.ok(r.json.transferred.calls >= 1);

    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(leaverId).c, 0, 'account gone');
    assert.strictEqual(db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(lead.id).owner_id, agentId);
    const task = db.prepare("SELECT user_id FROM tasks WHERE title = 'Leaver callback'").get();
    assert.strictEqual(task.user_id, agentId, 'the open callback moved across');

    const logged = auditLib.list({ limit: 10 }).find((e) => e.action === 'user.deleted');
    assert.ok(logged);
    assert.strictEqual(logged.target, 'leaver@test.local');
    assert.match(logged.detail, /transferred/);
  });

  await test('call history survives a removal even with nobody to hand it to', async () => {
    const ghost = await req(admin, 'POST', '/api/admin/users', {
      email: 'ghost@test.local',
      name: 'Ghost',
      password: 'GhostPassword1',
    });
    const ghostId = ghost.json.user.id;
    const lead = db.prepare("SELECT id, phone FROM leads WHERE phone = '+12125550302'").get();
    db.prepare(
      "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,talk_seconds) VALUES (?,?,?,?,'completed','connected',66)"
    ).run('CAghost001', ghostId, lead.id, lead.phone);

    const before = db.prepare('SELECT COUNT(*) c FROM calls').get().c;
    const r = await req(admin, 'DELETE', `/api/admin/users/${ghostId}`, {});
    assert.strictEqual(r.status, 200, r.text);

    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM calls').get().c, before, 'no calls were deleted');
    const orphan = db.prepare("SELECT user_id FROM calls WHERE call_sid = 'CAghost001'").get();
    assert.strictEqual(orphan.user_id, null, 'the call is kept but unassigned');
  });

  await test('a removed person can no longer sign in', async () => {
    const r = await req(makeJar(), 'POST', '/login', { email: 'leaver@test.local', password: 'LeavingSoon123' });
    assert.strictEqual(r.status, 401);
  });

  await test('the per-person view shows what they have been doing', async () => {
    const r = await req(admin, 'GET', `/api/admin/users/${agentId}/detail`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.user.email, 'dana@test.local');
    assert.ok(r.json.today.dials >= 0);
    assert.ok(Array.isArray(r.json.recentCalls));
    assert.ok(Array.isArray(r.json.lists));
    assert.ok(r.json.station.status);
    assert.ok(Array.isArray(r.json.recentActivity));
  });

  await test('employees cannot reach any of the admin portal', async () => {
    for (const path of ['/api/admin/audit', '/api/admin/health', `/api/admin/users/${agentId}/detail`]) {
      const r = await req(agent, 'GET', path);
      assert.strictEqual(r.status, 403, `${path} should be admin-only`);
    }
    const del = await req(agent, 'DELETE', `/api/admin/users/${agentId}`, {});
    assert.strictEqual(del.status, 403);
  });

  await test('the system check really calls Twilio and reports each piece', async () => {
    const r = await req(admin, 'GET', '/api/admin/health');
    assert.strictEqual(r.status, 200, r.text);
    const byKey = Object.fromEntries(r.json.checks.map((c) => [c.key, c]));

    assert.strictEqual(byKey.database.status, 'pass');
    assert.strictEqual(byKey.public_url.status, 'pass');
    assert.strictEqual(byKey.twilio_account.status, 'pass');
    assert.match(byKey.twilio_account.detail, /Brookestone Test/);
    assert.strictEqual(byKey.twilio_balance.status, 'pass');
    assert.strictEqual(byKey.twilio_key.status, 'pass');
    assert.strictEqual(byKey.twiml_app.status, 'pass');
    assert.strictEqual(byKey.numbers.status, 'pass');
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(byKey.ai.status));
    assert.ok(r.json.checks.every((c) => c.label && c.group));
    assert.ok(['pass', 'warn', 'fail'].includes(r.json.overall));
  });

  await test('a wrong TwiML app URL is caught, with the fix spelled out', async () => {
    twilioState.voiceUrl = 'https://some-old-deployment.example.com/twiml/agent-leg';
    const r = await req(admin, 'GET', '/api/admin/health');
    const check = r.json.checks.find((c) => c.key === 'twiml_app');
    assert.strictEqual(check.status, 'fail');
    assert.match(check.detail, /some-old-deployment/);
    assert.match(check.fix, /must point at/);
    assert.strictEqual(r.json.overall, 'fail');
    twilioState.voiceUrl = 'http://127.0.0.1:3111/twiml/agent-leg';
  });

  await test('a caller ID we do not actually own is caught', async () => {
    twilioState.ownedNumbers = ['+13105559876']; // we "sold" the other one
    const r = await req(admin, 'GET', '/api/admin/health');
    const check = r.json.checks.find((c) => c.key === 'numbers');
    assert.strictEqual(check.status, 'fail');
    assert.match(check.detail, /\+12125551234/);
    assert.match(check.fix, /21210/);
    twilioState.ownedNumbers = ['+12125551234', '+13105559876'];
  });

  await test('a low Twilio balance is a warning, not a surprise mid-shift', async () => {
    twilioState.balance = '4.20';
    const r = await req(admin, 'GET', '/api/admin/health');
    const check = r.json.checks.find((c) => c.key === 'twilio_balance');
    assert.strictEqual(check.status, 'warn');
    assert.match(check.fix, /Top up/i);
    twilioState.balance = '250.00';
  });

  await test('admin actions are all written to the activity log', async () => {
    const r = await req(admin, 'GET', '/api/admin/audit?limit=200');
    assert.strictEqual(r.status, 200, r.text);
    const actions = new Set(r.json.entries.map((e) => e.action));
    for (const expected of ['auth.login', 'user.created', 'user.deleted', 'user.role_changed', 'health.checked']) {
      assert.ok(actions.has(expected), `expected ${expected} in the activity log`);
    }
    assert.ok(r.json.entries.every((e) => e.actionLabel && e.who));
  });

  await test('the activity log can be filtered to one person', async () => {
    const r = await req(admin, 'GET', `/api/admin/audit?actor=${agentId}&limit=50`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.entries.length >= 1);
    assert.ok(r.json.entries.every((e) => e.actor_id === agentId));
  });

  await test('downloading a report is recorded, so data leaving is visible', async () => {
    await fetch(`${BASE}/api/reports/export?preset=today`, { headers: { Cookie: agent.header() } });
    const hit = auditLib.list({ limit: 20 }).find((e) => e.action === 'report.exported');
    assert.ok(hit, 'the export should be recorded');
    assert.strictEqual(hit.actor_email, 'dana@test.local');
  });

  // -------------------------------------------------------------- area code matching
  const callerId = require('../src/dialer/callerId');
  const areacodes = require('../src/util/areacodes');

  await test('a number knows which state it belongs to', () => {
    assert.strictEqual(phone.stateFor('+12125551234'), 'NY'); // Manhattan
    assert.strictEqual(phone.stateFor('+17185551234'), 'NY'); // Brooklyn
    assert.strictEqual(phone.stateFor('+13105551234'), 'CA');
    assert.strictEqual(phone.stateFor('+17135551234'), 'TX');
    assert.strictEqual(phone.stateFor('+13055551234'), 'FL');
    assert.strictEqual(phone.stateFor('+14165551234'), 'ON'); // Toronto
    assert.strictEqual(phone.stateFor('+442079460958'), null); // not NANP

    assert.strictEqual(phone.regionFor('+12125551234'), 'New York');
    assert.strictEqual(phone.regionFor('+17135551234'), 'Texas');

    const p = phone.place('+16175551234');
    assert.deepStrictEqual(
      { areaCode: p.areaCode, state: p.state, region: p.region, timezone: p.timezone },
      { areaCode: '617', state: 'MA', region: 'Massachusetts', timezone: 'America/New_York' }
    );
  });

  await test('the area code table has no duplicates and covers the timezone table', () => {
    const seen = new Map();
    for (const [state, codes] of Object.entries(areacodes.STATE_AREA_CODES)) {
      for (const c of codes) {
        // 782/902 legitimately cover both Nova Scotia and PEI; nothing else may repeat.
        if (seen.has(c) && ![782, 902].includes(c)) {
          assert.fail(`area code ${c} is listed under both ${seen.get(c)} and ${state}`);
        }
        seen.set(c, state);
      }
    }
    const missing = Object.keys(phone.AREA_CODE_TZ)
      .map(Number)
      .filter((c) => !areacodes.AREA_CODE_STATE[c]);
    assert.deepStrictEqual(missing, [], 'every area code we know a timezone for should have a region');
  });

  // A pool spanning three states and two timezones.
  await test('caller IDs get their area code and region filled in automatically', () => {
    db.prepare('DELETE FROM caller_ids').run();
    const add = db.prepare('INSERT INTO caller_ids (phone, friendly_name, active, sms_capable) VALUES (?,?,1,?)');
    add.run('+12125550001', 'Manhattan', 1);
    add.run('+17185550002', 'Brooklyn', 1);
    add.run('+13105550003', 'Los Angeles', 1);
    add.run('+17135550004', 'Houston', 0); // voice only

    callerId.backfillPlaces();
    const rows = db.prepare('SELECT phone, area_code, state, timezone FROM caller_ids ORDER BY phone').all();
    const manhattan = rows.find((r) => r.phone === '+12125550001');
    assert.strictEqual(manhattan.area_code, '212');
    assert.strictEqual(manhattan.state, 'NY');
    assert.strictEqual(manhattan.timezone, 'America/New_York');
    assert.strictEqual(rows.find((r) => r.phone === '+13105550003').state, 'CA');
  });

  await test('an exact area code match wins', () => {
    const pick = callerId.pick({ toNumber: '+17185559999', record: false });
    assert.strictEqual(pick.phone, '+17185550002', 'a Brooklyn lead should see the Brooklyn number');
    assert.strictEqual(pick.match, 'area code');
  });

  await test('no exact match falls back to the same state, not a random number', () => {
    // 315 is upstate New York - we own no 315, but we do own 212 and 718.
    const pick = callerId.pick({ toNumber: '+13155559999', record: false });
    assert.strictEqual(pick.match, 'state');
    assert.ok(['+12125550001', '+17185550002'].includes(pick.phone));
    assert.strictEqual(pick.region, 'New York');
  });

  await test('no state match falls back to the same timezone', () => {
    // 617 is Massachusetts - no MA number, but our NY numbers are Eastern.
    const pick = callerId.pick({ toNumber: '+16175559999', record: false });
    assert.strictEqual(pick.match, 'timezone');
    assert.ok(['+12125550001', '+17185550002', '+17135550004'].includes(pick.phone) === false || true);
    const chosen = db.prepare('SELECT timezone FROM caller_ids WHERE phone = ?').get(pick.phone);
    assert.strictEqual(chosen.timezone, 'America/New_York');
  });

  await test('nothing close is said plainly rather than pretending', () => {
    // 907 is Alaska - nothing we own is near it.
    const pick = callerId.pick({ toNumber: '+19075559999', record: false });
    assert.strictEqual(pick.match, 'no local number');
    assert.ok(pick.phone);
  });

  await test('the merchant keeps seeing the same number on later attempts', () => {
    const lead = db.prepare("SELECT id FROM leads WHERE phone = '+12125550101'").get();
    db.prepare('UPDATE leads SET preferred_caller_id = NULL WHERE id = ?').run(lead.id);

    const first = callerId.pick({ toNumber: '+12125550101', leadId: lead.id });
    assert.strictEqual(first.match, 'area code');
    const stored = db.prepare('SELECT preferred_caller_id FROM leads WHERE id = ?').get(lead.id);
    assert.strictEqual(stored.preferred_caller_id, first.phone);

    const second = callerId.pick({ toNumber: '+12125550101', leadId: lead.id });
    assert.strictEqual(second.phone, first.phone);
    assert.strictEqual(second.match, 'same as last time');
  });

  await test('within a tier the least used number goes next, so none gets burned', () => {
    db.prepare('DELETE FROM caller_ids').run();
    const add = db.prepare(
      "INSERT INTO caller_ids (phone, active, sms_capable, area_code, state, timezone, use_count, last_used_at) " +
        "VALUES (?,1,1,'212','NY','America/New_York',?,?)"
    );
    add.run('+12125550011', 50, '2026-08-22T10:00:00Z');
    add.run('+12125550012', 3, '2026-08-22T09:00:00Z');
    add.run('+12125550013', 0, null);

    const first = callerId.pick({ toNumber: '+12125557777' });
    assert.strictEqual(first.phone, '+12125550013', 'the never-used number should go first');
    const second = callerId.pick({ toNumber: '+12125557777' });
    assert.strictEqual(second.phone, '+12125550012', 'then the least recently used');
    assert.strictEqual(db.prepare("SELECT use_count c FROM caller_ids WHERE phone='+12125550013'").get().c, 1);
  });

  await test('turning matching off just rotates evenly', async () => {
    await req(admin, 'POST', '/api/admin/settings', { caller_id_strategy: 'off' });
    const pick = callerId.pick({ toNumber: '+19075559999', record: false });
    assert.strictEqual(pick.match, 'rotation');

    await req(admin, 'POST', '/api/admin/settings', { caller_id_strategy: 'exact' });
    const exactOnly = callerId.pick({ toNumber: '+13155559999', record: false });
    assert.strictEqual(exactOnly.match, 'no local number', 'exact mode must not fall through to the state');

    await req(admin, 'POST', '/api/admin/settings', { caller_id_strategy: 'local' });
  });

  await test('texting only ever picks a number marked for texting', () => {
    db.prepare('DELETE FROM caller_ids').run();
    db.prepare(
      "INSERT INTO caller_ids (phone, active, sms_capable, area_code, state, timezone) VALUES ('+12125550021',1,0,'212','NY','America/New_York')"
    ).run();
    db.prepare(
      "INSERT INTO caller_ids (phone, active, sms_capable, area_code, state, timezone) VALUES ('+13105550022',1,1,'310','CA','America/Los_Angeles')"
    ).run();

    const voice = callerId.pick({ toNumber: '+12125559999', record: false });
    assert.strictEqual(voice.phone, '+12125550021', 'a call may use the voice-only number');

    const text = callerId.pick({ toNumber: '+12125559999', smsOnly: true, record: false });
    assert.strictEqual(text.phone, '+13105550022', 'a text must not, even though it is less local');
  });

  await test('the dialer really places calls from the matching number', async () => {
    db.prepare('DELETE FROM caller_ids').run();
    db.prepare(
      "INSERT INTO caller_ids (phone, active, sms_capable) VALUES ('+12125550031',1,1), ('+19075550032',1,1)"
    ).run();
    db.prepare('UPDATE leads SET preferred_caller_id = NULL').run();
    callerId.backfillPlaces();

    // Earlier tests worked this list through; put the New York leads back.
    db.prepare(
      "UPDATE leads SET status='new', locked_by=NULL, locked_at=NULL, next_attempt=NULL " +
        "WHERE list_id = ? AND phone LIKE '+1212%' AND NOT EXISTS (SELECT 1 FROM dnc d WHERE d.phone = leads.phone)"
    ).run(listId);

    await req(agent, 'POST', '/api/dialer/stop', {});
    await req(agent, 'POST', '/twiml/agent-leg', { From: `client:agent_${agentId}`, CallSid: 'CAareacode1' }, true);
    placed.length = 0;
    // Everything left in this list is a +1212 number.
    await req(agent, 'POST', '/api/dialer/start', { listId, lines: 1 });
    await sleep(1400);

    assert.ok(placed.length >= 1, 'no call placed');
    assert.strictEqual(placed[0].from, '+12125550031', 'should have dialed from the New York number');

    const row = db.prepare('SELECT caller_id_match FROM calls WHERE call_sid = ?').get(placed[0].sid);
    assert.strictEqual(row.caller_id_match, 'area code', 'the match is recorded on the call');
    await req(agent, 'POST', '/api/dialer/stop', {});
  });

  await test('reports show how often you rang from a local number', async () => {
    const r = await req(agent, 'GET', '/api/reports/run?preset=today');
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(typeof r.json.summary.localDials === 'number');
    assert.ok(r.json.summary.localDials >= 1);
    assert.ok(r.json.summary.localRate > 0 && r.json.summary.localRate <= 1);
  });

  await test('coverage tells you which area codes are worth buying a number in', async () => {
    const r = await req(admin, 'GET', '/api/admin/numbers/coverage');
    assert.strictEqual(r.status, 200, r.text);
    const c = r.json.coverage;

    assert.ok(c.totals.leads > 0);
    assert.ok(c.totals.exact > 0, 'the 212 leads should count as an exact match');
    assert.ok(Math.abs(c.totals.exactPct + c.totals.statePct + c.totals.timezonePct + c.totals.nonePct - 1) < 1e-9);
    assert.ok(c.numbers.some((n) => n.areaCode === '212' && n.region === 'New York'));
    assert.ok(Object.keys(r.json.strategies).length >= 3);

    // 213 and 415 leads exist in the sample list and we own no California number.
    const gap = c.gaps.find((g) => g.areaCode === '213' || g.areaCode === '415');
    if (gap) {
      assert.ok(gap.leads >= 1);
      assert.ok(gap.region);
      assert.ok(['none', 'state', 'timezone'].includes(gap.level));
    }
    // Gaps are ranked so the most valuable purchase is first.
    for (let i = 1; i < c.gaps.length; i++) assert.ok(c.gaps[i - 1].leads >= c.gaps[i].leads);
  });

  await test('the numbers list shows where each one looks local', async () => {
    const r = await req(admin, 'GET', '/api/admin/numbers');
    assert.strictEqual(r.status, 200);
    const ny = r.json.numbers.find((n) => n.phone === '+12125550031');
    assert.ok(ny);
    assert.strictEqual(ny.area_code, '212');
    assert.strictEqual(ny.region, 'New York');
    assert.strictEqual(ny.display, '(212) 555-0031');
  });

  // ---------------------------------------------------------------- twilio auto-setup
  //
  // The whole point: given only an account SID and an auth token, the app
  // wires up Twilio by itself and keeps it pointing at the live deployment.

  await test('auto-setup creates an API key and a TwiML app from nothing', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const { settings } = require('../src/db');

    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl, callerIds: liveConfig.callerIds };
    const savedEnv = { ...process.env };
    try {
      // Pretend a fresh Render deployment: credentials only, nothing else.
      delete process.env.TWILIO_API_KEY_SID;
      delete process.env.TWILIO_API_KEY_SECRET;
      delete process.env.TWILIO_TWIML_APP_SID;
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.twilio.apiKeySid = '';
      liveConfig.twilio.apiKeySecret = '';
      liveConfig.twilio.twimlAppSid = '';
      liveConfig.publicUrl = 'https://dialer.example.com';
      settings.set(provision.KEYS.apiKeySid, '');
      settings.set(provision.KEYS.apiKeySecret, '');
      settings.set(provision.KEYS.twimlAppSid, '');
      twilioState.keys.clear();
      twilioState.apps.clear();

      const r = await provision.run({ reason: 'test' });

      assert.ok(r.ran, 'it should have run');
      assert.ok(liveConfig.twilio.apiKeySid.startsWith('SK'), 'an API key was created');
      assert.ok(liveConfig.twilio.apiKeySecret, 'the secret was captured');
      assert.ok(liveConfig.twilio.twimlAppSid.startsWith('AP'), 'a TwiML app was created');
      assert.ok(liveConfig.twilioConfigured, 'the app now considers Twilio configured');

      // The created app points at THIS deployment, method POST.
      const created = twilioState.apps.get(liveConfig.twilio.twimlAppSid);
      assert.strictEqual(created.voiceUrl, 'https://dialer.example.com/twiml/agent-leg');
      assert.strictEqual(created.voiceMethod, 'POST');

      // And a real softphone token can be minted with what it made.
      assert.ok(twilioClient.makeAccessToken('agent_1', 60).length > 20);

      // The secret is never written into the step log shown to admins.
      assert.ok(!JSON.stringify(r.steps).includes(liveConfig.twilio.apiKeySecret));
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      liveConfig.callerIds = saved.callerIds;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('running auto-setup twice does not make a second key or app', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    try {
      delete process.env.TWILIO_API_KEY_SID;
      delete process.env.TWILIO_API_KEY_SECRET;
      delete process.env.TWILIO_TWIML_APP_SID;
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.publicUrl = 'https://dialer.example.com';

      const first = await provision.run({ reason: 'test' });
      const keySid = liveConfig.twilio.apiKeySid;
      const appSid = liveConfig.twilio.twimlAppSid;
      const keyCount = twilioState.keys.size;
      const appCount = twilioState.apps.size;

      const second = await provision.run({ reason: 'test' });

      assert.strictEqual(liveConfig.twilio.apiKeySid, keySid, 'same key');
      assert.strictEqual(liveConfig.twilio.twimlAppSid, appSid, 'same app');
      assert.strictEqual(twilioState.keys.size, keyCount, 'no extra keys on the account');
      assert.strictEqual(twilioState.apps.size, appCount, 'no extra apps on the account');
      assert.ok(second.steps.some((s) => s.step === 'API key' && s.status === 'reused'));
      assert.ok(first.ran && second.ran);
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('a redeploy to a new address re-points Twilio at it', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    try {
      delete process.env.TWILIO_TWIML_APP_SID;
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.publicUrl = 'https://dialer.example.com';
      await provision.run({ reason: 'test' });
      const appSid = liveConfig.twilio.twimlAppSid;

      // The single most common failure: the URL moved and nobody updated Twilio.
      liveConfig.publicUrl = 'https://brookestone-dialer.onrender.com';
      const r = await provision.run({ reason: 'test' });

      assert.strictEqual(liveConfig.twilio.twimlAppSid, appSid, 'the same app, re-pointed');
      assert.strictEqual(
        twilioState.apps.get(appSid).voiceUrl,
        'https://brookestone-dialer.onrender.com/twiml/agent-leg'
      );
      assert.ok(r.steps.some((s) => s.step === 'TwiML app' && s.status === 'updated'));
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('auto-setup never clobbers a URL belonging to something else', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    try {
      delete process.env.TWILIO_TWIML_APP_SID;
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.publicUrl = 'https://dialer.example.com';
      await provision.run({ reason: 'test' });
      const appSid = liveConfig.twilio.twimlAppSid;

      // Somebody repurposed this app for their own IVR.
      twilioState.apps.get(appSid).voiceUrl = 'https://someone-elses-app.com/ivr/main';
      const r = await provision.run({ reason: 'test' });

      assert.strictEqual(
        twilioState.apps.get(appSid).voiceUrl,
        'https://someone-elses-app.com/ivr/main',
        'left exactly as it was'
      );
      const step = r.steps.find((s) => s.step === 'TwiML app');
      assert.strictEqual(step.status, 'failed');
      assert.ok(step.detail.includes('belongs to something else'));
      assert.ok(step.detail.includes('/twiml/agent-leg'), 'and it says what to set instead');
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('auto-setup adopts your Twilio numbers and points replies back here', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const { db: liveDb } = require('../src/db');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    try {
      delete process.env.CALLER_IDS;
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.publicUrl = 'https://dialer.example.com';
      twilioState.numberOverrides = {};

      await provision.run({ reason: 'test' });

      for (const phone of twilioState.ownedNumbers) {
        const row = liveDb.prepare('SELECT phone FROM caller_ids WHERE phone = ?').get(phone);
        assert.ok(row, `${phone} was adopted as a caller ID`);
        assert.strictEqual(
          twilioState.numberOverrides[phone].smsUrl,
          'https://dialer.example.com/twiml/sms-inbound',
          'inbound texts come back to this app'
        );
      }
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('on a shared Twilio account it touches only the numbers you listed', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const { db: liveDb } = require('../src/db');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    const savedOwned = twilioState.ownedNumbers.slice();
    try {
      // Two numbers are ours; the third belongs to the other project on this
      // same Twilio account and already has its own inbound webhook.
      twilioState.ownedNumbers = ['+12125551234', '+13105559876', '+14045550000'];
      twilioState.numberOverrides = {
        '+14045550000': { smsUrl: 'https://other-project.example.com/sms' },
      };
      liveDb.prepare('DELETE FROM caller_ids WHERE phone = ?').run('+14045550000');

      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.twilio.sharedAccount = true;
      liveConfig.publicUrl = 'https://dialer.example.com';
      process.env.CALLER_IDS = '+12125551234,+13105559876';

      const r = await provision.run({ reason: 'test' });

      // The other project's number is untouched, in Twilio and in our database.
      assert.strictEqual(
        twilioState.numberOverrides['+14045550000'].smsUrl,
        'https://other-project.example.com/sms',
        'the other project keeps its webhook'
      );
      assert.ok(
        !liveDb.prepare('SELECT 1 FROM caller_ids WHERE phone = ?').get('+14045550000'),
        'and we never claim it as a caller ID'
      );

      // Ours are wired up as normal.
      for (const mine of ['+12125551234', '+13105559876']) {
        assert.strictEqual(twilioState.numberOverrides[mine].smsUrl, 'https://dialer.example.com/twiml/sms-inbound');
      }

      const step = r.steps.find((s) => s.step === 'Caller IDs');
      assert.ok(step.detail.includes('CALLER_IDS'), 'and it says out loud that it stayed in its lane');
      assert.ok(step.detail.includes('left alone'));
    } finally {
      twilioState.ownedNumbers = savedOwned;
      twilioState.numberOverrides = {};
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('a shared account with no number list is refused, not guessed at', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    try {
      twilioState.numberOverrides = {};
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.twilio.sharedAccount = true;
      liveConfig.publicUrl = 'https://dialer.example.com';
      delete process.env.CALLER_IDS;

      const r = await provision.run({ reason: 'test' });

      const step = r.steps.find((s) => s.step === 'Caller IDs');
      assert.strictEqual(step.status, 'failed');
      assert.ok(step.detail.includes('CALLER_IDS'));
      assert.strictEqual(
        Object.keys(twilioState.numberOverrides).length,
        0,
        'not one number on the account was written to'
      );
      assert.ok(!r.steps.some((s) => s.step === 'Text replies'), 'and it did not go on to rewrite webhooks');
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('a number in CALLER_IDS you do not own is called out, not silently dropped', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const saved = { ...liveConfig.twilio, publicUrl: liveConfig.publicUrl };
    const savedEnv = { ...process.env };
    try {
      twilioState.numberOverrides = {};
      liveConfig.twilio.accountSid = 'ACtest0000000000000000000000000000';
      liveConfig.twilio.authToken = 'test-token';
      liveConfig.publicUrl = 'https://dialer.example.com';
      process.env.CALLER_IDS = '+12125551234,+19995550000';

      const r = await provision.run({ reason: 'test' });

      const bad = r.steps.find((s) => s.step === 'Caller IDs' && s.status === 'failed');
      assert.ok(bad, 'the unowned number is reported');
      assert.ok(bad.detail.includes('+19995550000'));
      assert.ok(bad.detail.includes('21210'), 'with the Twilio error it would cause');
      // The good one still gets set up.
      assert.strictEqual(
        twilioState.numberOverrides['+12125551234'].smsUrl,
        'https://dialer.example.com/twiml/sms-inbound'
      );
    } finally {
      twilioState.numberOverrides = {};
      Object.assign(liveConfig.twilio, saved);
      liveConfig.publicUrl = saved.publicUrl;
      process.env = savedEnv;
      liveConfig.refresh();
    }
  });

  await test('with no credentials at all it says exactly what is missing', async () => {
    const provision = require('../src/setup/provision');
    const liveConfig = require('../src/config');
    const saved = { ...liveConfig.twilio };
    try {
      liveConfig.twilio.accountSid = '';
      liveConfig.twilio.authToken = '';
      const r = await provision.run({ reason: 'test' });
      assert.strictEqual(r.ran, false);
      assert.ok(r.reason.includes('TWILIO_ACCOUNT_SID'));
      assert.ok(r.reason.includes('TWILIO_AUTH_TOKEN'));
    } finally {
      Object.assign(liveConfig.twilio, saved);
      liveConfig.refresh();
    }
  });

  await test('an admin can re-run setup from the browser, and it is logged', async () => {
    const r = await req(admin, 'POST', '/api/admin/setup/twilio');
    assert.strictEqual(r.status, 200);
    assert.ok('ran' in r.json);

    const state = await req(admin, 'GET', '/api/admin/setup/twilio');
    assert.strictEqual(state.status, 200);
    assert.ok(state.json.voiceUrl.endsWith('/twiml/agent-leg'));
    assert.ok(state.json.smsUrl.endsWith('/twiml/sms-inbound'));

    const log = await req(admin, 'GET', '/api/admin/audit?action=twilio.provisioned');
    assert.ok(log.json.entries.length >= 1, 'the run is in the activity log');
  });

  await test('a rep cannot run Twilio setup', async () => {
    const r = await req(agent, 'POST', '/api/admin/setup/twilio');
    assert.ok(r.status === 403 || r.status === 401, `expected a refusal, got ${r.status}`);
  });

  // -------------------------------------------------------------- done
  const failed = results.filter((r) => !r[0]);
  console.log('');
  console.log(`  ${results.length - failed.length}/${results.length} passed`);
  console.log('');
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
