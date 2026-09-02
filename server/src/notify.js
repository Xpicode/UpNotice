import { db } from './db.js';
import { notifyUsers } from './events.js';
import { sendPush } from './push.js';

/** Creates an in-app notification for every user id, pushes it live over SSE, and sends a mobile push. */
export async function createNotifications(userIds, { type, title, body = '', refType = null, refId = null }) {
  if (userIds.length === 0) return;
  await db.tx(async () => {
    for (const id of userIds) {
      await db.run('INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?)', [id, type, title, body, refType, refId]);
    }
  });
  notifyUsers(userIds, 'notification', { type, title, body, refType, refId });
  sendPush(userIds, { title, body, data: { type, refType, refId } });
}

export async function adminIds() {
  return (await db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1")).map((r) => r.id);
}
