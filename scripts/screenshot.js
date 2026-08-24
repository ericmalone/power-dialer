'use strict';

/**
 * Dev helper: boots the app against a throwaway database, seeds demo data,
 * and saves screenshots of each screen. Not needed in production.
 *
 *   node scripts/screenshot.js
 */

const fs = require('fs');
const path = require('path');

process.env.DATABASE_PATH = './data/demo.db';
process.env.PUBLIC_URL = 'http://127.0.0.1:3222';
process.env.PORT = '3222';
process.env.ADMIN_EMAIL = 'eric@brookestonefunding.com';
process.env.ADMIN_PASSWORD = 'DemoPassword123';
process.env.SESSION_SECRET = 'demo-secret-demo-secret-demo-secret';
process.env.CALLER_IDS = '+12125551234,+13105559876,+16175550022';
process.env.MAX_LINES_PER_AGENT = '5';
process.env.SKIP_TWILIO_SIGNATURE = 'true';
process.env.TWILIO_ACCOUNT_SID = 'ACdemo0000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'demotoken00000000000000000000000';
process.env.TWILIO_API_KEY_SID = 'SKdemo0000000000000000000000000000';
process.env.TWILIO_API_KEY_SECRET = 'demosecret0000000000000000000000';
process.env.TWILIO_TWIML_APP_SID = 'APdemo0000000000000000000000000000';
process.env.COMPANY_NAME = 'Brookestone Funding';
process.env.SMS_QUIET_HOURS = 'false';
process.env.SIGNUP_ALLOWED_DOMAINS = 'brookestonefunding.com';
process.env.EMAIL_PROVIDER = 'console';
process.env.EMAIL_FROM = 'dialer@brookestonefunding.com';
process.env.AI_MIN_TALK_SECONDS = '5';
process.env.REPORT_TIMEZONE = 'America/New_York';

for (const f of ['demo.db', 'demo.db-wal', 'demo.db-shm']) {
  const p = path.resolve(process.cwd(), 'data', f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const twilioClient = require('../src/twilioClient');
let n = 0;
const placed = [];
twilioClient.setClient({
  calls: Object.assign((sid) => ({ update: async () => ({}) }), {
    create: async (p) => {
      const sid = `CA${String(++n).padStart(32, '0')}`;
      placed.push({ sid, ...p });
      return { sid, ...p };
    },
  }),
  messages: { create: async (p) => ({ sid: `SM${String(++n).padStart(32, '0')}`, ...p }) },
  incomingPhoneNumbers: {
    list: async () =>
      ['+12125551234', '+13105559876', '+16175550022'].map((phoneNumber) => ({
        phoneNumber,
        friendlyName: phoneNumber,
        capabilities: { voice: true, sms: true },
      })),
  },
  api: { v2010: { accounts: () => ({ fetch: async () => ({ friendlyName: 'Brookestone Funding', status: 'active', type: 'Full' }) }) } },
  balance: { fetch: async () => ({ balance: '312.40', currency: 'USD' }) },
  keys: () => ({ fetch: async () => ({ friendlyName: 'power-dialer' }) }),
  applications: () => ({
    fetch: async () => ({
      friendlyName: 'Power Dialer',
      voiceUrl: 'http://127.0.0.1:3222/twiml/agent-leg',
      voiceMethod: 'POST',
    }),
  }),
  messaging: { v1: { services: () => ({ fetch: async () => ({ friendlyName: 'Brookestone Messaging' }) }) } },
  intelligence: { v2: { services: () => ({ fetch: async () => ({ friendlyName: 'Brookestone Intelligence' }) }) } },
});

const { server } = require('../src/server');
const { db } = require('../src/db');
const auth = require('../src/auth');
const engine = require('../src/dialer/engine');
const sheet = require('../src/util/spreadsheet');

// ---------------------------------------------------------------- seed
const agent = auth.createUser({
  email: 'dana@brookestonefunding.com',
  name: 'Dana Rivera',
  password: 'DemoPassword123',
  maxLines: 5,
});
auth.createUser({ email: 'marcus@brookestonefunding.com', name: 'Marcus Hale', password: 'DemoPassword123', maxLines: 4 });

const csv = fs.readFileSync(path.resolve(process.cwd(), 'sample_leads.csv'));
const { headers, rows } = sheet.parseBuffer(csv);
const mapping = sheet.guessMapping(headers);
mapping.fullName = 'Owner';
const leads = sheet.toLeads(rows, mapping);

const listId = db
  .prepare('INSERT INTO lists (name, source_file, created_by, columns_json) VALUES (?,?,?,?)')
  .run('August MCA Leads', 'sample_leads.csv', 1, JSON.stringify(headers)).lastInsertRowid;

const ins = db.prepare(
  'INSERT INTO leads (list_id,row_index,first_name,last_name,company,email,phone_raw,phone,timezone,extra_json,status,' +
    'monthly_revenue,time_in_business_months,requested_amount,open_positions,fico,industry,stage,owner_id) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
const demoDeals = [
  { rev: 92000, tib: 51, ask: 150000, pos: 1, fico: 672, ind: 'Bakery', stage: 'docs_in' },
  { rev: 310000, tib: 96, ask: 250000, pos: 0, fico: 710, ind: 'Logistics', stage: 'underwriting' },
  { rev: 58000, tib: 33, ask: 60000, pos: 2, fico: 618, ind: 'Dental', stage: 'app_out' },
  { rev: 147000, tib: 62, ask: 120000, pos: 1, fico: 645, ind: 'Auto body', stage: 'qualified' },
  { rev: 41000, tib: 19, ask: 35000, pos: 3, fico: 574, ind: 'Salon', stage: 'contacted' },
  { rev: 36000, tib: 8, ask: 25000, pos: 0, fico: 601, ind: 'Cafe', stage: 'contacted' },
  { rev: 74000, tib: 44, ask: 80000, pos: 1, fico: 663, ind: 'Fitness', stage: 'new' },
  { rev: 118000, tib: 71, ask: 100000, pos: 2, fico: 689, ind: 'Printing', stage: 'funded' },
];
leads.forEach((l, i) => {
  const d = demoDeals[i] || {};
  ins.run(
    listId, l.rowIndex, l.firstName, l.lastName, l.company, l.email, l.phoneRaw, l.phone,
    l.timezone, JSON.stringify(l.extra), l.phone ? 'new' : 'invalid',
    d.rev ?? null, d.tib ?? null, d.ask ?? null, d.pos ?? null, d.fico ?? null,
    d.ind || '', d.stage || 'new', l.phone ? agent.id : null
  );
});
db.prepare('INSERT INTO assignments (list_id,user_id) VALUES (?,?)').run(listId, agent.id);

// A little history so the dashboard is not empty.
const hist = db.prepare(
  "INSERT INTO calls (call_sid,user_id,lead_id,from_number,to_number,status,outcome,disposition,talk_seconds,answered_by) VALUES (?,?,?,?,?,'completed',?,?,?,'human')"
);
const someLeads = db.prepare('SELECT id, phone FROM leads WHERE phone IS NOT NULL').all();
const outcomes = [
  ['connected', 'interested', 214], ['connected', 'not_interested', 47], ['no_answer', '', 0],
  ['connected', 'appointment', 388], ['machine', '', 0], ['no_answer', '', 0],
  ['connected', 'callback', 96], ['abandoned', '', 0], ['connected', 'not_qualified', 63],
  ['no_answer', '', 0], ['connected', 'application', 502], ['busy', '', 0],
];
outcomes.forEach((o, i) => {
  const l = someLeads[i % someLeads.length];
  hist.run(`CAhist${String(i).padStart(27, '0')}`, agent.id, l.id, '+12125551234', l.phone, o[0], o[1], o[2]);
});

// A wider spread of merchants so the coverage panel has something to say.
const spreadLeads = [
  ['Sunrise Diner', 'Ana Reyes', '+12123334401'],
  ['Metro Tire', 'Devon Clark', '+19173334402'],
  ['Lakeside Florist', 'Erin Moss', '+13123334403'],
  ['Windy City Auto', 'Hal Berg', '+13123334404'],
  ['Pacific Prints', 'Ivy Tran', '+14153334405'],
  ['Sunset Grill', 'Jon Reed', '+12133334406'],
  ['Bay Cleaners', 'Kim Lau', '+15103334407'],
  ['Peachtree Nails', 'Lena Ford', '+14043334408'],
  ['Music Row Cafe', 'Miles Day', '+16153334409'],
  ['Alamo Hardware', 'Nina Cruz', '+12103334410'],
];
const spreadIns = db.prepare(
  "INSERT INTO leads (list_id,row_index,first_name,last_name,company,phone_raw,phone,timezone,status,stage,owner_id,monthly_revenue,requested_amount) " +
    "VALUES (?,?,?,?,?,?,?,?,'new','new',?,?,?)"
);
spreadLeads.forEach((l, i) => {
  const [company, owner, ph] = l;
  const [first, last] = owner.split(' ');
  spreadIns.run(listId, 100 + i, first, last, company, ph, ph, require('../src/util/phone').timezoneFor(ph),
    agent.id, 40000 + i * 9000, 30000 + i * 7000);
});

// Two weeks of dialing history so the reports have something to draw.
const histCall = db.prepare(
  "INSERT INTO calls (call_sid,user_id,lead_id,to_number,status,outcome,disposition,talk_seconds,created_at) " +
    "VALUES (?,?,?,?,'completed',?,?,?,datetime('now', ?, ?))"
);
const histSession = db.prepare(
  "INSERT INTO sessions_log (user_id,list_id,started_at,ended_at,lines) " +
    "VALUES (?,?,datetime('now',?,'-8 hours'),datetime('now',?,'-2 hours'),3)"
);
const dayShape = [
  { dials: 92, connects: 21, avg: 190 },
  { dials: 118, connects: 27, avg: 165 },
  { dials: 76, connects: 14, avg: 210 },
  { dials: 134, connects: 31, avg: 178 },
  { dials: 101, connects: 24, avg: 155 },
  { dials: 41, connects: 9, avg: 240 },
  { dials: 87, connects: 19, avg: 172 },
  { dials: 126, connects: 29, avg: 168 },
  { dials: 95, connects: 22, avg: 195 },
  { dials: 110, connects: 26, avg: 182 },
  { dials: 68, connects: 12, avg: 205 },
  { dials: 129, connects: 33, avg: 161 },
  { dials: 104, connects: 25, avg: 176 },
  { dials: 58, connects: 13, avg: 188 },
];
const dispPool = ['interested', 'appointment', 'application', 'callback', 'not_interested', 'not_qualified', 'voicemail'];
const missPool = ['no_answer', 'no_answer', 'no_answer', 'machine', 'busy', 'abandoned'];
let seed = 7;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const leadPool = db.prepare('SELECT id, phone FROM leads WHERE phone IS NOT NULL').all();
let cid = 0;
dayShape.forEach((d, idx) => {
  const daysAgo = dayShape.length - 1 - idx;
  const worker = idx % 3 === 0 ? 1 : agent.id; // mostly Dana, occasionally the admin
  for (let i = 0; i < d.dials; i++) {
    const connected = i < d.connects;
    const l = leadPool[rand(leadPool.length)];
    const hour = 9 + rand(9);
    const talk = connected ? Math.max(20, d.avg + rand(240) - 110) : 0;
    histCall.run(
      `CAseed${cid++}`,
      worker,
      l.id,
      l.phone,
      connected ? 'connected' : missPool[rand(missPool.length)],
      connected ? dispPool[rand(dispPool.length)] : '',
      talk,
      `-${daysAgo} days`,
      `-${23 - hour} hours`
    );
  }
  histSession.run(agent.id, listId, `-${daysAgo} days`, `-${daysAgo} days`);
});

// A little admin history so the activity log has something in it.
const audit = require('../src/audit');
const fakeReq = (user) => ({ user, headers: {}, ip: '73.118.204.12' });
const boss = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
const marcus = db.prepare("SELECT * FROM users WHERE email LIKE 'marcus%'").get();
audit.log(fakeReq(boss), 'auth.login');
audit.log(fakeReq(boss), 'user.invited', { target: 'dana@brookestonefunding.com', detail: 'role agent' });
audit.log(fakeReq(boss), 'list.imported', { target: 'August MCA Leads', detail: '8 imported, 0 duplicates' });
audit.log(fakeReq(agent), 'auth.login');
audit.log(fakeReq(boss), 'dnc.added', { detail: '412 number(s) added, 3 unreadable' });
audit.log(fakeReq(marcus || agent), 'auth.login');
audit.log(fakeReq(boss), 'settings.changed', { detail: 'auto_throttle, leaderboard_visible' });
audit.log(fakeReq(agent), 'report.exported', { detail: 'last 7 days, 812 call rows' });
audit.log(fakeReq(boss), 'user.role_changed', { target: 'marcus@brookestonefunding.com', detail: 'role agent -> admin' });
audit.log(fakeReq(boss), 'list.recording_changed', { target: 'August MCA Leads', detail: 'record' });

// A worked merchant record: timeline, an AI note, a booked callback.
const crm = require('../src/crm');
const crmTasks = require('../src/crm/tasks');
const acme = db.prepare("SELECT * FROM leads WHERE company = 'Acme Bakery'").get();
if (acme) {
  const callId = db.prepare("SELECT id FROM calls WHERE lead_id = ? ORDER BY id LIMIT 1").get(acme.id).id;
  crm.logActivity({ leadId: acme.id, userId: agent.id, kind: 'call', title: 'Spoke for 4 min', callId });
  crm.logActivity({
    leadId: acme.id, userId: agent.id, kind: 'sms_out',
    title: 'Text sent', body: 'Maria, great speaking with you. Sending the one-page app over now.',
  });
  db.prepare(
    "INSERT INTO ai_notes (call_id,lead_id,user_id,status,summary,interest,next_step,objections,extracted_json,coaching,source,model,ready_at) " +
      "VALUES (?,?,?,'ready',?,?,?,?,?,?,'transcript','claude-sonnet-4-5',datetime('now'))"
  ).run(
    callId, acme.id, agent.id,
    'Maria at Acme Bakery does about $92k a month and has been open just over four years. She has one advance out with a balance around $18k and wants $150k to buy out a competitor two blocks over. She will send three months of statements tonight.',
    'hot',
    'Get the three months of statements she promised, then submit to underwriting',
    JSON.stringify(['Wants to know the payback before sending statements', 'Nervous about a daily debit']),
    JSON.stringify({ monthly_revenue: 92000, requested_amount: 150000, open_positions: 1, use_of_funds: 'Buy out a competing location', risk_flags: ['Existing position with a $18k balance'] }),
    'You pinned down the amount and the use of funds early, which is exactly right. Next time ask for the statements before you talk terms.'
  );
  crm.logActivity({
    leadId: acme.id, userId: agent.id, kind: 'ai_note', title: 'AI note - hot', callId,
    body: 'Maria at Acme Bakery does about $92k a month and has been open just over four years. She wants $150k to buy out a competitor.',
  });
  crm.logActivity({ leadId: acme.id, userId: agent.id, kind: 'stage', title: 'Qualified → Application out' });
  crmTasks.create({ leadId: acme.id, userId: agent.id, kind: 'callback', minutesFromNow: 1, note: 'Chase the three months of statements' });
  const bolt = db.prepare("SELECT id FROM leads WHERE company = 'Bolt Logistics'").get();
  if (bolt) crmTasks.create({ leadId: bolt.id, userId: agent.id, kind: 'docs', minutesFromNow: 180, note: 'Funder asked for a voided check' });
}

// ---------------------------------------------------------------- shoot
(async () => {
  await new Promise((r) => server.listen(3222, '127.0.0.1', r));
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const out = path.resolve(process.cwd(), 'docs');
  fs.mkdirSync(out, { recursive: true });

  const base = 'http://127.0.0.1:3222';

  // Agent, idle
  await page.goto(`${base}/login`);
  await page.fill('#email', 'dana@brookestonefunding.com');
  await page.fill('#password', 'DemoPassword123');
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, 'agent-idle.png'), fullPage: false });

  // Agent, mid-call
  await page.evaluate(() => {
    document.querySelector('#dispCard').style.display = 'block';
  });
  engine.agentOnline(agent.id, 'CAagentdemo');
  engine.start(agent.id, { listId, lines: 3 });
  await page.waitForTimeout(1600);
  const first = placed[0];
  if (first) {
    const u = new URL(first.url);
    await fetch(`${base}/twiml/lead-answer?${u.searchParams.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: first.sid, AnsweredBy: 'human' }).toString(),
    });
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'agent-live-call.png') });

  // Texting modal
  await page.click('#btnTexts');
  await page.waitForTimeout(900);
  await page.fill(
    '#smsBodyText',
    'Hi {{first_name}}, this is {{agent_first_name}} with {{company_name}}. I just tried you about funding for {{business}} - when is a good time to talk?'
  );
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'agent-texting.png') });

  await page.click('#smsTabs button[data-t="rules"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, 'agent-auto-texts.png') });
  await page.click('#smsClose');

  // Admin
  await page.goto(`${base}/login`);
  await page.evaluate(() => fetch('/logout', { method: 'POST' }));
  await page.goto(`${base}/login`);
  await page.fill('#email', 'eric@brookestonefunding.com');
  await page.fill('#password', 'DemoPassword123');
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/admin`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, 'admin-dashboard.png') });

  await page.click('#tabs button[data-tab="lists"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, 'admin-lists.png') });

  await page.click('#tabs button[data-tab="texting"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, 'admin-texting.png') });

  await page.click('#tabs button[data-tab="numbers"]');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(out, 'admin-numbers.png') });

  await page.click('#tabs button[data-tab="people"]');
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(out, 'admin-people.png') });

  await page.click('#tabs button[data-tab="system"]');
  await page.waitForTimeout(600);
  await page.click('#btnHealth');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(out, 'admin-system-check.png') });

  await page.click('#tabs button[data-tab="activity"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, 'admin-activity.png') });

  // CRM, as the rep
  await page.evaluate(() => fetch('/logout', { method: 'POST' }));
  await page.goto(`${base}/login`);
  await page.fill('#email', 'dana@brookestonefunding.com');
  await page.fill('#password', 'DemoPassword123');
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/`);
  await page.goto(`${base}/crm`);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(out, 'crm-my-day.png') });

  await page.click('#tabs button[data-tab="merchants"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, 'crm-merchants.png') });

  await page.fill('#q', 'Acme');
  await page.waitForTimeout(900);
  const row = await page.$('.lead-row');
  if (row) {
    await row.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, 'crm-merchant-record.png') });
    await page.evaluate(() => {
      const el = document.querySelector('.drawer');
      if (el) el.scrollTop = 620;
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, 'crm-ai-note.png') });
  }

  await page.goto(`${base}/crm`);
  await page.waitForTimeout(800);
  await page.click('#tabs button[data-tab="pipeline"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, 'crm-pipeline.png') });

  // Reports
  await page.goto(`${base}/reports`);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(out, 'reports.png') });
  await page.evaluate(() => window.scrollTo(0, 760));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'reports-charts.png') });

  // Signup page
  await page.evaluate(() => fetch('/logout', { method: 'POST' }));
  await page.goto(`${base}/signup`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, 'signup.png') });

  await browser.close();
  server.close();
  console.log('Screenshots written to docs/');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
