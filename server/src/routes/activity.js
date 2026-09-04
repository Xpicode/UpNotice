// Activity log (admin only): who did what and when.  GET /api/activity?limit=100&before=<id>&action=meeting.&user_id=3&q=text
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin, wrap } from '../auth.js';
import { ACTION_LABELS } from '../activity.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get(
  '/',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const where = [];
    const params = [];
    if (req.query.before) {
      where.push('l.id < ?');
      params.push(Number(req.query.before) || 0);
    }
    if (req.query.action) {
      where.push('l.action LIKE ?');
      params.push(`${String(req.query.action)}%`);
    }
    if (req.query.user_id) {
      where.push('l.user_id = ?');
      params.push(Number(req.query.user_id) || 0);
    }
    if (req.query.q) {
      where.push('(LOWER(l.user_name) LIKE ? OR LOWER(l.details) LIKE ? OR LOWER(l.action) LIKE ?)');
      const q = `%${String(req.query.q).toLowerCase()}%`;
      params.push(q, q, q);
    }
    if (req.query.from) {
      where.push('l.created_at >= ?');
      params.push(new Date(req.query.from).toISOString());
    }
    if (req.query.to) {
      where.push('l.created_at < ?');
      params.push(new Date(new Date(req.query.to).getTime() + 86400000).toISOString());
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

export default router;
