import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codes sent by email: this one really does query, against a throwaway SQLite file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upnotice-emailcode-'));
process.env.JWT_SECRET = 'unit-test-secret-that-is-long-enough-0123456789';
process.env.DATABASE_URL = '';
process.env.DB_FILE = path.join(dir, 'codes.db');

let db, mod;

beforeAll(async () => {
  const dbModule = await import('../../src/db.js');
  db = dbModule.db;
  await dbModule.initDb();
  mod = await import('../../src/emailcode.js');
  await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Tester', 'tester@example.com', 'x', 'employee')");
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked for a moment; the temp folder is cleared by the OS anyway. */
  }
});

/** Puts a code straight into the table, the way sendEmailCode would if email were set up here. */
async function put(code, { purpose = 'login', expiresInMs = mod.CODE_TTL_MS, createdMsAgo = 0 } = {}) {
  await db.run('DELETE FROM email_codes WHERE user_id = 1 AND purpose = ?', [purpose]);
  await db.run('INSERT INTO email_codes (user_id, purpose, code_hash, expires_at, created_at) VALUES (1, ?, ?, ?, ?)', [
    purpose,
    mod.hashEmailCode(code),
    new Date(Date.now() + expiresInMs).toISOString(),
    new Date(Date.now() - createdMsAgo).toISOString(),
  ]);
}

beforeEach(async () => {
  await db.run('DELETE FROM email_codes');
});

describe('generateEmailCode', () => {
  it('is always six digits, leading zeros kept', () => {
    for (let i = 0; i < 200; i++) expect(mod.generateEmailCode()).toMatch(/^\d{6}$/);
  });

  it('does not hand out the same code twice in a row', () => {
    const codes = new Set(Array.from({ length: 50 }, () => mod.generateEmailCode()));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('maskEmail', () => {
  it('shows the first and last letter of the name and the whole domain', () => {
    expect(mod.maskEmail('kian@gmail.com')).toBe('k••n@gmail.com');
  });

  it('does not spell out a long name', () => {
    expect(mod.maskEmail('administrator@company.com')).toBe('a••••••r@company.com');
  });

  it('copes with a very short name', () => {
    expect(mod.maskEmail('jo@company.com')).toBe('j@company.com');
  });
});

describe('useEmailCode', () => {
  it('accepts the right code once', async () => {
    await put('123456');
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(true);
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(false);
  });

  it('ignores spaces people paste in', async () => {
    await put('123456');
    expect(await mod.useEmailCode(1, 'login', '123 456')).toBe(true);
  });

  it('refuses a code meant for something else', async () => {
    await put('123456', { purpose: 'setup' });
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(false);
    expect(await mod.useEmailCode(1, 'setup', '123456')).toBe(true);
  });

  it('refuses an expired code and forgets it', async () => {
    await put('123456', { expiresInMs: -1000 });
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(false);
    expect(await db.get('SELECT 1 AS n FROM email_codes WHERE user_id = 1')).toBeFalsy();
  });

  it('throws the code away after five wrong guesses', async () => {
    await put('123456');
    for (let i = 0; i < mod.MAX_ATTEMPTS; i++) expect(await mod.useEmailCode(1, 'login', '000000')).toBe(false);
    // Even the right code is no good now: a new one has to be sent.
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(false);
  });

  it('lets the right code through after a few wrong ones', async () => {
    await put('123456');
    await mod.useEmailCode(1, 'login', '000000');
    await mod.useEmailCode(1, 'login', '111111');
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(true);
  });

  it('says no when nothing was ever sent', async () => {
    expect(await mod.useEmailCode(1, 'login', '123456')).toBe(false);
  });
});

describe('resendWait', () => {
  it('asks for a pause straight after a code was sent', async () => {
    await put('123456');
    const wait = await mod.resendWait(1, 'login');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(mod.RESEND_AFTER_MS / 1000);
  });

  it('is over once the gap has passed', async () => {
    await put('123456', { createdMsAgo: mod.RESEND_AFTER_MS + 1000 });
    expect(await mod.resendWait(1, 'login')).toBe(0);
  });

  it('has nothing to wait for when no code is outstanding', async () => {
    expect(await mod.resendWait(1, 'login')).toBe(0);
  });
});

describe('sendEmailCode', () => {
  it('does not pretend to have sent anything when email is not set up', async () => {
    const r = await mod.sendEmailCode({ id: 1, name: 'Tester', email: 'tester@example.com' }, 'login');
    expect(r.sent).toBe(false);
    expect(r.error).toMatch(/not set up/i);
    // And nothing is left behind that could be guessed at.
    expect(await db.get('SELECT 1 AS n FROM email_codes WHERE user_id = 1')).toBeFalsy();
  });
});

describe('purgeExpiredEmailCodes', () => {
  it('clears out codes nobody used', async () => {
    await put('123456', { expiresInMs: -1000, purpose: 'login' });
    await put('654321', { purpose: 'setup' });
    expect(await mod.purgeExpiredEmailCodes()).toBe(1);
    expect(await db.get("SELECT 1 AS n FROM email_codes WHERE purpose = 'setup'")).toBeTruthy();
  });
});
