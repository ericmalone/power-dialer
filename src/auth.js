'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');
const mailer = require('./email/mailer');

function findByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function verify(email, password) {
  const user = findByEmail(email);
  if (!user || !user.active) return null;
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
  return user;
}

/** Same as verify(), but tells you *why* it failed so we can say something useful. */
function attemptLogin(email, password) {
  const user = findByEmail(email);
  if (!user) return { ok: false, reason: 'bad_credentials' };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return { ok: false, reason: 'bad_credentials' };
  if (user.pending_approval) return { ok: false, reason: 'pending_approval' };
  if (!user.active) return { ok: false, reason: 'disabled' };
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return { ok: true, user };
}

function createUser({ email, name, password, role = 'agent', maxLines = 3 }) {
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (email,name,password_hash,role,max_lines) VALUES (?,?,?,?,?)')
    .run(String(email).toLowerCase().trim(), name || '', hash, role, maxLines);
  return findById(info.lastInsertRowid);
}

function setPassword(userId, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: !!u.active,
    pendingApproval: !!u.pending_approval,
    emailVerified: !!u.email_verified,
    maxLines: u.max_lines,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** Minimum bar: 10 characters and not something a script would guess first. */
const WEAK = new Set([
  'password12', 'password123', 'letmein123', 'qwerty1234', 'welcome123',
  'changeme123', '1234567890', 'iloveyou12', 'admin12345', 'dialer1234',
]);

function checkPassword(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Password must be at least 10 characters.';
  if (WEAK.has(s.toLowerCase())) return 'That password is too easy to guess. Pick another.';
  if (/^(.)\1+$/.test(s)) return 'That password is too simple.';
  return null;
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

function emailDomain(email) {
  return String(email || '').toLowerCase().split('@')[1] || '';
}

/** Is this address allowed to create its own account? */
function signupAllowed(email) {
  if (!config.signup.enabled) return { ok: false, reason: 'Self sign-up is switched off. Ask your administrator for an account.' };
  const addr = String(email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return { ok: false, reason: 'That does not look like an email address.' };
  const domains = config.signup.allowedDomains;
  if (domains.length && !domains.includes(emailDomain(addr))) {
    return {
      ok: false,
      reason: `Sign-up is limited to ${domains.map((d) => `@${d}`).join(' or ')} addresses.`,
    };
  }
  return { ok: true };
}

function signup({ email, name, password }) {
  const addr = String(email || '').toLowerCase().trim();
  const gate = signupAllowed(addr);
  if (!gate.ok) throw new Error(gate.reason);

  const pwError = checkPassword(password);
  if (pwError) throw new Error(pwError);

  if (findByEmail(addr)) throw new Error('There is already an account with that email. Try signing in, or reset your password.');

  const firstUser = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const pending = config.signup.requireApproval && !firstUser ? 1 : 0;

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      'INSERT INTO users (email,name,password_hash,role,max_lines,pending_approval,email_verified,active) VALUES (?,?,?,?,?,?,1,1)'
    )
    .run(
      addr,
      String(name || '').trim(),
      hash,
      firstUser ? 'admin' : 'agent',
      config.signup.defaultMaxLines,
      pending
    );

  const user = findById(info.lastInsertRowid);

  if (pending) {
    const admins = db.prepare("SELECT email FROM users WHERE role='admin' AND active=1").all();
    for (const a of admins) {
      mailer.sendApprovalNeeded({ to: a.email, who: `${user.name || user.email} (${user.email})` }).catch(() => {});
    }
  } else {
    mailer.sendWelcome({ to: user.email, name: user.name, url: `${config.publicUrl}/login` }).catch(() => {});
  }

  return { user, pending: Boolean(pending) };
}

// ---------------------------------------------------------------------------
// Reset / invite tokens
// ---------------------------------------------------------------------------

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function issueToken(userId, purpose, minutes) {
  // One live token per purpose - issuing a new one kills the old.
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE user_id = ? AND purpose = ? AND used_at IS NULL").run(
    userId,
    purpose
  );
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare('INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at) VALUES (?,?,?,?)').run(
    userId,
    hashToken(token),
    purpose,
    expires
  );
  return { token, expires };
}

function readToken(token, purpose) {
  if (!token) return { ok: false, reason: 'That link is not valid.' };
  const row = db
    .prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ?')
    .get(hashToken(token), purpose);
  if (!row) return { ok: false, reason: 'That link is not valid.' };
  if (row.used_at) return { ok: false, reason: 'That link has already been used. Request a new one.' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'That link has expired. Request a new one.' };
  const user = findById(row.user_id);
  if (!user) return { ok: false, reason: 'That account no longer exists.' };
  return { ok: true, row, user };
}

function consumeToken(rowId) {
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?").run(rowId);
}

/**
 * Always behaves the same way from the outside, whether or not the address is
 * one of ours - otherwise this endpoint tells strangers who works here.
 */
async function requestPasswordReset(email) {
  const user = findByEmail(email);
  if (!user || !user.active) return { ok: true, sent: false };

  const minutes = config.email.resetTtlMinutes;
  const { token } = issueToken(user.id, 'reset', minutes);
  const url = `${config.publicUrl}/reset?token=${encodeURIComponent(token)}`;
  await mailer.sendPasswordReset({ to: user.email, name: user.name, url, minutes });
  return { ok: true, sent: true, url };
}

function completePasswordReset(token, newPassword) {
  const check = readToken(token, 'reset');
  if (!check.ok) throw new Error(check.reason);
  const pwError = checkPassword(newPassword);
  if (pwError) throw new Error(pwError);

  setPassword(check.user.id, newPassword);
  consumeToken(check.row.id);
  db.prepare("UPDATE users SET email_verified = 1, active = 1 WHERE id = ?").run(check.user.id);
  return check.user;
}

/** Admin creates the account; the person picks their own password from the email. */
async function inviteUser({ email, name, role = 'agent', maxLines = 3, invitedBy = 'Your administrator' }) {
  const addr = String(email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new Error('That does not look like an email address.');
  if (findByEmail(addr)) throw new Error('Someone already uses that email.');

  const placeholder = crypto.randomBytes(24).toString('base64url');
  const user = createUser({ email: addr, name, password: placeholder, role, maxLines });

  const minutes = Math.max(config.email.resetTtlMinutes, 60 * 24);
  const { token } = issueToken(user.id, 'reset', minutes);
  const url = `${config.publicUrl}/reset?token=${encodeURIComponent(token)}`;
  const result = await mailer.sendInvite({ to: addr, url, invitedBy, minutes });
  return { user, emailed: result.ok, url };
}

// --- Express middleware -----------------------------------------------------

function attachUser(req, _res, next) {
  req.user = req.session && req.session.userId ? findById(req.session.userId) : null;
  if (req.user && (!req.user.active || req.user.pending_approval)) req.user = null;
  next();
}

function wantsJson(req) {
  return req.xhr || (req.get('accept') || '').includes('application/json') || req.path.startsWith('/api/');
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Not signed in.' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (wantsJson(req)) return res.status(403).json({ error: 'Administrator access required.' });
  return res.status(403).send('Administrator access required.');
}

module.exports = {
  findByEmail,
  findById,
  verify,
  attemptLogin,
  createUser,
  setPassword,
  publicUser,
  attachUser,
  requireLogin,
  requireAdmin,
  checkPassword,
  signupAllowed,
  signup,
  issueToken,
  readToken,
  consumeToken,
  requestPasswordReset,
  completePasswordReset,
  inviteUser,
};
