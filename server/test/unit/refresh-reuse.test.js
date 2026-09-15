import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Refresh-token rotation and reuse detection, against a throwaway SQLite file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upnotice-refresh-'));
process.env.JWT_SECRET = 'unit-test-secret-that-is-long-enough-0123456789';
process.env.DATABASE_URL = '';
process.env.DB_FILE = path.join(dir, 'refresh.db');

let db, auth;
const req = { headers: { 'user-agent': 'vitest' }, ip: '127.0.0.1' };
const user = { id: 1, name: 'Tester', email: 'tester@example.com', role: 'employee', active: 1 };

beforeAll(async () => {
  const dbModule = await import('../../src/db.js');
  db = dbModule.db;
  await dbModule.initDb();
  auth = await import('../../src/auth.js');
  await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Tester', 'tester@example.com', 'x', 'employee')");
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked for a moment; the temp folder is cleared by the OS anyway. */
  }
});

const session = (id) => db.get('SELECT * FROM sessions WHERE id = ?', [id]);
const reuseEvents = () => db.all("SELECT * FROM activity_log WHERE action = 'auth.refresh_reuse'");

describe('refreshSession', () => {
  it('rotates: the new token works, the old one is retired', async () => {
    const first = await auth.createSession(user, req);
    const second = await auth.refreshSession(first.refresh_token, req);
    expect(second).not.toBeNull();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const row = await session(first.session_id);
    expect(row.revoked_at).toBeNull();
    expect(row.previous_token_hash).not.toBeNull();
    expect(row.rotated_at).not.toBeNull();
  });

  it('revokes the whole session when a retired token comes back', async () => {
    const first = await auth.createSession(user, req);
    const second = await auth.refreshSession(first.refresh_token, req);
    expect(await auth.refreshSession(first.refresh_token, req)).toBeNull();
    // The current token is dead too — the copy and the real device both lose.
    expect(await auth.refreshSession(second.refresh_token, req)).toBeNull();
    expect((await session(first.session_id)).revoked_at).not.toBeNull();
  });

  it('writes the reuse to the activity log with where it came from', async () => {
    const before = (await reuseEvents()).length;
    const first = await auth.createSession(user, req);
    await auth.refreshSession(first.refresh_token, req);
    await auth.refreshSession(first.refresh_token, { headers: { 'user-agent': 'stolen-copy' }, ip: '203.0.113.9' });
    const events = await reuseEvents();
    expect(events.length).toBe(before + 1);
    const details = JSON.parse(events[events.length - 1].details);
    expect(details.session_id).toBe(first.session_id);
    expect(details.ip).toBe('203.0.113.9');
    expect(details.user_agent).toContain('stolen-copy');
  });

  it('does not touch other sessions of the same person', async () => {
    const other = await auth.createSession(user, req);
    const first = await auth.createSession(user, req);
    await auth.refreshSession(first.refresh_token, req);
    await auth.refreshSession(first.refresh_token, req);
    expect((await session(other.session_id)).revoked_at).toBeNull();
    expect(await auth.refreshSession(other.refresh_token, req)).not.toBeNull();
  });

  it('a token that was never issued is simply refused', async () => {
    expect(await auth.refreshSession('not-a-real-token-at-all', req)).toBeNull();
  });

  it('a session that was signed out stays signed out, retired token or not', async () => {
    const first = await auth.createSession(user, req);
    const second = await auth.refreshSession(first.refresh_token, req);
    await auth.revokeSession(first.session_id);
    expect(await auth.refreshSession(second.refresh_token, req)).toBeNull();
    const before = (await reuseEvents()).length;
    expect(await auth.refreshSession(first.refresh_token, req)).toBeNull();
    // Already revoked: nothing new to report.
    expect((await reuseEvents()).length).toBe(before);
  });
});
