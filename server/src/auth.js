// Sign-in sessions.
//
// A sign-in creates a row in `sessions` and hands the app two things:
//   - an access token: a short-lived JWT (1 hour) sent as "Authorization: Bearer ..." on every request
//   - a refresh token: a long random string (30 days, rotated on every use) that mints new access tokens
// Every request checks that the session row is still there and not revoked, so "sign out everywhere",
// deactivating an account or changing a password takes effect immediately, not when the JWT expires.
//
// Tokens never travel in URLs. Browser downloads that cannot send a header (a PDF opened in a new tab, the
// CSV export) use a "ticket": a 2-minute JWT bound to one exact path, obtained with POST /api/auth/ticket.
import jwt from 'jsonwebtoken';
import { db, nowIso } from './db.js';
import { loadJwtSecret } from './secret.js';
import { randomToken, hashToken } from './passwords.js';

const SECRET = loadJwtSecret();
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_DAYS = 30;
const TICKET_TTL_SECONDS = 120;

export function signAccessToken(user, sessionId) {
  return jwt.sign({ sub: String(user.id), sid: sessionId, typ: 'access' }, SECRET, { expiresIn: ACCESS_TTL_SECONDS });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}

// ---------- the half-way token, between password and second factor ----------
const TWOFA_TTL_SECONDS = 5 * 60;
/** Proof that the password was right, and nothing else. No session, so it cannot open any other endpoint. */
export function signTwofaToken(user) {
  return jwt.sign({ sub: String(user.id), typ: '2fa' }, SECRET, { expiresIn: TWOFA_TTL_SECONDS });
}
/** The user id it was issued for, or null when it is expired, forged or a token of some other kind. */
export function readTwofaToken(token) {
  try {
    const payload = verifyToken(token);
    return payload.typ === '2fa' ? Number(payload.sub) : null;
  } catch {
    return null;
  }
}

/** Strips secrets and internal columns from a users row and adds derived fields. */
export function publicUser(row) {
  if (!row) return null;
  // eslint-disable-next-line no-unused-vars
  const { password_hash, avatar_path, revoked_at, session_expires_at, totp_secret, totp_last_step, ...rest } = row;
  return {
    ...rest,
    must_change_password: !!row.must_change_password,
    // Whether it is on, and which way, is worth telling the app; the secret itself never leaves the server.
    totp_enabled: !!row.totp_enabled,
    twofa_method: row.twofa_method === 'email' ? 'email' : 'app',
    avatar_url: avatar_path ? `/api/auth/avatar/${row.id}` : null,
  };
}

export function loadUser(id) {
  return db.get(
    `SELECT u.*, d.name AS department_name, c.name AS company_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [id]
  );
}

/** The user for an access/ticket payload, joined with its session so revocation is checked in one query. */
async function loadSessionUser(payload) {
  if (!payload || !payload.sid || !payload.sub) return null;
  const row = await db.get(
    `SELECT u.*, d.name AS department_name, c.name AS company_name, s.revoked_at, s.expires_at AS session_expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN companies c ON c.id = u.company_id
     WHERE s.id = ? AND u.id = ?`,
    [Number(payload.sid) || 0, Number(payload.sub) || 0]
  );
  if (!row || row.revoked_at || row.session_expires_at <= nowIso()) return null;
  return row;
}

// ---------- sessions ----------
function clientInfo(req) {
  return { user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 200), ip: String(req?.ip || '').slice(0, 64) };
}

/** Creates a session for a freshly authenticated user. Returns the token pair the app stores. */
export async function createSession(user, req) {
  const refresh = randomToken(32);
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000).toISOString();
  const { user_agent, ip } = clientInfo(req);
  const { id } = await db.run('INSERT INTO sessions (user_id, token_hash, expires_at, last_used_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [
    user.id,
    hashToken(refresh),
    expires,
    nowIso(),
    user_agent,
    ip,
  ]);
  return { token: signAccessToken(user, id), refresh_token: refresh, expires_in: ACCESS_TTL_SECONDS, session_id: id };
}

/**
 * Exchanges a refresh token for a new access token + a NEW refresh token (the old one stops working).
 * Returns null when the token is unknown, expired or revoked, or the account is inactive.
 */
export async function refreshSession(refreshToken, req) {
  const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(refreshToken)]);
  if (!s || s.revoked_at || s.expires_at <= nowIso()) return null;
  const user = await loadUser(s.user_id);
  if (!user || !user.active) return null;
  const next = randomToken(32);
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000).toISOString();
  const { user_agent, ip } = clientInfo(req);
  await db.run('UPDATE sessions SET token_hash = ?, expires_at = ?, last_used_at = ?, user_agent = ?, ip = ? WHERE id = ?', [
    hashToken(next),
    expires,
    nowIso(),
    user_agent,
    ip,
    s.id,
  ]);
  return { token: signAccessToken(user, s.id), refresh_token: next, expires_in: ACCESS_TTL_SECONDS, session_id: s.id, user };
}

export function revokeSession(sessionId) {
  return db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso(), sessionId]);
}

/** Signs a user out everywhere (optionally keeping one session, e.g. the one that changed the password). */
export function revokeUserSessions(userId, { except = null } = {}) {
  return except
    ? db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [nowIso(), userId, except])
    : db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
}

export function listSessions(userId) {
  return db.all('SELECT id, created_at, last_used_at, user_agent, ip FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC', [
    userId,
    nowIso(),
  ]);
}

/** Housekeeping: forget sessions and reset links that expired more than a week ago. Called by the scheduler. */
export async function purgeExpired() {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  await db.run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [cutoff, cutoff]);
  await db.run('DELETE FROM password_resets WHERE expires_at < ?', [cutoff]);
}

// ---------- tickets (one-off download links) ----------
export function signTicket(user, sessionId, path) {
  return jwt.sign({ sub: String(user.id), sid: sessionId, typ: 'ticket', path }, SECRET, { expiresIn: TICKET_TTL_SECONDS });
}

/** The request path + query without the ticket parameter, which is what a ticket is bound to. */
function ticketPathOf(req) {
  const url = new URL(req.originalUrl, 'http://x');
  url.searchParams.delete('ticket');
  const q = url.searchParams.toString();
  return url.pathname + (q ? `?${q}` : '');
}

// ---------- middleware ----------
// While a password change is required, only these endpoints work.
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout', '/api/auth/logout-all', '/api/auth/refresh', '/api/auth/sessions']);

async function attachUser(req, res, next, payload) {
  // A ticket or the half-way two-factor token is signed by the same key; only a real session gets in here.
  if (payload.typ === '2fa') return res.status(401).json({ error: 'Not signed in' });
  const row = await loadSessionUser(payload);
  if (!row) return res.status(401).json({ error: 'Session expired, please sign in again' });
  if (!row.active) return res.status(401).json({ error: 'Account not active' });
  req.user = publicUser(row);
  req.sessionId = Number(payload.sid);
  if (req.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.has(req.path === '/' ? req.baseUrl : req.baseUrl + req.path)) {
    return res.status(403).json({ error: 'Choose a new password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

/** Express middleware: requires a valid access token in the Authorization header. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  if (payload.typ !== 'access') return res.status(401).json({ error: 'Not signed in' });
  try {
    await attachUser(req, res, next, payload);
  } catch (err) {
    next(err);
  }
}

/** Like requireAuth, but a file route may also be opened with ?ticket= from POST /api/auth/ticket. */
export async function requireAuthOrTicket(req, res, next) {
  if ((req.headers.authorization || '').startsWith('Bearer ')) return requireAuth(req, res, next);
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  if (!ticket) return res.status(401).json({ error: 'Not signed in' });
  let payload;
  try {
    payload = verifyToken(ticket);
  } catch {
    return res.status(401).json({ error: 'This download link has expired. Open the file again from the app.' });
  }
  if (payload.typ !== 'ticket' || payload.path !== ticketPathOf(req)) return res.status(401).json({ error: 'Invalid download link' });
  try {
    await attachUser(req, res, next, payload);
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

/** Admins and company managers. Managers can post and manage things for their own company only. */
export function requireStaff(req, res, next) {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Only admins and managers can do this' });
  next();
}
export function isStaff(user) {
  return user?.role === 'admin' || user?.role === 'manager';
}
/** The company a staff member is limited to: null for admins (everything), the manager's company otherwise. */
export function companyScope(user) {
  return user?.role === 'manager' ? (user.company_id ?? -1) : null;
}
/** Can this staff member edit/delete a row that has company_id? Admins: always. Managers: only their own company's rows. */
export function canManage(user, row) {
  if (!row) return false;
  if (user?.role === 'admin') return true;
  return user?.role === 'manager' && row.company_id != null && row.company_id === user.company_id;
}

/** Wraps an async route handler so thrown errors reach the Express error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
