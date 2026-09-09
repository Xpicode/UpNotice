import { db, staffIds, insertMany } from './db.js';
import { notifyUsers } from './events.js';
import { sendPush } from './push.js';
import { emailUsers, appUrl } from './mail.js';
import { log } from './log.js';

/**
 * Creates an in-app notification for every user id, pushes it live over SSE, sends a mobile push,
 * and emails everyone who has email notifications switched on.
 */
export async function createNotifications(userIds, { type, title, body = '', refType = null, refId = null, email = true }) {
  if (userIds.length === 0) return;
  await db.tx(async () => {
    // One statement per 500 people — an announcement to 10,000 employees is 20 inserts, not 10,000.
    await insertMany(
      'notifications',
      ['user_id', 'type', 'title', 'body', 'ref_type', 'ref_id'],
      userIds.map((id) => [id, type, title, body, refType, refId])
    );
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

// ---------- housekeeping ----------
// This is the fastest-growing table in the database: one announcement to 10,000 people writes 10,000 rows,
// and nothing here ever expires on its own. The list only ever shows the newest 100, so old rows are storage
// and backup weight with nobody reading them.
/** Read notifications are kept this long. */
export const READ_NOTIFICATION_DAYS = 90;
/** Unread ones last longer, but not forever — nobody comes back to a six-month-old notice. */
export const UNREAD_NOTIFICATION_DAYS = 180;

/** Called by the scheduler once a day. Returns how many rows went. */
export async function purgeOldNotifications() {
  const cutoff = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const read = await db.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', [cutoff(READ_NOTIFICATION_DAYS)]);
  const unread = await db.run('DELETE FROM notifications WHERE created_at < ?', [cutoff(UNREAD_NOTIFICATION_DAYS)]);
  const removed = (read.changes || 0) + (unread.changes || 0);
  if (removed > 0) log.info(`Housekeeping: removed ${removed} notification(s) older than ${READ_NOTIFICATION_DAYS}/${UNREAD_NOTIFICATION_DAYS} days`);
  return removed;
}
