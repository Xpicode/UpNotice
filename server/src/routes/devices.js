// Mobile push-notification device registration (Capacitor apps call this after getting an FCM token).
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, wrap } from '../auth.js';
import { pushStatus } from '../push.js';

const router = Router();
router.use(requireAuth);

router.post(
  '/register',
  wrap(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const platform = String(req.body?.platform || 'unknown').slice(0, 20);
    if (!token) return res.status(400).json({ error: 'token required' });
    await db.run(
      `INSERT INTO device_tokens (token, user_id, platform) VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`,
      [token, req.user.id, platform]
    );
    res.json({ ok: true, push: pushStatus() });
  })
);

router.post(
  '/unregister',
  wrap(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (token) await db.run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', [token, req.user.id]);
    res.json({ ok: true });
  })
);

export default router;
