import { describe, it, expect } from 'vitest';
import { passwordProblem, generatePassword, randomToken, hashToken, MIN_PASSWORD_LENGTH } from '../../src/passwords.js';

describe('passwordProblem', () => {
  it('rejects short passwords', () => {
    expect(passwordProblem('Abc1234')).toMatch(/at least/);
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least/);
  });
  it('rejects common and trivial passwords', () => {
    expect(passwordProblem('password')).toMatch(/common/);
    expect(passwordProblem('Admin123')).toMatch(/common/);
    expect(passwordProblem('aaaaaaaa')).toMatch(/repeated/);
  });
  it("rejects the person's own email or name", () => {
    expect(passwordProblem('maria@company.com', { email: 'maria@company.com' })).toMatch(/email/);
    expect(passwordProblem('mariasantos', { name: 'Maria Santos' })).toMatch(/name/);
  });
  it('accepts a reasonable password', () => {
    expect(passwordProblem('Blue-Kettle-42', { email: 'x@y.com', name: 'X Y' })).toBeNull();
  });
  it('rejects absurdly long passwords', () => {
    expect(passwordProblem('x'.repeat(200))).toMatch(/at most/);
  });
});

describe('generators', () => {
  it('generates readable passwords of the requested length without look-alike characters', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(10);
      expect(p).toHaveLength(10);
      expect(p).not.toMatch(/[0O1lI]/);
      expect(passwordProblem(p)).toBeNull();
    }
  });
  it('random tokens are unique and URL-safe', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('hashToken is deterministic sha256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashToken('abc')).toEqual(hashToken('abc'));
  });
});
