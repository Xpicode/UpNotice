import { db } from './db.js';
import { notifyUsers } from './events.js';
import { sendPush } from './push.js';

const insert = db.prepare(
  `INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id)
   VALUES (?, ?, ?, ?, ?, ?)`
);

/** Creates an in-app notification for every user id, pushes it live over SSE, and sends a mobile push. */
export function createNotifications(userIds, { type, title, body = '', refType = null, refId = null }) {
  if (userIds.length === 0) return;
  const tx = db.transaction((ids) => {
    for (const id of ids) insert.run(id, type, title, body, refType, refId);
  });
  tx(userIds);
  notifyUsers(userIds, 'notification', { type, title, body, refType, refId });
  sendPush(userIds, { title, body, data: { type, refType, refId } });
}

export function adminIds() {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map((r) => r.id);
}
