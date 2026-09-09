import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { db, nowIso } from '../db.js';
import {
  publicUser,
  requireAuth,
  loadUser,
  wrap,
  createSession,
  refreshSession,
  revokeSession,
  revokeUserSessions,
  listSessions,
  signTicket,
  signTwofaToken,
  readTwofaToken,
} from '../auth.js';
import { avatarUpload, checkUploads, uploadDir, removeStored } from '../uploads.js';
import { pushStatus } from '../push.js';
import { isSessionLive } from '../events.js';
import { logActivity } from '../activity.js';
import { mailEnabled, mailStatus, sendMail, renderEmail, appUrl } from '../mail.js';
import {
  loginLimiter,
  twofaLimiter,
  codeSendLimiter,
  forgotLimiter,
  resetLimiter,
  refreshLimiter,
  ticketLimiter,
  uploadLimiter,
  lockedFor,
  recordFailure,
  clearFailures,
} from '../limits.js';
import {
  parse,
  loginBody,
  refreshBody,
  forgotBody,
  resetBody,
  changePasswordBody,
  meBody,
  ticketBody,
  twofaLoginBody,
  twofaEnableBody,
  twofaDisableBody,
  twofaResendBody,
  twofaSetupBody,
} from '../validate.js';
import { passwordProblem, randomToken, hashToken } from '../passwords.js';
import { generateSecret, encryptSecret, decryptSecret, verifyCode, otpauthUrl, generateRecoveryCodes, hashRecoveryCode } from '../totp.js';
import { sendEmailCode, useEmailCode, RESEND_AFTER_MS } from '../emailcode.js';
import { log } from '../log.js';

const router = Router();
const HASH_ROUNDS = 10;
// Comparing against this when the email is unknown keeps the timing the same as a real wrong password.
const DUMMY_HASH = bcrypt.hashSync(randomToken(16), HASH_ROUNDS);

router.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const { email, password } = parse(loginBody, req.body);
    const wait = lockedFor(email);
    if (wait) {
      logActivity({ user: null }, 'auth.login_locked', 'user', null, { email, ip: req.ip });
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    }
    const user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      const left = recordFailure(email);
      logActivity({ user: user || null }, 'auth.login_failed', 'user', user?.id ?? null, { email, ip: req.ip, user_name: user?.name });
      const hint = left > 0 && left <= 3 ? ` ${left} attempt(s) left before the account is locked for 15 minutes.` : left === 0 ? ' The account is now locked for 15 minutes.' : '';
      return res.status(401).json({ error: `Wrong email or password.${hint}` });
    }
    if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
    clearFailures(email);
    // With two-factor on, the password alone earns nothing but a five-minute token for step two.
    if (user.totp_enabled) {
      logActivity({ user }, 'auth.twofa_challenge', 'user', user.id, { ip: req.ip, method: user.twofa_method });
      const body = { twofa_required: true, twofa_token: signTwofaToken(user), method: user.twofa_method === 'email' ? 'email' : 'app' };
      // By email there is nothing to open, so the code has to be on its way before the screen appears.
      if (body.method === 'email') {
        const { sent, wait, to } = await sendEmailCode(user, 'login');
        Object.assign(body, { sent_to: to, sent, resend_in: sent ? Math.ceil(RESEND_AFTER_MS / 1000) : wait });
      }
      return res.json(body);
    }
    const session = await createSession(user, req);
    logActivity({ user }, 'auth.login', 'user', user.id, { ip: req.ip });
    res.json({ ...session, user: publicUser(await loadUser(user.id)) });
  })
);

// Trades a refresh token for a fresh access token (+ a new refresh token; the old one is dead).
router.post(
  '/refresh',
  refreshLimiter,
  wrap(async (req, res) => {
    const { refresh_token } = parse(refreshBody, req.body);
    const next = await refreshSession(refresh_token, req);
    if (!next) return res.status(401).json({ error: 'Session expired, please sign in again' });
    const { user, ...tokens } = next;
    res.json({ ...tokens, user: publicUser(await loadUser(user.id)) });
  })
);

router.post(
  '/logout',
  requireAuth,
  wrap(async (req, res) => {
    await revokeSession(req.sessionId);
    res.json({ ok: true });
  })
);

/** Signs the user out on every device, including this one. */
router.post(
  '/logout-all',
  requireAuth,
  wrap(async (req, res) => {
    await revokeUserSessions(req.user.id);
    logActivity(req, 'auth.logout_all', 'user', req.user.id, {});
    res.json({ ok: true });
  })
);

router.get(
  '/sessions',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await listSessions(req.user.id);
    res.json({ sessions: rows.map((s) => ({ ...s, current: s.id === req.sessionId, active: isSessionLive(s.id) })) });
  })
);

/** A 2-minute link for one protected file (opened in a new tab, where the app cannot add a header). */
router.post(
  '/ticket',
  requireAuth,
  ticketLimiter,
  wrap(async (req, res) => {
    const { path: target } = parse(ticketBody, req.body);
    const ticket = signTicket(req.user, req.sessionId, target);
    res.json({ url: `${target}${target.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}` });
  })
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, push: pushStatus(), mail: mailStatus() });
});

// Personal preferences (currently: email notifications on/off).
router.patch(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const body = parse(meBody, req.body);
    if (body.email_notifications !== undefined) {
      await db.run('UPDATE users SET email_notifications = ? WHERE id = ?', [body.email_notifications ? 1 : 0, req.user.id]);
    }
    res.json({ user: publicUser(await loadUser(req.user.id)) });
  })
);

// ---------- forgot / reset password (needs email to be set up) ----------
router.post(
  '/forgot',
  forgotLimiter,
  wrap(async (req, res) => {
    const { email } = parse(forgotBody, req.body);
    if (!mailEnabled()) return res.status(400).json({ error: 'Password reset by email is not set up on this server. Ask your admin to reset your password.' });
    const user = await db.get('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?) AND active = 1', [email]);
    // Always answer the same way so nobody can probe which emails exist.
    if (user) {
      const token = randomToken(32);
      const expires = new Date(Date.now() + 60 * 60000).toISOString();
      await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);
      await db.run('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), user.id, expires]);
      const url = `${appUrl()}/?reset=${token}`;
      await sendMail({
        to: user.email,
        subject: 'Reset your UpNotice password',
        text: `Hi ${user.name},\n\nSomeone asked to reset the password for this UpNotice account. Open this link within 1 hour to choose a new password:\n${url}\n\nIf that wasn't you, you can ignore this email.`,
        html: renderEmail({
          title: 'Reset your password',
          body: `Hi ${user.name},\n\nSomeone asked to reset the password for this UpNotice account. The link works for 1 hour.\n\nIf that wasn't you, you can ignore this email.`,
          buttonLabel: 'Choose a new password',
          buttonUrl: url,
        }),
      });
      logActivity({ user }, 'auth.password_reset_requested', 'user', user.id, { ip: req.ip });
    }
    res.json({ ok: true, message: 'If that email belongs to an account, a reset link is on its way.' });
  })
);

router.post(
  '/reset',
  resetLimiter,
  wrap(async (req, res) => {
    const { token, password } = parse(resetBody, req.body);
    const row = await db.get('SELECT * FROM password_resets WHERE token = ?', [hashToken(token)]);
    if (!row || row.used_at || row.expires_at < nowIso()) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const user = await loadUser(row.user_id);
    if (!user || !user.active) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const problem = passwordProblem(password, user);
    if (problem) return res.status(400).json({ error: problem });
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [bcrypt.hashSync(password, HASH_ROUNDS), row.user_id]);
    await db.run('UPDATE password_resets SET used_at = ? WHERE token = ?', [nowIso(), row.token]);
    await revokeUserSessions(user.id); // a reset means the old password may be in the wrong hands
    clearFailures(user.email);
    const session = await createSession(user, req);
    logActivity({ user }, 'auth.password_reset', 'user', row.user_id, { ip: req.ip });
    res.json({ ok: true, ...session, user: publicUser(await loadUser(user.id)) });
  })
);

router.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const { currentPassword, newPassword } = parse(changePasswordBody, req.body);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
    const problem = passwordProblem(newPassword, user);
    if (problem) return res.status(400).json({ error: problem });
    if (bcrypt.compareSync(newPassword, user.password_hash)) return res.status(400).json({ error: 'Choose a password you have not used before' });
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [bcrypt.hashSync(newPassword, HASH_ROUNDS), user.id]);
    await revokeUserSessions(user.id, { except: req.sessionId }); // other devices must sign in again
    logActivity(req, 'auth.password_change', 'user', user.id, {});
    res.json({ ok: true, user: publicUser(await loadUser(user.id)) });
  })
);

// ---------- profile photo ----------
router.post(
  '/avatar',
  requireAuth,
  uploadLimiter,
  avatarUpload.single('photo'),
  checkUploads({ imagesOnly: true }),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an image first' });
    const old = (await db.get('SELECT avatar_path FROM users WHERE id = ?', [req.user.id]))?.avatar_path;
    await db.run('UPDATE users SET avatar_path = ? WHERE id = ?', [req.file.filename, req.user.id]);
    removeStored(old);
    res.json({ user: publicUser(await loadUser(req.user.id)) });
  })
);

router.delete(
  '/avatar',
  requireAuth,
  wrap(async (req, res) => {
    const old = (await db.get('SELECT avatar_path FROM users WHERE id = ?', [req.user.id]))?.avatar_path;
    await db.run('UPDATE users SET avatar_path = NULL WHERE id = ?', [req.user.id]);
    removeStored(old);
    res.json({ user: publicUser(await loadUser(req.user.id)) });
  })
);

// Anyone signed in can see anyone's photo (shown next to comments, read receipts, etc.).
const AVATAR_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
router.get(
  '/avatar/:userId',
  requireAuth,
  wrap(async (req, res) => {
    const row = await db.get('SELECT avatar_path FROM users WHERE id = ?', [Number(req.params.userId) || 0]);
    if (!row?.avatar_path) return res.status(404).end();
    const file = path.basename(row.avatar_path);
    const mime = AVATAR_TYPES[path.extname(file).slice(1).toLowerCase()];
    if (!mime) return res.status(404).end(); // an old upload we cannot vouch for
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(path.join(uploadDir, file), (err) => {
      if (err && !res.headersSent) res.status(404).end();
      else if (err) log.warn({ err: err.message }, 'avatar send failed');
    });
  })
);

// ---------- two-factor authentication ----------
// An authenticator app (TOTP). The secret is generated here and kept encrypted; it leaves the server only
// once, while the person is setting it up and has to scan it. After that they prove they still have it.

/** Reads a user's secret back. Null when two-factor is off, or the stored value cannot be decrypted. */
function secretOf(row) {
  return row?.totp_secret ? decryptSecret(row.totp_secret) : null;
}

/** Writes a fresh set of recovery codes and returns them in the clear, once. */
async function issueRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  await db.run('DELETE FROM recovery_codes WHERE user_id = ?', [userId]);
  for (const code of codes) await db.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, hashRecoveryCode(code)]);
  return codes;
}

/**
 * Checks a typed second factor: the six digits (from the app, or the ones just emailed), or one of the
 * recovery codes — whichever it is, it is spent afterwards. Returns 'code', 'email', 'recovery',
 * 'replay' (right digits from the app, but already used) or null.
 */
async function checkSecondFactor(row, typed, purpose = 'login') {
  // Emailed codes live in their own table; the account has no TOTP secret when it is set up this way.
  if (row.twofa_method === 'email' && (await useEmailCode(row.id, purpose, typed))) return 'email';
  const secret = secretOf(row);
  if (secret) {
    const lastStep = Number(row.totp_last_step) || 0;
    const step = verifyCode(secret, typed, { afterStep: lastStep });
    if (step) {
      // Remember the step, so the same six digits cannot be replayed inside their 30-second life.
      await db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', [step, row.id]);
      return 'code';
    }
    // Right digits, already spent: worth saying so, or the person retypes the same ones and gives up.
    if (lastStep && verifyCode(secret, typed)) return 'replay';
  }
  const hash = hashRecoveryCode(typed);
  const found = await db.get('SELECT 1 FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [row.id, hash]);
  if (!found) return null;
  await db.run('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?', [nowIso(), row.id, hash]);
  return 'recovery';
}

/** Step two of signing in: the half-way token plus a code. */
router.post(
  '/login/2fa',
  twofaLimiter,
  wrap(async (req, res) => {
    const { twofa_token, code } = parse(twofaLoginBody, req.body);
    const userId = readTwofaToken(twofa_token);
    if (!userId) return res.status(401).json({ error: 'That took too long — please sign in again' });
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user || !user.active || !user.totp_enabled) return res.status(401).json({ error: 'Please sign in again' });
    const wait = lockedFor(user.email);
    if (wait) return res.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} minute(s).` });

    const how = await checkSecondFactor(user, code, 'login');
    if (how === 'replay') return res.status(401).json({ error: 'That code has already been used. Wait for the app to show the next one.' });
    if (!how) {
      // Wrong codes count towards the same lockout as wrong passwords: knowing the password must not buy
      // an attacker unlimited guesses at the second factor.
      recordFailure(user.email);
      logActivity({ user }, 'auth.twofa_failed', 'user', user.id, { ip: req.ip });
      const where = user.twofa_method === 'email' ? 'Check the email we sent, or use a recovery code.' : 'Check the app, or use a recovery code.';
      return res.status(401).json({ error: `That code is not right. ${where}` });
    }
    clearFailures(user.email);
    const session = await createSession(user, req);
    logActivity({ user }, 'auth.login', 'user', user.id, { ip: req.ip, second_factor: how });
    if (how === 'recovery') {
      const left = (await db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id])).n;
      logActivity({ user }, 'auth.twofa_recovery_used', 'user', user.id, { left });
      return res.json({ ...session, user: publicUser(await loadUser(user.id)), recovery_codes_left: left });
    }
    res.json({ ...session, user: publicUser(await loadUser(user.id)) });
  })
);

/** Send the emailed code again — the same half-way token, a new code, the old one dead. */
router.post(
  '/login/2fa/resend',
  codeSendLimiter,
  wrap(async (req, res) => {
    const { twofa_token } = parse(twofaResendBody, req.body);
    const userId = readTwofaToken(twofa_token);
    if (!userId) return res.status(401).json({ error: 'That took too long — please sign in again' });
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user || !user.active || !user.totp_enabled || user.twofa_method !== 'email') return res.status(400).json({ error: 'Please sign in again' });
    const { sent, wait, to } = await sendEmailCode(user, 'login');
    if (!sent && wait) return res.status(429).json({ error: `A code is already on its way. Try again in ${wait} second(s).` });
    if (!sent) return res.status(500).json({ error: 'The code could not be sent. Use a recovery code, or ask your admin.' });
    res.json({ ok: true, sent_to: to, resend_in: Math.ceil(RESEND_AFTER_MS / 1000) });
  })
);

/**
 * Start setting it up. With an app: a new secret and the QR address for it. By email: a code on its way
 * to the account's own address. Either way nothing is switched on until a code is typed back.
 */
router.post(
  '/2fa/setup',
  requireAuth,
  codeSendLimiter,
  wrap(async (req, res) => {
    const { method } = parse(twofaSetupBody, req.body);
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (row.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });

    if (method === 'email') {
      if (!mailEnabled())
        return res
          .status(400)
          .json({ error: 'This server cannot send email yet, so codes by email are not available. Use an authenticator app, or ask your admin to set email up.' });
      // No secret in this mode: the code is made fresh each time and lives in its own table.
      await db.run("UPDATE users SET twofa_method = 'email', totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?", [req.user.id]);
      const { sent, wait, to } = await sendEmailCode(row, 'setup');
      if (!sent && wait) return res.status(429).json({ error: `A code is already on its way. Try again in ${wait} second(s).` });
      if (!sent) return res.status(500).json({ error: 'The code could not be sent. Check the email settings, or use an authenticator app.' });
      return res.json({ method: 'email', sent_to: to, resend_in: Math.ceil(RESEND_AFTER_MS / 1000) });
    }

    const secret = generateSecret();
    // Stored against the account but not switched on, so a half-finished setup can never lock anyone out.
    await db.run("UPDATE users SET totp_secret = ?, totp_enabled = 0, twofa_method = 'app' WHERE id = ?", [encryptSecret(secret), req.user.id]);
    res.json({ method: 'app', secret, otpauth_url: otpauthUrl(secret, { account: row.email }) });
  })
);

/** Another emailed code while signed in: for finishing setup, or for confirming a change below. */
router.post(
  '/2fa/send-code',
  requireAuth,
  codeSendLimiter,
  wrap(async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (row.twofa_method !== 'email') return res.status(400).json({ error: 'This account uses an authenticator app' });
    const { sent, wait, to } = await sendEmailCode(row, row.totp_enabled ? 'verify' : 'setup');
    if (!sent && wait) return res.status(429).json({ error: `A code is already on its way. Try again in ${wait} second(s).` });
    if (!sent) return res.status(500).json({ error: 'The code could not be sent. Check the email settings.' });
    res.json({ ok: true, sent_to: to, resend_in: Math.ceil(RESEND_AFTER_MS / 1000) });
  })
);

/** Confirm the app is set up by typing a code from it. Returns the recovery codes, shown once. */
router.post(
  '/2fa/enable',
  requireAuth,
  twofaLimiter,
  wrap(async (req, res) => {
    const { code } = parse(twofaEnableBody, req.body);
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (row.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });
    if (row.twofa_method === 'email') {
      if (!(await useEmailCode(req.user.id, 'setup', code))) return res.status(400).json({ error: 'That code is not right. Check the email, or send yourself a new one.' });
      await db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [req.user.id]);
    } else {
      const secret = secretOf(row);
      if (!secret) return res.status(400).json({ error: 'Start the setup again' });
      const step = verifyCode(secret, code);
      if (!step) return res.status(400).json({ error: 'That code is not right. Check the app and try the next one.' });
      await db.run('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?', [step, req.user.id]);
    }
    const codes = await issueRecoveryCodes(req.user.id);
    logActivity(req, 'auth.twofa_enabled', 'user', req.user.id, { method: row.twofa_method });
    res.json({ ok: true, method: row.twofa_method === 'email' ? 'email' : 'app', recovery_codes: codes });
  })
);

/** Turning it off needs the password and a current code — a borrowed unlocked laptop is not enough. */
router.post(
  '/2fa/disable',
  requireAuth,
  twofaLimiter,
  wrap(async (req, res) => {
    const { password, code } = parse(twofaDisableBody, req.body);
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is not on' });
    if (!bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'That password is not right' });
    const how = await checkSecondFactor(row, code, 'verify');
    if (how === 'replay') return res.status(401).json({ error: 'That code has already been used. Wait for the app to show the next one.' });
    if (!how) return res.status(401).json({ error: 'That code is not right' });
    await db.run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, twofa_method = 'app' WHERE id = ?", [req.user.id]);
    await db.run('DELETE FROM recovery_codes WHERE user_id = ?', [req.user.id]);
    await db.run('DELETE FROM email_codes WHERE user_id = ?', [req.user.id]);
    logActivity(req, 'auth.twofa_disabled', 'user', req.user.id, {});
    res.json({ ok: true });
  })
);

/** A fresh set of recovery codes, once some have been used. The old ones stop working. */
router.post(
  '/2fa/recovery-codes',
  requireAuth,
  twofaLimiter,
  wrap(async (req, res) => {
    const { code } = parse(twofaEnableBody, req.body);
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is not on' });
    const how = await checkSecondFactor(row, code, 'verify');
    if (how === 'replay') return res.status(401).json({ error: 'That code has already been used. Wait for the app to show the next one.' });
    if (!how) return res.status(401).json({ error: 'That code is not right' });
    const codes = await issueRecoveryCodes(req.user.id);
    logActivity(req, 'auth.twofa_recovery_reissued', 'user', req.user.id, {});
    res.json({ ok: true, recovery_codes: codes, recovery_codes_left: codes.length });
  })
);

// ---------- my history (employee self-service) ----------
router.get(
  '/my-history',
  requireAuth,
  wrap(async (req, res) => {
    const me = req.user.id;
    const meetings = await db.all(
      `SELECT m.id, m.title, m.starts_at, m.ends_at, m.location, m.status, r.status AS my_rsvp, r.note AS my_note, r.responded_at
       FROM meetings m
       LEFT JOIN meeting_rsvps r ON r.meeting_id = m.id AND r.user_id = @me
       WHERE (m.company_id IS NULL OR m.company_id = @company)
         AND (NOT EXISTS (SELECT 1 FROM meeting_targets t WHERE t.meeting_id = m.id)
              OR EXISTS (SELECT 1 FROM meeting_targets t WHERE t.meeting_id = m.id AND t.department_id = @dept))
       ORDER BY m.starts_at DESC LIMIT 100`,
      { me, company: req.user.company_id ?? -1, dept: req.user.department_id ?? -1 }
    );
    const past = meetings.filter((m) => m.ends_at < nowIso() && m.status === 'scheduled');
    const stats = {
      invited: past.length,
      going: past.filter((m) => m.my_rsvp === 'going').length,
      maybe: past.filter((m) => m.my_rsvp === 'maybe').length,
      declined: past.filter((m) => m.my_rsvp === 'declined').length,
      no_reply: past.filter((m) => !m.my_rsvp).length,
    };
    const reads = await db.all(
      `SELECT a.id, a.title, a.priority, a.ack_required, r.read_at, r.acknowledged_at
       FROM announcements a JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
       ORDER BY r.read_at DESC LIMIT 100`,
      [me]
    );
    res.json({ stats, meetings, reads });
  })
);

export default router;
