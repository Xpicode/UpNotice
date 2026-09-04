// Push notifications via Firebase Cloud Messaging. Optional: only active when
// FIREBASE_SERVICE_ACCOUNT (path to the service-account JSON) is set in .env.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';

let messaging = null;
let status = 'disabled';

export async function initPush() {
  const file = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!file) {
    status = 'disabled (set FIREBASE_SERVICE_ACCOUNT in .env to enable)';
    return;
  }
  try {
    const admin = (await import('firebase-admin')).default;
    const json = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(json) });
    messaging = admin.messaging();
    status = `enabled (project ${json.project_id})`;
    console.log(`Push notifications ${status}`);
  } catch (err) {
    status = `error: ${err.message}`;
    console.error('Push notifications could not start:', err.message);
  }
}

export function pushStatus() {
  return status;
}

/** Sends a push to every registered device of the given users. Silently no-ops when disabled. */
export async function sendPush(userIds, { title, body = '', data = {} }) {
  if (!messaging || userIds.length === 0) return;
  const placeholders = userIds.map(() => '?').join(',');
  const rows = await db.all(`SELECT token FROM device_tokens WHERE user_id IN (${placeholders})`, userIds);
  const allTokens = rows.map((r) => r.token);
  if (allTokens.length === 0) return;
  // FCM accepts at most 500 tokens per call.
  for (let i = 0; i < allTokens.length; i += 500) {
    const tokens = allTokens.slice(i, i + 500);
    try {
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])),
        android: { priority: 'high', notification: { channelId: 'upnotice' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      // Forget tokens that FCM says are dead.
      for (let j = 0; j < res.responses.length; j++) {
        const code = res.responses[j].error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          await db.run('DELETE FROM device_tokens WHERE token = ?', [tokens[j]]);
        }
      }
    } catch (err) {
      console.error('Push send failed:', err.message);
    }
  }
}
