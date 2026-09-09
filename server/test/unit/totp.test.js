import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateSecret,
  codeForStep,
  currentCode,
  verifyCode,
  otpauthUrl,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  stepFor,
  STEP_SECONDS,
} from '../../src/totp.js';

// RFC 4648 test vectors for base32.
describe('base32', () => {
  it('matches the RFC', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });
  it('survives a round trip of random bytes', () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255, 42, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
  it('forgives the spaces people paste in, and refuses real rubbish', () => {
    expect(base32Decode('MZXW 6YTB OI').toString()).toBe('foobar');
    expect(() => base32Decode('not-base32!')).toThrow();
  });
});

// RFC 6238 Appendix B, the SHA-1 rows. The published secret is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
describe('TOTP against the RFC 6238 test vectors', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [seconds, expected] of vectors) {
    it(`t=${seconds} gives ${expected}`, () => {
      expect(codeForStep(RFC_SECRET, Math.floor(seconds / STEP_SECONDS))).toBe(expected);
    });
  }
});

describe('verifyCode', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;

  it('accepts the code showing right now', () => {
    expect(verifyCode(secret, currentCode(secret, now), { atMs: now })).toBe(stepFor(now));
  });

  it('accepts one step either side, for clock drift and slow typing', () => {
    const before = codeForStep(secret, stepFor(now) - 1);
    const after = codeForStep(secret, stepFor(now) + 1);
    expect(verifyCode(secret, before, { atMs: now })).toBe(stepFor(now) - 1);
    expect(verifyCode(secret, after, { atMs: now })).toBe(stepFor(now) + 1);
  });

  it('refuses codes further away than that', () => {
    expect(verifyCode(secret, codeForStep(secret, stepFor(now) - 2), { atMs: now })).toBeNull();
    expect(verifyCode(secret, codeForStep(secret, stepFor(now) + 2), { atMs: now })).toBeNull();
  });

  it('refuses a code that has already been used', () => {
    const step = stepFor(now);
    const code = codeForStep(secret, step);
    expect(verifyCode(secret, code, { atMs: now })).toBe(step);
    // Second time round, with the account remembering that step: spent.
    expect(verifyCode(secret, code, { atMs: now, afterStep: step })).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 ', null, undefined]) {
      expect(verifyCode(secret, bad, { atMs: now })).toBeNull();
    }
  });

  it('refuses a code from somebody else’s secret', () => {
    expect(verifyCode(secret, currentCode(generateSecret(), now), { atMs: now })).toBeNull();
  });
});

describe('otpauth URL', () => {
  it('carries what an authenticator app needs', () => {
    const url = new URL(otpauthUrl('ABCDEFGH', { account: 'maria@company.com' }));
    expect(url.protocol).toBe('otpauth:');
    expect(decodeURIComponent(url.pathname)).toContain('UpNotice:maria@company.com');
    expect(url.searchParams.get('secret')).toBe('ABCDEFGH');
    expect(url.searchParams.get('issuer')).toBe('UpNotice');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
  });
});

describe('secret storage', () => {
  const appSecret = 'a-long-enough-application-secret-0123456789';

  it('round-trips through encryption', () => {
    const secret = generateSecret();
    const stored = encryptSecret(secret, appSecret);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, appSecret)).toBe(secret);
  });

  it('gives a different ciphertext every time, so equal secrets do not look equal', () => {
    const secret = generateSecret();
    expect(encryptSecret(secret, appSecret)).not.toBe(encryptSecret(secret, appSecret));
  });

  it('returns null rather than throwing when the key is wrong or the row was tampered with', () => {
    const stored = encryptSecret(generateSecret(), appSecret);
    expect(decryptSecret(stored, 'a-different-application-secret-0123456789')).toBeNull();
    expect(decryptSecret(stored.slice(0, -4) + 'AAAA', appSecret)).toBeNull();
    expect(decryptSecret('not-even-close', appSecret)).toBeNull();
  });

  it('refuses to work with a short application secret', () => {
    expect(() => encryptSecret(generateSecret(), 'short')).toThrow(/JWT_SECRET/);
  });
});

describe('recovery codes', () => {
  it('makes ten distinct, readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
      expect(code).not.toMatch(/[01OI]/); // nothing that can be misread off a printed sheet
    }
  });

  it('hashes the same way whatever the case or spacing', () => {
    const [code] = generateRecoveryCodes(1);
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(` ${code} `)).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });
});
