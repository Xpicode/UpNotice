// Mobile push-notification device registration (Capacitor apps call this after getting an FCM token).
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { pushStatus } from '../push.js';

const router = Router();
router.use(requireAuth);

router.post('/register', (req, res) => {
  const token = String(req.body?.token || '').trim();
  const platform = String(req.body?.platform || 'unknown').slice(0, 20);
  if (!token) return res.status(400).json({ error: 'token required' });
  db.prepare(
    `INSERT INTO device_tokens (token, user_id, platform) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`
  ).run(token, req.user.id, platform);
  res.json({ ok: true, push: pushStatus() });
});

router.post('/unregister', (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token) db.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?').run(token, req.user.id);
  res.json({ ok: true });
});

export default router;
