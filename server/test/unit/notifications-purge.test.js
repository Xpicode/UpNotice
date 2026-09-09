import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway SQLite file: this one really does query, unlike the other unit tests.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upnotice-purge-'));
process.env.JWT_SECRET = 'unit-test-secret-that-is-long-enough-0123456789';
process.env.DATABASE_URL = '';
process.env.DB_FILE = path.join(dir, 'purge.db');

let db, purgeOldNotifications, READ_NOTIFICATION_DAYS, UNREAD_NOTIFICATION_DAYS;

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const titles = async () => (await db.all('SELECT title FROM notifications ORDER BY id')).map((r) => r.title);

beforeAll(async () => {
  const dbModule = await import('../../src/db.js');
  db = dbModule.db;
  await dbModule.initDb();
  ({ purgeOldNotifications, READ_NOTIFICATION_DAYS, UNREAD_NOTIFICATION_DAYS } = await import('../../src/notify.js'));
  await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Tester', 't@example.com', 'x', 'employee')");
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked for a moment; the temp folder is cleared by the OS anyway. */
  }
});

async function seed(rows) {
  await db.run('DELETE FROM notifications');
  for (const [title, readAt, createdAt] of rows) {
    await db.run('INSERT INTO notifications (user_id, type, title, read_at, created_at) VALUES (1, ?, ?, ?, ?)', ['meeting', title, readAt, createdAt]);
  }
}

describe('purgeOldNotifications', () => {
  it('keeps recent ones and drops the rest', async () => {
    await seed([
      ['fresh unread', null, daysAgo(1)],
      ['fresh read', daysAgo(1), daysAgo(1)],
      ['old read', daysAgo(READ_NOTIFICATION_DAYS + 10), daysAgo(READ_NOTIFICATION_DAYS + 10)],
      ['middle-aged unread', null, daysAgo(READ_NOTIFICATION_DAYS + 10)],
      ['ancient unread', null, daysAgo(UNREAD_NOTIFICATION_DAYS + 10)],
    ]);
    expect(await purgeOldNotifications()).toBe(2);
    // An unread notice gets the longer grace period; a read one that old is gone.
    expect(await titles()).toEqual(['fresh unread', 'fresh read', 'middle-aged unread']);
  });

  it('leaves everything alone when nothing is old enough', async () => {
    await seed([
      ['yesterday', daysAgo(1), daysAgo(1)],
      ['last week', null, daysAgo(7)],
    ]);
    expect(await purgeOldNotifications()).toBe(0);
    expect(await titles()).toEqual(['yesterday', 'last week']);
  });

  it('keeps a read notice right up to the cut-off', async () => {
    await seed([
      ['just inside', daysAgo(1), daysAgo(READ_NOTIFICATION_DAYS - 1)],
      ['just outside', daysAgo(1), daysAgo(READ_NOTIFICATION_DAYS + 1)],
    ]);
    expect(await purgeOldNotifications()).toBe(1);
    expect(await titles()).toEqual(['just inside']);
  });
});
