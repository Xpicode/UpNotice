import { db, staffIds, insertMany } from './db.js';
import { notifyUsers } from './events.js';
import { sendPush } from './push.js';
import { emailUsers, appUrl } from './mail.js';

/**
 * Creates an in-app notification for every user id, pushes it live over SSE, sends a mobile push,
 * and emails everyone who has email notifications switched on.
 */
export async function createNotifications(userIds, { type, title, body = '', refType = null, refId = null, email = true }) {
  if (userIds.length === 0) return;
  await db.tx(async () => {
    // One statement per 500 people — an announcement to 10,000 employees is 20 inserts, not 10,000.
    await insertMany('notifications', ['user_id', 'type', 'title', 'body', 'ref_type', 'ref_id'], userIds.map((id) => [id, type, title, body, refType, refId]));
  });
  notifyUsers(userIds, 'notification', { type, title, body, refType, refId });
  sendPush(userIds, { title, body, data: { type, refType, refId } });
  if (email) emailUsers(userIds, { title, body, url: refType && refId ? `${appUrl()}/?open=${refType}:${refId}` : appUrl() });
}

/** Admins (all) — kept for older code paths. */
export async function adminIds() {
  return (await db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1")).map((r) => r.id);
}

/** Admins plus the managers of the given company: the people who "manage" an announcement / meeting of that company. */
export function managerIds(companyId) {
  return staffIds(companyId);
}
