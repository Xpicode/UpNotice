import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { db, nowIso } from '../db.js';
import { publicUser, requireAuth, loadUser, wrap, createSession, refreshSession, revokeSession, revokeUserSessions, listSessions, signTicket } from '../auth.js';
import { avatarUpload, checkUploads, uploadDir, removeStored } from '../uploads.js';
import { pushStatus } from '../push.js';
import { isSessionLive } from '../events.js';
import { logActivity } from '../activity.js';
import { mailEnabled, mailStatus, sendMail, renderEmail, appUrl } from '../mail.js';
import { loginLimiter, forgotLimiter, resetLimiter, refreshLimiter, ticketLimiter, uploadLimiter, lockedFor, recordFailure, clearFailures } from '../limits.js';
import { parse, loginBody, refreshBody, forgotBody, resetBody, changePasswordBody, meBody, ticketBody } from '../validate.js';
import { passwordProblem, randomToken, hashToken } from '../passwords.js';
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
