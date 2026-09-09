import { describe, it, expect } from 'vitest';
import { checkConfig, checkLive } from '../../../scripts/preflight.mjs';

const level = (results, name) => results.find((r) => r.name === name)?.level;

// A deployment that has been done properly, used as the starting point for each test below.
const GOOD = {
  JWT_SECRET: 'k'.repeat(48),
  APP_PUBLIC_URL: 'https://notice.example.com',
  TRUST_PROXY: '1',
  DATABASE_URL: 'postgres://u:p@db.example.com:5432/upnotice',
  RESEND_API_KEY: 're_test',
  FIREBASE_SERVICE_ACCOUNT: './firebase.json',
};

describe('preflight config checks', () => {
  it('passes a deployment that was set up properly', () => {
    const results = checkConfig(GOOD);
    expect(results.filter((r) => r.level !== 'PASS')).toEqual([]);
  });

  it('blocks a missing, short or example signing key', () => {
    expect(level(checkConfig({ ...GOOD, JWT_SECRET: '' }), 'JWT_SECRET')).toBe('FAIL');
    expect(level(checkConfig({ ...GOOD, JWT_SECRET: 'too-short' }), 'JWT_SECRET')).toBe('FAIL');
    expect(level(checkConfig({ ...GOOD, JWT_SECRET: 'change-this-to-a-long-random-string' }), 'JWT_SECRET')).toBe('FAIL');
  });

  it('blocks demo accounts and a wide-open CORS setting', () => {
    expect(level(checkConfig({ ...GOOD, SEED_DEMO: '1' }), 'SEED_DEMO')).toBe('FAIL');
    expect(level(checkConfig({ ...GOOD, CORS_ORIGIN: '*' }), 'CORS_ORIGIN')).toBe('FAIL');
  });

  it('blocks a public address that is not https, but allows localhost', () => {
    expect(level(checkConfig({ ...GOOD, APP_PUBLIC_URL: '' }), 'APP_PUBLIC_URL')).toBe('FAIL');
    expect(level(checkConfig({ ...GOOD, APP_PUBLIC_URL: 'http://notice.example.com' }), 'APP_PUBLIC_URL')).toBe('FAIL');
    expect(level(checkConfig({ ...GOOD, APP_PUBLIC_URL: 'http://localhost:4000' }), 'APP_PUBLIC_URL')).toBe('PASS');
  });

  it('warns when nothing tells the server it is behind a proxy', () => {
    const { TRUST_PROXY, ...noProxy } = GOOD;
    expect(TRUST_PROXY).toBe('1');
    expect(level(checkConfig(noProxy), 'TRUST_PROXY')).toBe('WARN');
  });

  it('judges the database by how it is reached', () => {
    const { DATABASE_URL, ...noDb } = GOOD;
    expect(DATABASE_URL).toContain('postgres');
    expect(level(checkConfig(noDb), 'DATABASE_URL')).toBe('WARN'); // SQLite: fine small, not forever
    expect(level(checkConfig({ ...GOOD, DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x' }), 'DATABASE_URL')).toBe('PASS');
    expect(level(checkConfig({ ...GOOD, DATABASE_URL: 'postgres://u:p@far.example.com/x?sslmode=disable' }), 'DATABASE_URL')).toBe('FAIL');
  });

  it('has an opinion about the first admin password', () => {
    expect(level(checkConfig({ ...GOOD, ADMIN_PASSWORD: 'admin123' }), 'ADMIN_PASSWORD')).toBe('FAIL');
    expect(level(checkConfig({ ...GOOD, ADMIN_PASSWORD: 'a-long-one-nobody-guesses' }), 'ADMIN_PASSWORD')).toBe('WARN');
    expect(level(checkConfig(GOOD), 'ADMIN_PASSWORD')).toBeUndefined();
  });

  it('warns when email or push are not set up', () => {
    const { RESEND_API_KEY, FIREBASE_SERVICE_ACCOUNT, ...bare } = GOOD;
    expect(RESEND_API_KEY && FIREBASE_SERVICE_ACCOUNT).toBeTruthy();
    expect(level(checkConfig(bare), 'Email')).toBe('WARN');
    expect(level(checkConfig(bare), 'Push')).toBe('WARN');
    expect(level(checkConfig({ ...bare, SMTP_HOST: 'smtp.example.com' }), 'Email')).toBe('PASS');
  });
});

/** A stand-in server, so the live checks can be tested without one. */
function fakeServer({ headers = {}, loginStatus = 401 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/api/health'))
      return { headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => ({ ok: true, name: 'UpNotice', version: '4.0.0', database: 'postgres' }) };
    if (url.endsWith('/api/auth/login')) return { status: loginStatus, json: async () => (loginStatus === 200 ? { token: 'demo-token' } : {}) };
    return { status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const SAFE_HEADERS = { 'strict-transport-security': 'max-age=15552000', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" };

describe('preflight live checks', () => {
  it('passes a hardened server that rejects the demo password', async () => {
    const { fetchImpl } = fakeServer({ headers: SAFE_HEADERS });
    const results = await checkLive('https://notice.example.com', fetchImpl);
    expect(results.filter((r) => r.level !== 'PASS')).toEqual([]);
  });

  it('blocks a server where the demo password still works, and closes the session it opened', async () => {
    const { fetchImpl, calls } = fakeServer({ headers: SAFE_HEADERS, loginStatus: 200 });
    const results = await checkLive('https://notice.example.com', fetchImpl);
    expect(level(results, 'Demo account')).toBe('FAIL');
    expect(calls.some((call) => call.url.endsWith('/api/auth/logout') && call.method === 'POST')).toBe(true);
  });

  it('blocks missing security headers', async () => {
    const { fetchImpl } = fakeServer({ headers: {} });
    const results = await checkLive('https://notice.example.com', fetchImpl);
    expect(level(results, 'HSTS')).toBe('FAIL');
    expect(level(results, 'nosniff')).toBe('FAIL');
    expect(level(results, 'CSP')).toBe('WARN');
  });

  it('does not ask for HSTS on a plain http address', async () => {
    const { fetchImpl } = fakeServer({ headers: { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'" } });
    const results = await checkLive('http://localhost:4000', fetchImpl);
    expect(level(results, 'HSTS')).toBeUndefined();
  });

  it('reports a server that does not answer', async () => {
    const results = await checkLive('https://down.example.com', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(level(results, 'Reachable')).toBe('FAIL');
  });
});
