// Password rules and generators. Used by sign-up, password change/reset, the admin user form and the import.
import crypto from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

// The handful of passwords people reach for first; a long list is not needed because the lockout limits guessing.
const COMMON = new Set([
  'password',
  'password1',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'iloveyou',
  'sunshine',
  'admin123',
  'admin1234',
  'welcome1',
  'welcome123',
  'letmein1',
  'abcd1234',
  'changeme',
  'upnotice',
  'upnotice1',
  'football',
  'baseball',
]);

/**
 * Returns a human-readable problem with the password, or null when it is acceptable.
 * `about` may carry the person's email and name so the password cannot simply be one of those.
 */
export function passwordProblem(password, about = {}) {
  const p = String(password ?? '');
  if (p.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (p.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const lower = p.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common — choose something harder to guess';
  if (/^(.)\1+$/.test(p)) return 'Password cannot be one repeated character';
  const email = String(about.email || '').toLowerCase();
  if (email && (lower === email || lower === email.split('@')[0])) return 'Password cannot be your email address';
  const name = String(about.name || '')
    .toLowerCase()
    .trim();
  if (name && name.length >= 4 && lower === name.replace(/\s+/g, '')) return 'Password cannot be your name';
  return null;
}

// Letters and digits without look-alikes (0/O, 1/l/I) so a generated password can be read out or typed from paper.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random, readable temporary password (e.g. "k7Rw2pXq4M"). Uses the OS random source, never Math.random. */
export function generatePassword(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** Random URL-safe secret for refresh tokens, reset links and the like. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex of a token — what we store, so a database leak does not hand out live tokens. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
