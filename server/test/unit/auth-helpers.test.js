import { describe, it, expect, beforeAll } from 'vitest';

// auth.js needs a signing secret and the database module (not opened here — the helpers below never query).
process.env.JWT_SECRET = 'unit-test-secret-that-is-long-enough-0123456789';
let auth;
beforeAll(async () => {
  auth = await import('../../src/auth.js');
});

const admin = { id: 1, role: 'admin', company_id: null };
const manager = { id: 2, role: 'manager', company_id: 10 };
const employee = { id: 3, role: 'employee', company_id: 10 };

describe('roles', () => {
  it('isStaff / companyScope', () => {
    expect(auth.isStaff(admin)).toBe(true);
    expect(auth.isStaff(manager)).toBe(true);
    expect(auth.isStaff(employee)).toBe(false);
    expect(auth.companyScope(admin)).toBeNull();
    expect(auth.companyScope(manager)).toBe(10);
    expect(auth.companyScope({ role: 'manager', company_id: null })).toBe(-1);
  });
  it('canManage: admins everything, managers only their own company, employees nothing', () => {
    const ownRow = { company_id: 10 };
    const otherRow = { company_id: 11 };
    const globalRow = { company_id: null };
    expect(auth.canManage(admin, otherRow)).toBe(true);
    expect(auth.canManage(manager, ownRow)).toBe(true);
    expect(auth.canManage(manager, otherRow)).toBe(false);
    expect(auth.canManage(manager, globalRow)).toBe(false);
    expect(auth.canManage(employee, ownRow)).toBe(false);
    expect(auth.canManage(admin, null)).toBe(false);
  });
});

describe('tokens', () => {
  it('access tokens carry the session id and expire in an hour', () => {
    const t = auth.signAccessToken({ id: 7 }, 42);
    const p = auth.verifyToken(t);
    expect(p).toMatchObject({ sub: '7', sid: 42, typ: 'access' });
    expect(p.exp - p.iat).toBe(auth.ACCESS_TTL_SECONDS);
  });
  it('tickets are bound to one path and are not access tokens', () => {
    const t = auth.signTicket({ id: 7 }, 42, '/api/meetings/3/ics');
    const p = auth.verifyToken(t);
    expect(p).toMatchObject({ sub: '7', sid: 42, typ: 'ticket', path: '/api/meetings/3/ics' });
    expect(p.exp - p.iat).toBeLessThanOrEqual(120);
  });
  it('rejects tampered tokens', () => {
    const t = auth.signAccessToken({ id: 7 }, 42);
    expect(() => auth.verifyToken(t.slice(0, -2) + 'xx')).toThrow();
  });
  it('publicUser never exposes the password hash and adds derived fields', () => {
    const u = auth.publicUser({ id: 1, name: 'A', password_hash: 'secret', avatar_path: 'x.png', must_change_password: 1, revoked_at: null, session_expires_at: 'x' });
    expect(u.password_hash).toBeUndefined();
    expect(u.revoked_at).toBeUndefined();
    expect(u).toMatchObject({ must_change_password: true, avatar_url: '/api/auth/avatar/1' });
  });
});
