// Two-factor codes sent by email, for people who would rather not install an authenticator app.
//
// Six random digits, good for ten minutes, usable once, stored hashed — the same treatment a password
// reset token gets, so a database dump holds nothing anyone can sign in with. Wrong guesses are counted
// and the code is burned after five, and the sign-in route counts them towards the account lockout too.
//
// This is weaker than an authenticator app: it is only as safe as the mailbox. It is here because a
// second factor somebody actually turns on beats a stronger one they never set up.
import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { mailEnabled, sendMail, renderEmail } from './mail.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
/** How long before another code can be asked for — stops the button being used to spam a mailbox. */
export const RESEND_AFTER_MS = 30 * 1000;
/** Wrong guesses before the code is thrown away and a new one has to be sent. */
export const MAX_ATTEMPTS = 5;

/** Six digits, uniformly random. randomInt is the unbiased one; % on random bytes is not. */
export function generateEmailCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Single-use and short-lived, so a plain SHA-256 is the right hash here (as for reset tokens). */
export function hashEmailCode(code) {
  return crypto.createHash('sha256').update(String(code).replace(/\s/g, '')).digest('hex');
}

/** k••••n@gmail.com — enough to recognise your own address, not enough to learn somebody else's. */
export function maskEmail(email) {
  const [name = '', domain = ''] = String(email).split('@');
  const shown = name.length <= 2 ? name.slice(0, 1) : `${name[0]}${'•'.repeat(Math.min(name.length - 2, 6))}${name[name.length - 1]}`;
  return domain ? `${shown}@${domain}` : shown;
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Seconds still to wait before another code may be sent, or 0. */
export async function resendWait(userId, purpose) {
  const row = await db.get('SELECT created_at FROM email_codes WHERE user_id = ? AND purpose = ?', [userId, purpose]);
  if (!row) return 0;
  const left = Date.parse(row.created_at) + RESEND_AFTER_MS - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Sends a fresh code to the account's own email address — never anywhere else, so nobody can use this
 * to post codes at a mailbox they chose. Returns { sent, wait, to }.
 */
export async function sendEmailCode(user, purpose) {
  if (!mailEnabled()) return { sent: false, wait: 0, to: maskEmail(user.email), error: 'Email is not set up on this server' };
  const wait = await resendWait(user.id, purpose);
  if (wait) return { sent: false, wait, to: maskEmail(user.email) };

  const code = generateEmailCode();
  await db.run('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?', [user.id, purpose]);
  await db.run('INSERT INTO email_codes (user_id, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [
    user.id,
    purpose,
    hashEmailCode(code),
    new Date(Date.now() + CODE_TTL_MS).toISOString(),
    nowIso(),
  ]);

  const minutes = Math.round(CODE_TTL_MS / 60000);
  const why = purpose === 'setup' ? 'Type this code into UpNotice to switch on two-factor authentication.' : 'Type this code into UpNotice to finish signing in.';
  const sent = await sendMail({
    to: user.email,
    subject: `${code} is your UpNotice code`,
    text: `Hi ${user.name},\n\n${code}\n\n${why} It works for ${minutes} minutes and only once.\n\nIf you did not ask for this, someone may know your password — change it.`,
    html: renderEmail({
      title: 'Your UpNotice code',
      body: `Hi ${user.name},\n\n${why} It works for ${minutes} minutes and only once.\n\nIf you did not ask for this, someone may know your password — change it.`,
      code,
    }),
  });
  return { sent, wait: 0, to: maskEmail(user.email) };
}

/** Checks a typed code and spends it. Wrong guesses are counted; five of them throw the code away. */
export async function useEmailCode(userId, purpose, typed) {
  const row = await db.get('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?', [userId, purpose]);
  if (!row) return false;
  const forget = () => db.run('DELETE FROM email_codes WHERE user_id = ? AND purpose = ?', [userId, purpose]);
  if (row.expires_at < nowIso()) {
    await forget();
    return false;
  }
  if (!/^\d{6}$/.test(String(typed).replace(/\s/g, '')) || !timingSafeEqualHex(hashEmailCode(typed), row.code_hash)) {
    const attempts = Number(row.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) await forget();
    else await db.run('UPDATE email_codes SET attempts = ? WHERE user_id = ? AND purpose = ?', [attempts, userId, purpose]);
    return false;
  }
  await forget();
  return true;
}

/** Housekeeping: codes that were never used. Called from the same sweep that trims notifications. */
export async function purgeExpiredEmailCodes() {
  const r = await db.run('DELETE FROM email_codes WHERE expires_at < ?', [nowIso()]);
  return r.changes || 0;
}
