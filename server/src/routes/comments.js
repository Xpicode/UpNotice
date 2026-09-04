// Comments / questions under an announcement or a meeting.
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth, wrap } from '../auth.js';
import { createNotifications, managerIds } from '../notify.js';
import { isStaff } from '../auth.js';
import { notifyAll } from '../events.js';

const router = Router();
router.use(requireAuth);

/** Can this user see the thing being commented on? Mirrors the announcement/meeting rules. */
async function canSee(user, refType, refId) {
  if (!Number.isInteger(refId) || refId <= 0) return null;
  if (refType === 'announcement') {
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [refId]);
    if (!row) return null;
    if (user.role === 'admin') return row;
    if (user.role === 'manager' && row.company_id != null && row.company_id === user.company_id) return row;
    if (row.is_draft) return null;
    const now = nowIso();
    if ((row.publish_at && row.publish_at > now) || (row.expires_at && row.expires_at <= now)) return null;
    if (row.company_id && row.company_id !== user.company_id) return null;
    const targets = await db.all('SELECT department_id FROM announcement_targets WHERE announcement_id = ?', [refId]);
    if (targets.length && !targets.some((t) => t.department_id === user.department_id)) return null;
    return row;
  }
  if (refType === 'meeting') {
    const row = await db.get('SELECT * FROM meetings WHERE id = ?', [refId]);
    if (!row) return null;
    if (user.role === 'admin') return row;
    if (user.role === 'manager' && row.company_id != null && row.company_id === user.company_id) return row;
    if (row.company_id && row.company_id !== user.company_id) return null;
    const targets = await db.all('SELECT department_id FROM meeting_targets WHERE meeting_id = ?', [refId]);
    if (targets.length && !targets.some((t) => t.department_id === user.department_id)) return null;
    return row;
  }
  return null;
}

router.get(
  '/:refType/:refId',
  wrap(async (req, res) => {
    const { refType } = req.params;
    const refId = Number(req.params.refId);
    if (!(await canSee(req.user, refType, refId))) return res.status(404).json({ error: 'Not found' });
    const rows = await db.all(
      `SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, u.role AS user_role, u.avatar_path
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.ref_type = ? AND c.ref_id = ? ORDER BY c.created_at ASC, c.id ASC`,
      [refType, refId]
    );
    res.json({ comments: rows.map((r) => ({ ...r, mine: r.user_id === req.user.id, avatar_url: r.avatar_path ? `/api/auth/avatar/${r.user_id}` : null })) });
  })
);

router.post(
  '/:refType/:refId',
  wrap(async (req, res) => {
    const { refType } = req.params;
    const refId = Number(req.params.refId);
    const target = await canSee(req.user, refType, refId);
    if (!target) return res.status(404).json({ error: 'Not found' });
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    if (!body) return res.status(400).json({ error: 'Write something first' });
    const { id } = await db.run('INSERT INTO comments (ref_type, ref_id, user_id, body) VALUES (?, ?, ?, ?) RETURNING id', [refType, refId, req.user.id, body]);

    // Who to tell: admins when an employee writes; everyone else in the thread when anyone replies.
    const rows = await db.all('SELECT DISTINCT user_id FROM comments WHERE ref_type = ? AND ref_id = ?', [refType, refId]);
    const participants = new Set(rows.map((r) => r.user_id));
    if (!isStaff(req.user)) (await managerIds(target.company_id)).forEach((id) => participants.add(id));
    participants.delete(req.user.id);
    const label = refType === 'meeting' ? 'meeting' : 'announcement';
    await createNotifications([...participants], {
      type: refType,
      title: `${req.user.name} commented on the ${label}: ${target.title}`,
      body: body.slice(0, 140),
      refType,
      refId,
    });
    notifyAll('comments', { refType, refId });
    res.status(201).json({ id });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const c = await db.get('SELECT * FROM comments WHERE id = ?', [Number(req.params.id) || 0]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.user_id !== req.user.id && !isStaff(req.user)) return res.status(403).json({ error: 'You can only delete your own comments' });
    await db.run('DELETE FROM comments WHERE id = ?', [c.id]);
    notifyAll('comments', { refType: c.ref_type, refId: c.ref_id });
    res.json({ ok: true });
  })
);

export default router;
