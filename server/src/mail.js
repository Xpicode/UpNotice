// Outgoing email. Optional — works as soon as one of these is set in .env:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   (any mailbox, e.g. Gmail with an "app password")
//   RESEND_API_KEY                               (https://resend.com, free tier)
// MAIL_FROM sets the sender, e.g. "UpNotice <notice@yourcompany.com>". APP_PUBLIC_URL is used for links in emails.
import { db } from './db.js';
import { log } from './log.js';

let transport = null; // nodemailer transport (SMTP)
let status = 'disabled';
let mode = null;

export function appUrl() {
  return (process.env.APP_PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, '');
}
export function mailFrom() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || 'UpNotice <no-reply@upnotice.local>';
}

export async function initMail() {
  if (process.env.RESEND_API_KEY) {
    mode = 'resend';
    status = 'enabled (Resend)';
  } else if (process.env.SMTP_HOST) {
    try {
      const { default: nodemailer } = await import('nodemailer');
      const port = Number(process.env.SMTP_PORT) || 587;
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      mode = 'smtp';
      status = `enabled (SMTP ${process.env.SMTP_HOST})`;
    } catch (err) {
      status = `error: ${err.message}`;
    }
  } else {
    status = 'disabled (set SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY in .env to enable)';
  }
  log.info(`Email: ${status}`);
}

export function mailEnabled() {
  return mode !== null;
}
export function mailStatus() {
  return status;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Simple branded HTML wrapper around a text body with an optional button. */
export function renderEmail({ title, body, buttonLabel, buttonUrl }) {
  const paragraphs = String(body || '')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = buttonUrl
    ? `<p style="margin:22px 0 0"><a href="${escapeHtml(buttonUrl)}" style="background:#18181b;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(buttonLabel || 'Open UpNotice')}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e4e4e7">
    <div style="font-weight:700;color:#18181b;font-size:14px;letter-spacing:0.02em;margin-bottom:18px">UpNotice</div>
    <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
    ${paragraphs}${button}
    <p style="margin:26px 0 0;font-size:12px;color:#71717a">You receive this because email notifications are on in your UpNotice settings.</p>
  </div></body></html>`;
}

/** Sends one email. Never throws — returns true/false and logs problems. */
export async function sendMail({ to, subject, text, html }) {
  if (!mode || !to) return false;
  try {
    if (mode === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: mailFrom(), to: [to], subject, text, html }),
      });
      if (res.status === 429) {
        // Rate limited (Resend allows a couple of requests per second) — wait a moment and retry once.
        await new Promise((r) => setTimeout(r, 1200));
        const again = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: mailFrom(), to: [to], subject, text, html }),
        });
        if (!again.ok) throw new Error(`Resend ${again.status}: ${(await again.text()).slice(0, 200)}`);
      } else if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      await transport.sendMail({ from: mailFrom(), to, subject, text, html });
    }
    return true;
  } catch (err) {
    log.error({ err: err.message }, `Email to ${to} failed`);
    return false;
  }
}

/** Emails every listed user who has email notifications switched on. Runs in the background. */
export function emailUsers(userIds, { title, body, url }) {
  if (!mode || userIds.length === 0) return;
  const placeholders = userIds.map(() => '?').join(',');
  db.all(`SELECT email, name FROM users WHERE active = 1 AND email_notifications = 1 AND id IN (${placeholders})`, userIds)
    .then(async (rows) => {
      const html = renderEmail({ title, body, buttonLabel: 'Open in UpNotice', buttonUrl: url || appUrl() });
      const text = `${title}\n\n${body || ''}\n\n${url || appUrl()}`;
      let ok = 0,
        failed = 0,
        streak = 0;
      for (const r of rows) {
        if (await sendMail({ to: r.email, subject: title, text, html })) {
          ok++;
          streak = 0;
        } else if (++streak >= 20) {
          // 20 failures in a row means the mail setup itself is broken (unverified domain, bad key…) — stop hammering it.
          failed += rows.length - ok - failed;
          log.error(`Email "${title}": giving up after 20 consecutive failures — check MAIL_FROM / your Resend or SMTP setup`);
          break;
        } else failed++;
        if (mode === 'resend' && rows.length > 5) await new Promise((res) => setTimeout(res, 550)); // stay under Resend's rate limit
      }
      if (rows.length > 5) log.info(`Email "${title}": ${ok} sent, ${failed} failed (${rows.length} recipients)`);
    })
    .catch((err) => log.error({ err: err.message }, 'Email batch failed'));
}
