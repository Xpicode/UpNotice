import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { subscribe } from '../events.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id);
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  res.json({ notifications: rows, unread });
});

router.post('/read-all', (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  res.json({ ok: true });
});

router.post('/:id/read', (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Delete several at once: { ids: [1, 2, 3] }, { all: true } or { read: true } (only the ones already read).
router.post('/delete', (req, res) => {
  const { ids, all, read } = req.body || {};
  let result;
  if (all === true) {
    result = db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
  } else if (read === true) {
    result = db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').run(req.user.id);
  } else {
    const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (list.length === 0) return res.status(400).json({ error: 'Nothing selected' });
    result = db
      .prepare(`DELETE FROM notifications WHERE user_id = ? AND id IN (${list.map(() => '?').join(',')})`)
      .run(req.user.id, ...list);
  }
  res.json({ ok: true, deleted: result.changes });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true, deleted: 1 });
});

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
