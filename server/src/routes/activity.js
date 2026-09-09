// Activity log (admin only): who did what and when.  GET /api/activity?limit=100&before=<id>&action=meeting.&user_id=3&q=text
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin, wrap } from '../auth.js';
import { ACTION_LABELS, logActivity } from '../activity.js';
import { parse, activityQuery, activityDelete, idParam } from '../validate.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get(
  '/',
  wrap(async (req, res) => {
    const query = parse(activityQuery, req.query);
    const limit = query.limit;
    const where = [];
    const params = [];
    if (query.before) {
      where.push('l.id < ?');
      params.push(query.before);
    }
    if (query.action) {
      where.push('l.action LIKE ?');
      params.push(`${query.action.replace(/%/g, '')}%`);
    }
    if (query.user_id) {
      where.push('l.user_id = ?');
      params.push(query.user_id);
    }
    if (query.q) {
      where.push('(LOWER(l.user_name) LIKE ? OR LOWER(l.details) LIKE ? OR LOWER(l.action) LIKE ?)');
      const q = `%${query.q.toLowerCase()}%`;
      params.push(q, q, q);
    }
    if (query.from && !Number.isNaN(Date.parse(query.from))) {
      where.push('l.created_at >= ?');
      params.push(new Date(query.from).toISOString());
    }
    if (query.to && !Number.isNaN(Date.parse(query.to))) {
      where.push('l.created_at < ?');
      params.push(new Date(new Date(query.to).getTime() + 86400000).toISOString());
    }
    params.push(limit + 1);
    const rows = await db.all(
      `SELECT l.*, CASE WHEN u.avatar_path IS NULL THEN NULL ELSE '/api/auth/avatar/' || u.id END AS avatar_url
       FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`,
      params
    );
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => {
      let details = {};
      try {
        details = JSON.parse(r.details || '{}');
      } catch {
        details = {};
      }
      return { ...r, details, label: ACTION_LABELS[r.action] || r.action };
    });
    res.json({ activity: items, more, actions: ACTION_LABELS });
  })
);

// ---------- deleting entries ----------
// Admins can tidy the log. Every deletion is itself recorded (after the rows are gone), so the log always
// shows that something was removed, by whom and how much — clearing it can never be done invisibly.

/** Delete several at once: { ids: [1, 2, 3] }. */
router.post(
  '/delete',
  wrap(async (req, res) => {
    const { ids } = parse(activityDelete, req.body);
    const result = await db.run(`DELETE FROM activity_log WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (result.changes > 0) logActivity(req, 'activity.delete', null, null, { count: result.changes });
    res.json({ ok: true, deleted: result.changes });
  })
);

/** Delete one entry. */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const result = await db.run('DELETE FROM activity_log WHERE id = ?', [id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Activity entry not found' });
    logActivity(req, 'activity.delete', null, null, { count: 1 });
    res.json({ ok: true, deleted: 1 });
  })
);

export default router;
