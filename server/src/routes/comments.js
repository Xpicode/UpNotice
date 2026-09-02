// Comments / questions under an announcement or a meeting.
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth } from '../auth.js';
import { createNotifications, adminIds } from '../notify.js';
import { notifyAll } from '../events.js';

const router = Router();
router.use(requireAuth);

/** Can this user see the thing being commented on? Mirrors the announcement/meeting rules. */
function canSee(user, refType, refId) {
  if (refType === 'announcement') {
    const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(refId);
    if (!row) return null;
    if (user.role === 'admin') return row;
    const now = nowIso();
    if ((row.publish_at && row.publish_at > now) || (row.expires_at && row.expires_at <= now)) return null;
    if (row.company_id && row.company_id !== user.company_id) return null;
    const targets = db.prepare('SELECT department_id FROM announcement_targets WHERE announcement_id = ?').all(refId);
    if (targets.length && !targets.some((t) => t.department_id === user.department_id)) return null;
    return row;
  }
  if (refType === 'meeting') {
    const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(refId);
    if (!row) return null;
    if (user.role === 'admin') return row;
    if (row.company_id && row.company_id !== user.company_id) return null;
    const targets = db.prepare('SELECT department_id FROM meeting_targets WHERE meeting_id = ?').all(refId);
    if (targets.length && !targets.some((t) => t.department_id === user.department_id)) return null;
    return row;
  }
  return null;
}

router.get('/:refType/:refId', (req, res) => {
  const { refType } = req.params;
  const refId = Number(req.params.refId);
  if (!canSee(req.user, refType, refId)) return res.status(404).json({ error: 'Not found' });
  const rows = db
    .prepare(
      `SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, u.role AS user_role, u.avatar_path
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.ref_type = ? AND c.ref_id = ? ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(refType, refId);
  res.json({ comments: rows.map((r) => ({ ...r, mine: r.user_id === req.user.id, avatar_url: r.avatar_path ? `/api/auth/avatar/${r.user_id}` : null })) });
});

router.post('/:refType/:refId', (req, res) => {
  const { refType } = req.params;
  const refId = Number(req.params.refId);
  const target = canSee(req.user, refType, refId);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write something first' });
  const info = db.prepare('INSERT INTO comments (ref_type, ref_id, user_id, body) VALUES (?, ?, ?, ?)').run(refType, refId, req.user.id, body);

  // Who to tell: admins when an employee writes; everyone else in the thread when anyone replies.
  const participants = new Set(db.prepare('SELECT DISTINCT user_id FROM comments WHERE ref_type = ? AND ref_id = ?').all(refType, refId).map((r) => r.user_id));
  if (req.user.role === 'employee') adminIds().forEach((id) => participants.add(id));
  participants.delete(req.user.id);
  const label = refType === 'meeting' ? 'meeting' : 'announcement';
  createNotifications([...participants], {
    type: refType,
    title: `${req.user.name} commented on the ${label}: ${target.title}`,
    body: body.slice(0, 140),
    refType,
    refId,
  });
  notifyAll('comments', { refType, refId });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.delete('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own comments' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  notifyAll('comments', { refType: c.ref_type, refId: c.ref_id });
  res.json({ ok: true });
});

export default router;
