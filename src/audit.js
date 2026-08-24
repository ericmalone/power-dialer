'use strict';

/**
 * The audit trail: who did what, and when.
 *
 * Deliberately append-only and never deleted from the app - if you need to
 * answer "who removed that list" or "who downloaded the whole call log" six
 * months from now, this is the only place that will know.
 */

const { db } = require('./db');

/** Human-readable names for the things we record. */
const ACTIONS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.signup': 'Created their own account',
  'auth.password_changed': 'Changed their password',
  'auth.password_reset': 'Reset a password by email',
  'auth.reset_requested': 'Asked for a password reset',
  'user.created': 'Added an employee',
  'user.invited': 'Invited an employee',
  'user.approved': 'Approved an account',
  'user.role_changed': 'Changed a role',
  'user.disabled': 'Switched an account off',
  'user.enabled': 'Switched an account on',
  'user.deleted': 'Removed an account',
  'user.lines_changed': 'Changed how many lines someone may dial',
  'list.imported': 'Imported a call list',
  'list.deleted': 'Deleted a call list',
  'list.reset': 'Put a list back in the queue',
  'list.assigned': 'Changed who works a list',
  'list.recording_changed': 'Changed recording on a list',
  'list.exported': 'Downloaded list results',
  'dnc.added': 'Added numbers to Do Not Call',
  'dnc.removed': 'Removed a number from Do Not Call',
  'dnc.optout_removed': 'Removed a texting opt-out',
  'number.added': 'Added a caller ID',
  'number.removed': 'Removed a caller ID',
  'number.changed': 'Changed a caller ID',
  'settings.changed': 'Changed settings',
  'report.exported': 'Downloaded a report',
  'health.checked': 'Ran a connection check',
  'twilio.provisioned': 'Ran Twilio auto-setup',
};

function label(action) {
  return ACTIONS[action] || action;
}

/**
 * Record something. Never throws - an audit failure must not break a request.
 * @param {object} req    express request (for the actor and the IP)
 * @param {string} action one of ACTIONS
 * @param {object} [opts] { target, detail }
 */
function log(req, action, opts = {}) {
  try {
    const actor = opts.actor || (req && req.user ? req.user : null);
    const ip =
      (req && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      (req && req.ip) ||
      '';
    db.prepare(
      'INSERT INTO audit_log (actor_id, actor_email, action, target, detail, ip) VALUES (?,?,?,?,?,?)'
    ).run(
      actor ? actor.id : null,
      actor ? actor.email : String(opts.actorEmail || ''),
      action,
      String(opts.target || '').slice(0, 200),
      String(opts.detail || '').slice(0, 600),
      String(ip).slice(0, 60)
    );
  } catch (err) {
    console.error('[audit] could not record', action, err.message);
  }
}

/** Same, when there is no request in hand (background jobs, CLI). */
function logSystem(action, { target = '', detail = '', actorEmail = 'system' } = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_log (actor_id, actor_email, action, target, detail) VALUES (NULL,?,?,?,?)'
    ).run(actorEmail, action, String(target).slice(0, 200), String(detail).slice(0, 600));
  } catch {
    /* never throw */
  }
}

function list({ limit = 200, actorId = null, action = null, since = null } = {}) {
  const where = ['1=1'];
  const params = { limit: Math.min(1000, limit) };
  if (actorId) {
    where.push('a.actor_id = @actorId');
    params.actorId = Number(actorId);
  }
  if (action) {
    where.push('a.action LIKE @action');
    params.action = `${action}%`;
  }
  if (since) {
    where.push('a.created_at >= @since');
    params.since = since;
  }
  return db
    .prepare(
      `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT @limit`
    )
    .all(params)
    .map((r) => ({ ...r, actionLabel: label(r.action), who: r.actor_name || r.actor_email || 'System' }));
}

module.exports = { log, logSystem, list, label, ACTIONS };
