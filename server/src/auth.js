import jwt from 'jsonwebtoken';
import { db } from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: '30d' });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

export function publicUser(row) {
  if (!row) return null;
  const { password_hash, avatar_path, ...rest } = row;
  return { ...rest, avatar_url: avatar_path ? `/api/auth/avatar/${row.id}` : null };
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

/** Express middleware: requires a valid Bearer token (or ?token= for SSE). */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  try {
    const user = await loadUser(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Account not active' });
    req.user = publicUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

/** Wraps an async route handler so thrown errors reach the Express error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
