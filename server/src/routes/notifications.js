import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { requireAuth, wrap } from '../auth.js';
import { subscribe } from '../events.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  wrap(async (req, res) => {
    const rows = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [req.user.id]);
    const unread = (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id])).n;
    res.json({ notifications: rows, unread });
  })
);

router.post(
  '/read-all',
  wrap(async (req, res) => {
    await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), req.user.id]);
    res.json({ ok: true });
  })
);

// Delete several at once: { ids: [1, 2, 3] }, { all: true } or { read: true } (only the ones already read).
router.post(
  '/delete',
  wrap(async (req, res) => {
    const { ids, all, read } = req.body || {};
    let result;
    if (all === true) {
      result = await db.run('DELETE FROM notifications WHERE user_id = ?', [req.user.id]);
    } else if (read === true) {
      result = await db.run('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL', [req.user.id]);
    } else {
      const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      if (list.length === 0) return res.status(400).json({ error: 'Nothing selected' });
      result = await db.run(`DELETE FROM notifications WHERE user_id = ? AND id IN (${list.map(() => '?').join(',')})`, [req.user.id, ...list]);
    }
    res.json({ ok: true, deleted: result.changes });
  })
);

router.post(
  '/:id/read',
  wrap(async (req, res) => {
    await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', [nowIso(), Number(req.params.id) || 0, req.user.id]);
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const result = await db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [Number(req.params.id) || 0, req.user.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true, deleted: 1 });
  })
);

// Live stream (Server-Sent Events). The app opens this once and refreshes on messages.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  const unsubscribe = subscribe(req.user.id, res);
  req.on('close', unsubscribe);
});

export default router;
