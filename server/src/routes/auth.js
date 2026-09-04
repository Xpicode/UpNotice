import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowIso } from '../db.js';
import { signToken, publicUser, requireAuth, loadUser, wrap } from '../auth.js';
import { avatarUpload, uploadDir, removeStored } from '../uploads.js';
import { pushStatus } from '../push.js';
import { logActivity } from '../activity.js';
import { mailEnabled, mailStatus, sendMail, renderEmail, appUrl } from '../mail.js';

const router = Router();

router.post(
  '/login',
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [String(email).trim()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
    logActivity({ user }, 'auth.login', 'user', user.id, {});
    res.json({ token: signToken(user), user: publicUser(await loadUser(user.id)) });
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
    if (req.body?.email_notifications !== undefined) {
      const on = req.body.email_notifications === true || req.body.email_notifications === 1 || req.body.email_notifications === 'true';
      await db.run('UPDATE users SET email_notifications = ? WHERE id = ?', [on ? 1 : 0, req.user.id]);
    }
    res.json({ user: publicUser(await loadUser(req.user.id)) });
  })
);

// ---------- forgot / reset password (needs email to be set up) ----------
router.post(
  '/forgot',
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Enter your email address' });
    if (!mailEnabled()) return res.status(400).json({ error: 'Password reset by email is not set up on this server. Ask your admin to reset your password.' });
    const user = await db.get('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?) AND active = 1', [email]);
    // Always answer the same way so nobody can probe which emails exist.
    if (user) {
      const token = crypto.randomBytes(24).toString('hex');
      const expires = new Date(Date.now() + 60 * 60000).toISOString();
      await db.run('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, expires]);
      const url = `${appUrl()}/?reset=${token}`;
      await sendMail({
        to: user.email,
        subject: 'Reset your UpNotice password',
        text: `Hi ${user.name},\n\nSomeone asked to reset the password for this UpNotice account. Open this link within 1 hour to choose a new password:\n${url}\n\nIf that wasn't you, you can ignore this email.`,
        html: renderEmail({ title: 'Reset your password', body: `Hi ${user.name},\n\nSomeone asked to reset the password for this UpNotice account. The link works for 1 hour.\n\nIf that wasn't you, you can ignore this email.`, buttonLabel: 'Choose a new password', buttonUrl: url }),
      });
    }
    res.json({ ok: true, message: 'If that email belongs to an account, a reset link is on its way.' });
  })
);

router.post(
  '/reset',
  wrap(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token) return res.status(400).json({ error: 'Missing reset token' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const row = await db.get('SELECT * FROM password_resets WHERE token = ?', [token]);
    if (!row || row.used_at || row.expires_at < nowIso()) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), row.user_id]);
    await db.run('UPDATE password_resets SET used_at = ? WHERE token = ?', [nowIso(), token]);
    const user = await loadUser(row.user_id);
    logActivity({ user }, 'auth.password_reset', 'user', row.user_id, {});
    res.json({ ok: true, token: signToken(user), user: publicUser(user) });
  })
);

router.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), user.id]);
    logActivity(req, 'auth.password_change', 'user', user.id, {});
    res.json({ ok: true });
  })
);

// ---------- profile photo ----------
router.post(
  '/avatar',
  requireAuth,
  avatarUpload.single('photo'),
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
router.get(
  '/avatar/:userId',
  requireAuth,
  wrap(async (req, res) => {
    const row = await db.get('SELECT avatar_path FROM users WHERE id = ?', [Number(req.params.userId) || 0]);
    if (!row?.avatar_path) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(path.join(uploadDir, path.basename(row.avatar_path)));
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
