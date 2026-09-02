import { Router } from 'express';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { db, nowIso } from '../db.js';
import { signToken, publicUser, requireAuth, loadUser } from '../auth.js';
import { avatarUpload, uploadDir, removeStored } from '../uploads.js';
import { pushStatus } from '../push.js';

const router = Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated' });
  res.json({ token: signToken(user), user: publicUser(loadUser(user.id)) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, push: pushStatus() });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ ok: true });
});

// ---------- profile photo ----------
router.post('/avatar', requireAuth, avatarUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first' });
  const old = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id)?.avatar_path;
  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(req.file.filename, req.user.id);
  removeStored(old);
  res.json({ user: publicUser(loadUser(req.user.id)) });
});

router.delete('/avatar', requireAuth, (req, res) => {
  const old = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.user.id)?.avatar_path;
  db.prepare('UPDATE users SET avatar_path = NULL WHERE id = ?').run(req.user.id);
  removeStored(old);
  res.json({ user: publicUser(loadUser(req.user.id)) });
});

// Anyone signed in can see anyone's photo (shown next to comments, read receipts, etc.).
router.get('/avatar/:userId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(Number(req.params.userId));
  if (!row?.avatar_path) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(path.join(uploadDir, path.basename(row.avatar_path)));
});

// ---------- my history (employee self-service) ----------
router.get('/my-history', requireAuth, (req, res) => {
  const me = req.user.id;
  const meetings = db
    .prepare(
      `SELECT m.id, m.title, m.starts_at, m.ends_at, m.location, m.status, r.status AS my_rsvp, r.note AS my_note, r.responded_at
       FROM meetings m
       LEFT JOIN meeting_rsvps r ON r.meeting_id = m.id AND r.user_id = @me
       WHERE (m.company_id IS NULL OR m.company_id = @company)
         AND (NOT EXISTS (SELECT 1 FROM meeting_targets t WHERE t.meeting_id = m.id)
              OR EXISTS (SELECT 1 FROM meeting_targets t WHERE t.meeting_id = m.id AND t.department_id = @dept))
       ORDER BY m.starts_at DESC LIMIT 100`
    )
    .all({ me, company: req.user.company_id ?? -1, dept: req.user.department_id ?? -1 });
  const past = meetings.filter((m) => m.ends_at < nowIso() && m.status === 'scheduled');
  const stats = {
    invited: past.length,
    going: past.filter((m) => m.my_rsvp === 'going').length,
    maybe: past.filter((m) => m.my_rsvp === 'maybe').length,
    declined: past.filter((m) => m.my_rsvp === 'declined').length,
    no_reply: past.filter((m) => !m.my_rsvp).length,
  };
  const reads = db
    .prepare(
      `SELECT a.id, a.title, a.priority, a.ack_required, r.read_at, r.acknowledged_at
       FROM announcements a JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
       ORDER BY r.read_at DESC LIMIT 100`
    )
    .all(me);
  res.json({ stats, meetings, reads });
});

export default router;
