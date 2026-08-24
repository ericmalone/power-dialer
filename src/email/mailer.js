'use strict';

/**
 * Outbound email: password resets, invites, verification.
 *
 * Resend is the default. SendGrid and plain SMTP are here too so you can
 * switch by changing one environment variable. With nothing configured the
 * mailer prints to the server log instead of throwing, so local development
 * and tests keep working.
 */

const config = require('../config');
const { db } = require('../db');

const sent = []; // kept in memory for tests

function record(to, subject, kind, status, error = '') {
  try {
    db.prepare('INSERT INTO email_log (to_email, subject, kind, status, error) VALUES (?,?,?,?,?)').run(
      to,
      subject,
      kind,
      status,
      String(error || '').slice(0, 400)
    );
  } catch {
    /* logging must never break a request */
  }
}

async function deliver({ to, subject, html, text, kind = 'system' }) {
  const provider = config.email.provider;
  const from = config.email.from;

  if (!from || provider === 'console' || (provider === 'resend' && !config.email.resendApiKey)) {
    console.log(`\n[email:${provider}] would send to ${to}\n  Subject: ${subject}\n  ${text}\n`);
    sent.push({ to, subject, text, html, kind });
    record(to, subject, kind, 'logged');
    return { ok: true, logged: true };
  }

  try {
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.email.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          text,
          ...(config.email.replyTo ? { reply_to: config.email.replyTo } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else if (provider === 'sendgrid') {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.email.sendgridApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject,
          content: [
            { type: 'text/plain', value: text },
            { type: 'text/html', value: html },
          ],
        }),
      });
      if (!res.ok) throw new Error(`SendGrid returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else if (provider === 'smtp') {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport(config.email.smtpUrl);
      await transport.sendMail({ from, to, subject, text, html, replyTo: config.email.replyTo || undefined });
    } else {
      throw new Error(`Unknown EMAIL_PROVIDER "${provider}".`);
    }

    sent.push({ to, subject, text, html, kind });
    record(to, subject, kind, 'sent');
    return { ok: true };
  } catch (err) {
    console.error('[email] send failed', err.message);
    record(to, subject, kind, 'failed', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f4;padding:28px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d1b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e5e1">
      <tr><td>
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#a9541f;font-weight:700;margin-bottom:14px">${escapeHtml(
          config.companyName
        )}</div>
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25">${escapeHtml(title)}</h1>
        ${bodyHtml}
      </td></tr>
    </table>
    <p style="max-width:520px;font-size:12px;color:#6b716d;margin:16px auto 0">This message was sent by the ${escapeHtml(
      config.companyName
    )} dialer. If you were not expecting it you can ignore it.</p>
  </td></tr></table>
  </body></html>`;
}

function button(url, label) {
  return `<p style="margin:22px 0"><a href="${url}" style="display:inline-block;background:#a9541f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">${escapeHtml(
    label
  )}</a></p>
  <p style="font-size:13px;color:#6b716d;margin:0">Or paste this into your browser:<br><span style="word-break:break-all">${url}</span></p>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendPasswordReset({ to, name, url, minutes }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  return deliver({
    to,
    kind: 'reset',
    subject: 'Reset your dialer password',
    text: `${greeting}\n\nUse this link to set a new password. It expires in ${minutes} minutes.\n\n${url}\n\nIf you did not ask for this, nothing has changed - you can ignore this email.`,
    html: shell(
      'Reset your password',
      `<p style="margin:0 0 6px">${escapeHtml(greeting)}</p>
       <p style="margin:0">Click below to set a new password. The link works once and expires in ${minutes} minutes.</p>
       ${button(url, 'Set a new password')}
       <p style="font-size:13px;color:#6b716d;margin:18px 0 0">If you did not ask for this, nothing has changed and you can ignore this email.</p>`
    ),
  });
}

async function sendWelcome({ to, name, url }) {
  const greeting = name ? `Welcome, ${name}.` : 'Welcome.';
  return deliver({
    to,
    kind: 'welcome',
    subject: `Your ${config.companyName} dialer account`,
    text: `${greeting}\n\nYour account is ready. Sign in here:\n${url}\n\nPick a call list, choose your lines, and press START DIALING.`,
    html: shell(
      'Your account is ready',
      `<p style="margin:0 0 6px">${escapeHtml(greeting)}</p>
       <p style="margin:0">Sign in, pick a call list, choose how many lines, and press <b>START DIALING</b>. That is the whole job.</p>
       ${button(url, 'Open the dialer')}`
    ),
  });
}

async function sendInvite({ to, url, invitedBy, minutes }) {
  return deliver({
    to,
    kind: 'invite',
    subject: `You have been added to the ${config.companyName} dialer`,
    text: `${invitedBy} set up a dialer account for you. Use this link within ${minutes} minutes to choose your password:\n\n${url}`,
    html: shell(
      'Set up your account',
      `<p style="margin:0">${escapeHtml(invitedBy)} set up a dialer account for you. Choose a password to get started - this link expires in ${minutes} minutes.</p>
       ${button(url, 'Choose my password')}`
    ),
  });
}

async function sendApprovalNeeded({ to, who }) {
  return deliver({
    to,
    kind: 'approval',
    subject: 'Someone is waiting for dialer access',
    text: `${who} signed up and is waiting for you to approve them in Admin > People.`,
    html: shell(
      'Someone is waiting for access',
      `<p style="margin:0"><b>${escapeHtml(who)}</b> signed up and is waiting for approval. Approve them under <b>Admin &rarr; People</b>.</p>`
    ),
  });
}

module.exports = {
  deliver,
  sendPasswordReset,
  sendWelcome,
  sendInvite,
  sendApprovalNeeded,
  _sent: sent,
  configured() {
    if (!config.email.from) return false;
    if (config.email.provider === 'resend') return Boolean(config.email.resendApiKey);
    if (config.email.provider === 'sendgrid') return Boolean(config.email.sendgridApiKey);
    if (config.email.provider === 'smtp') return Boolean(config.email.smtpUrl);
    return false;
  },
};
