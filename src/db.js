'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

const dbPath = path.resolve(process.cwd(), config.databasePath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent',        -- 'admin' | 'agent'
  active        INTEGER NOT NULL DEFAULT 1,
  max_lines     INTEGER NOT NULL DEFAULT 3,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  source_file  TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  archived     INTEGER NOT NULL DEFAULT 0,
  columns_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  row_index     INTEGER NOT NULL DEFAULT 0,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  company       TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone_raw     TEXT NOT NULL DEFAULT '',
  phone         TEXT,                                  -- E.164, NULL when invalid
  timezone      TEXT,
  extra_json    TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'new',           -- new|queued|calling|contacted|done|invalid|dnc
  disposition   TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_attempt  TEXT,
  next_attempt  TEXT,                                  -- ISO time; NULL = eligible now
  locked_by     INTEGER,                               -- agent user id holding this lead
  locked_at     TEXT,
  worked_by     INTEGER REFERENCES users(id),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_queue ON leads(list_id, status, locked_by, next_attempt);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

CREATE TABLE IF NOT EXISTS assignments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id  INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(list_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  list_id      INTEGER REFERENCES lists(id),
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT,
  lines        INTEGER NOT NULL DEFAULT 1,
  calls_placed INTEGER NOT NULL DEFAULT 0,
  connects     INTEGER NOT NULL DEFAULT 0,
  abandons     INTEGER NOT NULL DEFAULT 0,
  talk_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid      TEXT UNIQUE,
  session_id    INTEGER REFERENCES sessions_log(id),
  burst_id      TEXT NOT NULL DEFAULT '',
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id),
  from_number   TEXT NOT NULL DEFAULT '',
  to_number     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued',
  answered_by   TEXT NOT NULL DEFAULT '',              -- human|machine_*|fax|unknown
  outcome       TEXT NOT NULL DEFAULT '',              -- connected|abandoned|no_answer|busy|failed|machine|canceled
  disposition   TEXT NOT NULL DEFAULT '',
  recording_url TEXT NOT NULL DEFAULT '',
  duration      INTEGER NOT NULL DEFAULT 0,
  talk_seconds  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at   TEXT,
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);

CREATE TABLE IF NOT EXISTS dnc (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL DEFAULT '',
  added_by   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS caller_ids (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  friendly_name TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispositions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,
  label    TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'neutral',   -- good|neutral|bad|dnc|callback
  sort     INTEGER NOT NULL DEFAULT 0,
  hotkey   TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Text messaging
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sms_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = shared with everyone
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  shared      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tpl_owner ON sms_templates(owner_id, archived);

CREATE TABLE IF NOT EXISTS sms_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = applies to every agent
  template_id  INTEGER NOT NULL REFERENCES sms_templates(id) ON DELETE CASCADE,
  trigger      TEXT NOT NULL,          -- answered|no_answer|voicemail|abandoned|busy|disposition
  disposition  TEXT NOT NULL DEFAULT '',
  list_id      INTEGER REFERENCES lists(id) ON DELETE CASCADE,  -- NULL = any list
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  once_per_lead INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rules_trigger ON sms_rules(trigger, active);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_sid   TEXT UNIQUE,
  direction     TEXT NOT NULL DEFAULT 'outbound',   -- outbound|inbound
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id),
  call_id       INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  template_id   INTEGER REFERENCES sms_templates(id) ON DELETE SET NULL,
  rule_id       INTEGER REFERENCES sms_rules(id) ON DELETE SET NULL,
  batch_id      TEXT NOT NULL DEFAULT '',
  from_number   TEXT NOT NULL DEFAULT '',
  to_number     TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  segments      INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'queued',     -- queued|sending|sent|delivered|failed|undelivered|blocked|received
  error         TEXT NOT NULL DEFAULT '',
  send_after    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT,
  read_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_queue ON messages(status, send_after);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS sms_optouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL UNIQUE,
  keyword    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------

-- One row per thing that happened to a merchant. This is the timeline.
CREATE TABLE IF NOT EXISTS activities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  kind        TEXT NOT NULL,          -- call|sms_out|sms_in|note|stage|task|ai_note|field|system
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  call_id     INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_act_lead ON activities(lead_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_act_user ON activities(user_id, created_at DESC);

-- Callbacks and follow-ups.
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'callback',   -- callback|follow_up|docs|other
  title        TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  due_at       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',       -- open|done|missed|cancelled
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  reminded_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lead ON tasks(lead_id, status);

-- AI-written notes, one per dial that produced a conversation.
CREATE TABLE IF NOT EXISTS ai_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id        INTEGER REFERENCES calls(id) ON DELETE CASCADE,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|transcribing|writing|ready|failed|skipped
  summary        TEXT NOT NULL DEFAULT '',
  interest       TEXT NOT NULL DEFAULT '',         -- hot|warm|cold|dead|unclear
  next_step      TEXT NOT NULL DEFAULT '',
  objections     TEXT NOT NULL DEFAULT '[]',
  extracted_json TEXT NOT NULL DEFAULT '{}',
  coaching       TEXT NOT NULL DEFAULT '',
  transcript     TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',         -- transcript|typed_notes|metadata
  model          TEXT NOT NULL DEFAULT '',
  error          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ready_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_lead ON ai_notes(lead_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_status ON ai_notes(status);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose    TEXT NOT NULL,            -- reset|verify|invite
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id, purpose);

-- Who did what. Kept even when the account is deleted, so the trail survives.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, id DESC);

CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'sent',
  error      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Columns added after the first release - add them if the database predates it.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('caller_ids', 'sms_capable', 'INTEGER NOT NULL DEFAULT 1');
// Local caller ID matching: where each number sits, and how hard it is worked.
addColumnIfMissing('caller_ids', 'area_code', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('caller_ids', 'state', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('caller_ids', 'timezone', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('caller_ids', 'last_used_at', 'TEXT');
addColumnIfMissing('caller_ids', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('leads', 'preferred_caller_id', 'TEXT');
addColumnIfMissing('leads', 'sms_consent', "TEXT NOT NULL DEFAULT ''");

// --- CRM / merchant cash advance deal fields --------------------------------
addColumnIfMissing('leads', 'stage', "TEXT NOT NULL DEFAULT 'new'");
addColumnIfMissing('leads', 'owner_id', 'INTEGER REFERENCES users(id)');
addColumnIfMissing('leads', 'monthly_revenue', 'REAL');
addColumnIfMissing('leads', 'annual_revenue', 'REAL');
addColumnIfMissing('leads', 'time_in_business_months', 'INTEGER');
addColumnIfMissing('leads', 'requested_amount', 'REAL');
addColumnIfMissing('leads', 'approved_amount', 'REAL');
addColumnIfMissing('leads', 'funded_amount', 'REAL');
addColumnIfMissing('leads', 'factor_rate', 'REAL');
addColumnIfMissing('leads', 'industry', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('leads', 'entity_state', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('leads', 'open_positions', 'INTEGER');
addColumnIfMissing('leads', 'fico', 'INTEGER');
addColumnIfMissing('leads', 'use_of_funds', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('leads', 'nsf_count', 'INTEGER');
addColumnIfMissing('leads', 'avg_daily_balance', 'REAL');
addColumnIfMissing('leads', 'stage_changed_at', 'TEXT');
addColumnIfMissing('leads', 'last_contact_at', 'TEXT');
addColumnIfMissing('leads', 'lost_reason', "TEXT NOT NULL DEFAULT ''");

// --- accounts ---------------------------------------------------------------
addColumnIfMissing('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'pending_approval', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'last_login_at', 'TEXT');

// --- recordings / AI --------------------------------------------------------
addColumnIfMissing('calls', 'recording_sid', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('calls', 'caller_id_match', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('calls', 'notes', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('lists', 'record_calls', 'INTEGER');
addColumnIfMissing('lists', 'ai_notes', 'INTEGER');

db.exec('CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage, owner_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id, updated_at DESC)');

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

function seedDispositions() {
  const count = db.prepare('SELECT COUNT(*) c FROM dispositions').get().c;
  if (count > 0) return;
  const rows = [
    ['interested', 'Interested / Send info', 'good', 10, '1'],
    ['appointment', 'Appointment set', 'good', 20, '2'],
    ['application', 'Application started', 'good', 30, '3'],
    ['callback', 'Call back later', 'callback', 40, '4'],
    ['not_interested', 'Not interested', 'bad', 50, '5'],
    ['not_qualified', 'Not qualified', 'bad', 60, '6'],
    ['wrong_number', 'Wrong number', 'bad', 70, '7'],
    ['voicemail', 'Left voicemail', 'neutral', 80, '8'],
    ['no_answer', 'No answer', 'neutral', 90, '9'],
    ['dnc', 'DO NOT CALL - remove', 'dnc', 100, '0'],
  ];
  const ins = db.prepare('INSERT INTO dispositions (code,label,kind,sort,hotkey) VALUES (?,?,?,?,?)');
  const tx = db.transaction(() => rows.forEach((r) => ins.run(...r)));
  tx();
}

function seedTemplates() {
  const count = db.prepare('SELECT COUNT(*) c FROM sms_templates').get().c;
  if (count > 0) return;
  const rows = [
    [
      'Missed you - callback ask',
      'Hi {{first_name}}, this is {{agent_first_name}} with {{company_name}}. I just tried you about funding for {{business}}. When is a good time to talk? Reply STOP to opt out.',
    ],
    [
      'After a good call - send info',
      "{{first_name}}, great speaking with you. I'm {{agent_name}} at {{company_name}} - I'll send the details over shortly. Anything you want me to include, just reply here. Reply STOP to opt out.",
    ],
    [
      'Voicemail follow-up',
      'Hi {{first_name}}, {{agent_first_name}} from {{company_name}}. Left you a voicemail about your financing options. Text me back here if that is easier. Reply STOP to opt out.',
    ],
    [
      'Appointment confirmation',
      "{{first_name}} - confirming our call. I'll ring you at this number. This is {{agent_name}} at {{company_name}}. Reply STOP to opt out.",
    ],
  ];
  const ins = db.prepare('INSERT INTO sms_templates (owner_id, name, body, shared) VALUES (NULL,?,?,1)');
  const tx = db.transaction(() => rows.forEach((r) => ins.run(r[0], r[1])));
  tx();
}

function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(config.admin.email);
  if (existing) return;
  const anyAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  const hash = bcrypt.hashSync(config.admin.password, 10);
  db.prepare(
    "INSERT INTO users (email, name, password_hash, role, max_lines) VALUES (?,?,?,'admin',?)"
  ).run(config.admin.email, 'Administrator', hash, config.maxLinesPerAgent);
  if (!anyAdmin) {
    console.log(`[db] Created admin account: ${config.admin.email}`);
  }
}

function seedCallerIds() {
  const ins = db.prepare('INSERT OR IGNORE INTO caller_ids (phone, friendly_name) VALUES (?, ?)');
  for (const p of config.callerIds) ins.run(p, 'From .env');
}

seedDispositions();
seedTemplates();
seedAdmin();
seedCallerIds();

// ---------------------------------------------------------------------------
// Small helpers used across the app
// ---------------------------------------------------------------------------

const settings = {
  get(key, dflt = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : dflt;
  },
  set(key, value) {
    db.prepare(
      'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  },
  getBool(key, dflt = false) {
    const v = this.get(key, null);
    if (v === null) return dflt;
    return v === 'true' || v === '1';
  },
  getInt(key, dflt = 0) {
    const v = parseInt(this.get(key, ''), 10);
    return Number.isFinite(v) ? v : dflt;
  },
};

function nowIso() {
  return new Date().toISOString();
}

module.exports = { db, settings, nowIso, dbPath };
