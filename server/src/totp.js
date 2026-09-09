// Two-factor authentication: time-based one-time passwords (TOTP, RFC 6238) — the six digits an
// authenticator app shows. Written against the RFC with node:crypto rather than pulled from npm: it is
// forty lines, and an authentication dependency is the last place you want a supply-chain surprise.
//
// The secret is kept encrypted in the database. The key comes from JWT_SECRET, which lives in .env and
// never in the database, so a leaked database dump on its own cannot generate anyone's codes.
import crypto from 'node:crypto';

const DIGITS = 6;
export const STEP_SECONDS = 30;
/** How many 30-second steps either side of now are accepted, for clocks that drift and slow typing. */
export const WINDOW_STEPS = 1;

// ---------- base32, the alphabet authenticator apps expect ----------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(text).toUpperCase().replace(/=+$/, '')) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      if (/\s|-/.test(char)) continue; // people paste secrets with spaces in
      throw new Error('Not a valid secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- the codes themselves ----------
/** A new random secret, as the base32 text an authenticator app takes. 20 bytes = 160 bits, per the RFC. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The counter value for a moment in time. Exported so tests can pin it. */
export function stepFor(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/** The six digits for one counter step. */
export function codeForStep(secretBase32, step) {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation: the low nibble of the last byte picks where to read the number from.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an app would be showing right now. */
export function currentCode(secretBase32, atMs = Date.now()) {
  return codeForStep(secretBase32, stepFor(atMs));
}

/**
 * Checks a typed code. Returns the step it matched (so the caller can refuse to accept that same step
 * twice — a code shoulder-surfed or read from a proxy log is then already spent), or null.
 * `afterStep` rejects anything at or below a step this account has already used.
 */
export function verifyCode(secretBase32, code, { atMs = Date.now(), afterStep = 0 } = {}) {
  const typed = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const now = stepFor(atMs);
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset++) {
    const step = now + offset;
    if (step <= afterStep) continue;
    const expected = codeForStep(secretBase32, step);
    // Same length either way, so a constant-time compare is safe to use here.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) return step;
  }
  return null;
}

/** The otpauth:// address that goes into the QR code the authenticator app scans. */
export function otpauthUrl(secretBase32, { account, issuer = 'UpNotice' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------- keeping the secret out of a database dump ----------
function keyFrom(appSecret) {
  if (!appSecret || appSecret.length < 32) throw new Error('JWT_SECRET must be set before two-factor authentication can be used');
  // A fixed salt is fine: the input is already a long random secret, not a password.
  return crypto.scryptSync(appSecret, 'upnotice-totp', 32);
}

/** AES-256-GCM, stored as one string: iv.tag.ciphertext, all base64url. */
export function encryptSecret(secretBase32, appSecret = process.env.JWT_SECRET) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(appSecret), iv);
  const body = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** Returns null when the stored value cannot be read — a changed JWT_SECRET, or a tampered row. */
export function decryptSecret(stored, appSecret = process.env.JWT_SECRET) {
  try {
    const [iv, tag, body] = String(stored)
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(appSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------- recovery codes, for the day the phone is lost ----------
/** Ten single-use codes, shown once. Stored hashed, like passwords. */
export function generateRecoveryCodes(count = 10) {
  // Crockford-ish alphabet: no 0/O or 1/I to misread off a printed sheet.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const pick = () =>
    Array.from(crypto.randomBytes(10))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  return Array.from({ length: count }, () => `${pick().slice(0, 5)}-${pick().slice(0, 5)}`);
}

/** Recovery codes are single-use and high-entropy, so a plain SHA-256 is the right hash here. */
export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/\s/g, '')).digest('hex');
}
