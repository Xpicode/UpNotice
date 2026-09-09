// Rate limits and the sign-in lockout. Everything here is per process (in memory), which is right for a
// single UpNotice server. Behind a reverse proxy set TRUST_PROXY=1 so the real client address is used.
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

const json = (req, res, next, options) => res.status(options.statusCode).json({ error: options.message });
const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler: json, validate: { xForwardedForHeader: false, trustProxy: false } };
const byUser = (req) => (req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip));

/** Whole API: generous, only stops runaway scripts. */
export const apiLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 600, message: 'Too many requests — slow down a little' });

/** Sign-in attempts per address (the per-account lockout below is the main defence). */
export const loginLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 30, message: 'Too many sign-in attempts from this address. Try again in 15 minutes.' });

/** Second-factor guesses per address: six digits is only 1,000,000 tries, so this one matters. */
export const twofaLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 20, message: 'Too many codes tried. Wait 15 minutes and sign in again.' });

/** Forgot-password emails per address. */
/** Asking the server to email a fresh sign-in code. The 30-second gap between codes is enforced separately. */
export const codeSendLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 10, message: 'Too many codes asked for. Wait 15 minutes and sign in again.' });

export const forgotLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 5, message: 'Too many reset requests. Try again in an hour.' });

/** Reset-token guesses per address. */
export const resetLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 10, message: 'Too many attempts. Request a new reset link.' });

/** Token refreshes per address (a stolen refresh token cannot be brute-forced anyway; this just caps noise). */
export const refreshLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 60, message: 'Too many requests' });

/** Meeting check-in code guesses per signed-in user. */
export const checkinLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 12, keyGenerator: byUser, message: 'Too many wrong codes. Wait 10 minutes and try again.' });

/** Download tickets per signed-in user. */
export const ticketLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 120, keyGenerator: byUser, message: 'Too many downloads at once' });

/** Uploads (attachments, photos, imports) per signed-in user. */
export const uploadLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 60, keyGenerator: byUser, message: 'Too many uploads. Wait a few minutes.' });

// ---------- per-account lockout ----------
// 10 wrong passwords within 15 minutes lock the account for 15 minutes (any address). A correct password
// during the lockout is still refused, so a guesser gains nothing by finding it late.
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 10;
const failures = new Map(); // email -> { count, first, lockedUntil }

function entry(email) {
  const key = String(email || '')
    .trim()
    .toLowerCase();
  let e = failures.get(key);
  const now = Date.now();
  if (e && e.lockedUntil && e.lockedUntil <= now) e = null; // lock expired
  if (e && !e.lockedUntil && now - e.first > WINDOW_MS) e = null; // window expired
  if (!e) {
    e = { count: 0, first: now, lockedUntil: 0 };
    failures.set(key, e);
  }
  return e;
}

/** Seconds until the account may try again, or 0 when it is not locked. */
export function lockedFor(email) {
  const e = entry(email);
  return e.lockedUntil ? Math.max(1, Math.ceil((e.lockedUntil - Date.now()) / 1000)) : 0;
}

/** Records a wrong password. Returns the number of attempts left before the lock (0 = now locked). */
export function recordFailure(email) {
  const e = entry(email);
  e.count++;
  if (e.count >= MAX_FAILURES) {
    e.lockedUntil = Date.now() + LOCK_MS;
    return 0;
  }
  return MAX_FAILURES - e.count;
}

export function clearFailures(email) {
  failures.delete(
    String(email || '')
      .trim()
      .toLowerCase()
  );
}

// Forget stale entries now and then so the map cannot grow without bound.
setInterval(
  () => {
    const now = Date.now();
    for (const [k, e] of failures) if ((e.lockedUntil && e.lockedUntil <= now) || (!e.lockedUntil && now - e.first > WINDOW_MS)) failures.delete(k);
  },
  5 * 60 * 1000
).unref();
