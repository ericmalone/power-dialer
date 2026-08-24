'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const realtime = require('./realtime');
const audit = require('./audit');
const engine = require('./dialer/engine');

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://sdk.twilio.com', 'https://media.twiliocdn.com'],
        connectSrc: ["'self'", 'wss:', 'https:', 'ws:'],
        mediaSrc: ["'self'", 'https:', 'data:', 'blob:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.resolve(process.cwd(), 'data') }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);
app.use(auth.attachUser);

// ---------------------------------------------------------------------------
// Twilio webhooks + TwiML (no session needed, signature-verified instead)
// ---------------------------------------------------------------------------
const { router: twimlRouter } = require('./routes/twiml');
app.use('/twiml', twimlRouter);
app.use('/webhooks', require('./routes/webhooks'));

// ---------------------------------------------------------------------------
// Auth pages
// ---------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait a few minutes and try again.' },
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post('/login', loginLimiter, (req, res) => {
  const result = auth.attemptLogin(req.body.email, req.body.password);
  if (!result.ok) {
    audit.log(req, 'auth.login_failed', {
      actorEmail: String(req.body.email || '').toLowerCase().slice(0, 120),
      detail: result.reason,
    });
    const messages = {
      bad_credentials: 'That email and password do not match.',
      pending_approval: 'Your account is waiting for an administrator to approve it.',
      disabled: 'That account has been switched off. Ask your administrator.',
    };
    return res.status(401).json({ error: messages[result.reason] || messages.bad_credentials });
  }
  req.session.userId = result.user.id;
  req.session.role = result.user.role;
  audit.log(req, 'auth.login', { actor: result.user });
  res.json({ ok: true, redirect: result.user.role === 'admin' ? '/admin' : '/' });
});

// --- self sign-up -----------------------------------------------------------

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-up attempts from this network. Try again in an hour.' },
});

app.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'signup.html'));
});

app.get('/signup-policy', (_req, res) => {
  res.json({
    enabled: config.signup.enabled,
    domains: config.signup.allowedDomains,
    requireApproval: config.signup.requireApproval,
    emailWorks: require('./email/mailer').configured(),
  });
});

app.post('/signup', signupLimiter, (req, res) => {
  try {
    const { user, pending } = auth.signup({
      email: req.body.email,
      name: req.body.name,
      password: req.body.password,
    });
    if (pending) {
      return res.json({
        ok: true,
        pending: true,
        message: 'Account created. An administrator has to approve it before you can sign in.',
      });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    audit.log(req, 'auth.signup', { actor: user, detail: `role ${user.role}` });
    res.json({ ok: true, redirect: user.role === 'admin' ? '/admin' : '/' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- forgot / reset password ------------------------------------------------

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Try again in an hour.' },
});

app.get('/forgot', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'forgot.html'));
});

app.post('/forgot', resetLimiter, async (req, res) => {
  try {
    await auth.requestPasswordReset(req.body.email);
    audit.log(req, 'auth.reset_requested', {
      actorEmail: String(req.body.email || '').toLowerCase().slice(0, 120),
    });
  } catch (err) {
    console.error('[reset]', err);
  }
  // Always the same answer, so this cannot be used to find out who works here.
  res.json({
    ok: true,
    message: 'If that email belongs to an account, a reset link is on its way. Check your inbox and your spam folder.',
  });
});

app.get('/reset', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'reset.html'));
});

app.get('/reset/check', (req, res) => {
  const check = auth.readToken(req.query.token, 'reset');
  if (!check.ok) return res.status(400).json({ error: check.reason });
  res.json({ ok: true, email: check.user.email, name: check.user.name });
});

app.post('/reset', resetLimiter, (req, res) => {
  try {
    const user = auth.completePasswordReset(req.body.token, req.body.password);
    audit.log(req, 'auth.password_reset', { actor: user });
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ ok: true, redirect: user.role === 'admin' ? '/admin' : '/' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/logout', (req, res) => {
  const uid = req.session.userId;
  if (req.user) audit.log(req, 'auth.logout');
  if (uid) {
    try {
      engine.agentOffline(uid);
    } catch {
      /* ignore */
    }
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/change-password', auth.requireLogin, (req, res) => {
  const { current, next } = req.body;
  if (!auth.verify(req.user.email, current)) return res.status(400).json({ error: 'Your current password is wrong.' });
  const problem = auth.checkPassword(next);
  if (problem) return res.status(400).json({ error: problem });
  auth.setPassword(req.user.id, next);
  audit.log(req, 'auth.password_changed');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------
app.use('/api/admin', require('./routes/admin'));
app.use('/api/crm', require('./routes/crm'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api', require('./routes/api'));

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/', auth.requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'agent.html'));
});
app.get('/crm', auth.requireLogin, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'crm.html'));
});
app.get('/reports', auth.requireLogin, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'reports.html'));
});
app.get('/admin', auth.requireLogin, auth.requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1h' : 0 }));

app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).send('Not found.');
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Server error.' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = http.createServer(app);
realtime.init(server, sessionMiddleware);

// Anything a previous auto-setup run created (API key, TwiML app) belongs in
// the live config before the first agent asks for a softphone token.
const provision = require('./setup/provision');
provision.loadStored();

engine.reclaimStaleLocks();
setInterval(() => engine.reclaimStaleLocks(), 5 * 60 * 1000).unref();

// Flush the text queue: picks up delayed sends and anything held for quiet hours.
const messenger = require('./sms/messenger');
setInterval(() => messenger.tick(), 15 * 1000).unref();

// Write AI notes for finished calls, and nudge reps about due callbacks.
const aiNotes = require('./ai/notes');
const crmTasks = require('./crm/tasks');
setInterval(() => aiNotes.tick().catch((e) => console.error('[ai]', e)), 20 * 1000).unref();
setInterval(() => {
  try {
    crmTasks.sweepReminders();
  } catch (e) {
    console.error('[tasks]', e);
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(config.port, () => {
    console.log('');
    console.log('  Power Dialer is running');
    console.log(`  Local:  http://localhost:${config.port}`);
    console.log(`  Public: ${config.publicUrl}`);
    console.log('');
    const w = config.warnings();
    if (w.length) {
      console.log('  Setup still needed:');
      w.forEach((x) => console.log(`   - ${x}`));
      console.log('');
    }
    // Create the API key and TwiML app if they do not exist, and make sure
    // Twilio is pointing at THIS deployment. Runs every boot; safe to repeat.
    provision
      .run({ reason: 'boot' })
      .then((r) => {
        if (!r.ran && r.reason) console.log(`  Twilio auto-setup did not run: ${r.reason}`);
        console.log('');
      })
      .catch((e) => console.error('[setup]', e));
  });
}

module.exports = { app, server, db };
