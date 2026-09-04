// Activity log: who did what, and when. Admins can read it under Settings → Activity (GET /api/activity).
import { db } from './db.js';

/**
 * Records one action. Never throws (a logging problem must not break the real request).
 *   logActivity(req, 'announcement.create', 'announcement', 12, { title: 'Office closed' })
 */
export function logActivity(req, action, targetType = null, targetId = null, details = {}) {
  const user = req?.user || null;
  db.run('INSERT INTO activity_log (user_id, user_name, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)', [
    user?.id ?? null,
    user?.name ?? details?.user_name ?? '',
    action,
    targetType,
    targetId ?? null,
    JSON.stringify(details || {}),
  ]).catch((err) => console.error('Activity log failed:', err.message));
}

/** Human labels for the actions, used by the app and the CSV. */
export const ACTION_LABELS = {
  'auth.login': 'Signed in',
  'auth.password_change': 'Changed own password',
  'auth.password_reset': 'Reset password by email',
  'announcement.create': 'Posted announcement',
  'announcement.draft': 'Saved announcement draft',
  'announcement.publish': 'Published draft',
  'announcement.update': 'Edited announcement',
  'announcement.delete': 'Deleted announcement',
  'meeting.create': 'Scheduled meeting',
  'meeting.update': 'Edited meeting',
  'meeting.cancel': 'Cancelled meeting',
  'meeting.delete': 'Deleted meeting',
  'meeting.minutes': 'Saved meeting minutes',
  'meeting.attendance': 'Updated attendance',
  'user.create': 'Added employee',
  'user.update': 'Edited employee',
  'user.delete': 'Removed employee',
  'user.import': 'Imported employees',
  'company.create': 'Added company',
  'company.update': 'Renamed company',
  'company.delete': 'Deleted company',
  'department.create': 'Added department',
  'department.update': 'Renamed department',
  'department.delete': 'Deleted department',
  'template.create': 'Saved template',
  'template.delete': 'Deleted template',
};
