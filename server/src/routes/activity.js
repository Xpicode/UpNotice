// Activity log (admin only): who did what and when.  GET /api/activity?limit=100&before=<id>&action=meeting.&user_id=3&q=text
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin, wrap } from '../auth.js';
import { ACTION_LABELS } from '../activity.js';
import { parse, activityQuery } from '../validate.js';

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

export default router;
