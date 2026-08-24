'use strict';

require('dotenv').config();

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

const config = {
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  databasePath: process.env.DATABASE_PATH || './data/dialer.db',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    apiKeySid: process.env.TWILIO_API_KEY_SID || '',
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET || '',
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID || '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',

    // Set this when the Twilio account is shared with another application.
    // Auto-setup then refuses to touch any number that is not explicitly
    // listed in CALLER_IDS, so it cannot disturb the other project's numbers.
    sharedAccount: bool(process.env.TWILIO_SHARED_ACCOUNT, false),
  },

  // With this on, the app creates its own Twilio API key and TwiML App on
  // boot and keeps the webhook URLs pointing at itself. Set AUTO_SETUP=false
  // if you would rather wire Twilio by hand.
  autoSetup: bool(process.env.AUTO_SETUP, true),

  companyName: process.env.COMPANY_NAME || 'our team',

  // Reports are shown in this timezone, not UTC, so "yesterday" means what a
  // person means by it.
  reportTimezone: process.env.REPORT_TIMEZONE || 'America/New_York',

  sms: {
    enabled: bool(process.env.SMS_ENABLED, true),
    quietHours: bool(process.env.SMS_QUIET_HOURS, true),
    maxPerBatch: clamp(int(process.env.SMS_MAX_PER_BATCH, 200), 1, 2000),
    perSecond: clamp(int(process.env.SMS_PER_SECOND, 3), 1, 20),
    dailyCapPerAgent: clamp(int(process.env.SMS_DAILY_CAP_PER_AGENT, 500), 1, 20000),
    appendOptOut: bool(process.env.SMS_APPEND_OPT_OUT, true),
    optOutText: process.env.SMS_OPT_OUT_TEXT || 'Reply STOP to opt out.',
  },

  admin: {
    email: (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim(),
    password: process.env.ADMIN_PASSWORD || 'changeme123',
  },

  callerIds: (process.env.CALLER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  maxLinesPerAgent: clamp(int(process.env.MAX_LINES_PER_AGENT, 5), 1, 5),
  recordCalls: bool(process.env.RECORD_CALLS, false),
  recordingNotice: process.env.RECORDING_NOTICE || 'This call may be recorded for quality assurance.',
  enableAmd: bool(process.env.ENABLE_AMD, true),

  enforceCallingHours: bool(process.env.ENFORCE_CALLING_HOURS, true),
  callingHoursStart: clamp(int(process.env.CALLING_HOURS_START, 8), 0, 23),
  callingHoursEnd: clamp(int(process.env.CALLING_HOURS_END, 21), 1, 24),

  abandonMessage:
    process.env.ABANDON_MESSAGE ||
    'Hello. We are sorry we missed you. Please call us back at your convenience. Thank you.',

  ringTimeout: clamp(int(process.env.RING_TIMEOUT, 25), 10, 60),
  wrapUpSeconds: clamp(int(process.env.WRAP_UP_SECONDS, 5), 0, 120),

  // --- accounts -------------------------------------------------------------
  signup: {
    enabled: bool(process.env.SIGNUP_ENABLED, true),
    allowedDomains: (process.env.SIGNUP_ALLOWED_DOMAINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
    requireApproval: bool(process.env.SIGNUP_REQUIRE_APPROVAL, false),
    defaultMaxLines: clamp(int(process.env.SIGNUP_DEFAULT_MAX_LINES, 3), 1, 5),
  },

  // --- email ----------------------------------------------------------------
  email: {
    provider: (process.env.EMAIL_PROVIDER || 'resend').toLowerCase(), // resend|sendgrid|smtp|console
    from: process.env.EMAIL_FROM || '',
    replyTo: process.env.EMAIL_REPLY_TO || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    smtpUrl: process.env.SMTP_URL || '',
    resetTtlMinutes: clamp(int(process.env.RESET_TOKEN_MINUTES, 60), 5, 1440),
  },

  // --- AI call notes --------------------------------------------------------
  ai: {
    enabled: bool(process.env.AI_NOTES_ENABLED, true),
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-sonnet-4-5',
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    maxTokens: clamp(int(process.env.AI_MAX_TOKENS, 1600), 256, 8192),
    minTalkSeconds: clamp(int(process.env.AI_MIN_TALK_SECONDS, 20), 0, 600),
    autoFillFields: bool(process.env.AI_AUTOFILL_FIELDS, true),
    autoCreateCallbacks: bool(process.env.AI_AUTO_CALLBACKS, true),
  },

  transcription: {
    provider: (process.env.TRANSCRIBE_PROVIDER || 'twilio').toLowerCase(), // twilio|deepgram|openai|none
    twilioServiceSid: process.env.TWILIO_INTELLIGENCE_SERVICE_SID || '',
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    pollSeconds: clamp(int(process.env.TRANSCRIBE_POLL_SECONDS, 20), 5, 300),
    maxWaitMinutes: clamp(int(process.env.TRANSCRIBE_MAX_WAIT_MINUTES, 15), 1, 120),
  },

  isProd: process.env.NODE_ENV === 'production',
};

/**
 * Recompute anything derived from config.twilio. Auto-setup fills those values
 * in at runtime, so this gets called again after it has run.
 */
config.refresh = function refresh() {
  config.twilioConfigured = Boolean(
    config.twilio.accountSid &&
      config.twilio.authToken &&
      config.twilio.apiKeySid &&
      config.twilio.apiKeySecret &&
      config.twilio.twimlAppSid
  );
  return config.twilioConfigured;
};

config.refresh();

/** Problems that should be surfaced in the admin UI rather than crashing the app. */
config.warnings = function warnings() {
  const w = [];
  if (!config.twilio.accountSid) w.push('TWILIO_ACCOUNT_SID is not set.');
  if (!config.twilio.authToken) w.push('TWILIO_AUTH_TOKEN is not set.');
  if (!config.twilio.apiKeySid || !config.twilio.apiKeySecret)
    w.push(
      config.autoSetup
        ? 'No Twilio API key yet - auto-setup makes one on boot. If this persists, check the auth token.'
        : 'TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET are not set - agents cannot get a softphone token.'
    );
  if (!config.twilio.twimlAppSid)
    w.push(
      config.autoSetup
        ? 'No TwiML app yet - auto-setup makes one on boot. If this persists, check the auth token.'
        : 'TWILIO_TWIML_APP_SID is not set - the browser phone cannot place its leg.'
    );
  if (!/^https:\/\//.test(config.publicUrl) && config.isProd)
    w.push('PUBLIC_URL must be an https URL that Twilio can reach.');
  if (config.sessionSecret === 'insecure-dev-secret-change-me') w.push('SESSION_SECRET is still the default value.');
  return w;
};

/** Non-blocking advisories shown in the admin UI. */
config.advisories = function advisories() {
  const a = [];
  if (config.sms.enabled && !config.twilio.messagingServiceSid) {
    a.push(
      'No TWILIO_MESSAGING_SERVICE_SID set. Texting will use a plain number, which US carriers heavily filter. ' +
        'Register an A2P 10DLC campaign in Twilio and set the Messaging Service SID.'
    );
  }
  if (config.companyName === 'our team') {
    a.push('COMPANY_NAME is not set - the {{company_name}} merge field will read "our team".');
  }
  if (config.ai.enabled && !config.ai.apiKey) {
    a.push('AI notes are on but ANTHROPIC_API_KEY is not set - no notes will be written.');
  }
  if (config.ai.enabled && !config.recordCalls) {
    a.push('AI notes are on but RECORD_CALLS is false - notes will be written from the rep\'s typed notes only.');
  }
  if (config.recordCalls && config.transcription.provider === 'twilio' && !config.transcription.twilioServiceSid) {
    a.push('Transcription is set to Twilio but TWILIO_INTELLIGENCE_SERVICE_SID is missing.');
  }
  if (!config.email.from) {
    a.push('EMAIL_FROM is not set - password reset emails cannot be sent.');
  }
  if (config.email.provider === 'resend' && !config.email.resendApiKey) {
    a.push('RESEND_API_KEY is not set - password reset emails cannot be sent.');
  }
  if (config.signup.enabled && !config.signup.allowedDomains.length) {
    a.push('SIGNUP_ALLOWED_DOMAINS is empty - anyone with the link could create an account.');
  }
  return a;
};

module.exports = config;
