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
  return user?.role === 'manager' ? user.company_id ?? -1 : null;
}
/** Can this staff member edit/delete a row that has company_id? Admins: always. Managers: only their own company's rows. */
export function canManage(user, row) {
  if (!row) return false;
  if (user?.role === 'admin') return true;
  return user?.role === 'manager' && row.company_id != null && row.company_id === user.company_id;
}

/** Wraps an async route handler so thrown errors reach the Express error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
