// Companies, departments + user management (admin only, except listing).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, isUniqueViolation, insertMany } from '../db.js';
import { hashMany } from '../hash-pool.js';
import * as XLSX from 'xlsx';
import { requireAuth, requireAdmin, requireStaff, companyScope, publicUser, loadUser, wrap } from '../auth.js';
import { sheetUpload } from '../uploads.js';
import { logActivity } from '../activity.js';
import { notifyAll } from '../events.js';

const router = Router();
router.use(requireAuth);

/** Runs fn; a duplicate-key error becomes a 409 with the given message. */
async function orConflict(res, message, fn) {
  try {
    await fn();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    res.status(409).json({ error: message });
  }
}

// ---------- Companies ----------
router.get(
  '/companies',
  wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT c.id, c.name,
         (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1 AND u.role IN ('employee', 'manager')) AS member_count,
         (SELECT COUNT(*) FROM departments d WHERE d.company_id = c.id) AS department_count
       FROM companies c ORDER BY c.name`
    );
    res.json({ companies: rows });
  })
);

router.post(
  '/companies',
  requireAdmin,
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Company name is required' });
    await orConflict(res, 'A company with that name already exists', async () => {
      const { id } = await db.run('INSERT INTO companies (name) VALUES (?) RETURNING id', [name]);
      logActivity(req, 'company.create', 'company', id, { name });
      res.status(201).json({ company: { id, name, member_count: 0, department_count: 0 } });
    });
  })
);

router.patch(
  '/companies/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Company name is required' });
    await orConflict(res, 'A company with that name already exists', async () => {
      const info = await db.run('UPDATE companies SET name = ? WHERE id = ?', [name, Number(req.params.id) || 0]);
      if (!info.changes) return res.status(404).json({ error: 'Company not found' });
      logActivity(req, 'company.update', 'company', Number(req.params.id), { name });
      res.json({ ok: true });
    });
  })
);

router.delete(
  '/companies/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const employees = (await db.get("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role IN ('employee', 'manager')", [id])).n;
    if (employees > 0) {
      return res.status(400).json({ error: `This company still has ${employees} employee(s). Move or remove them first.` });
    }
    const c = await db.get('SELECT name FROM companies WHERE id = ?', [id]);
    await db.run('DELETE FROM companies WHERE id = ?', [id]);
    logActivity(req, 'company.delete', 'company', id, { name: c?.name });
    res.json({ ok: true });
  })
);

// ---------- Departments ----------
router.get(
  '/departments',
  wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT d.id, d.name, d.company_id, c.name AS company_name, COUNT(u.id) AS member_count
       FROM departments d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.department_id = d.id AND u.active = 1
       GROUP BY d.id, d.name, d.company_id, c.name ORDER BY c.name, d.name`
    );
    res.json({ departments: rows });
  })
);

router.post(
  '/departments',
  requireStaff,
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const company_id = Number(req.body?.company_id) || null;
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    if (!company_id) return res.status(400).json({ error: 'Choose which company the department belongs to' });
    const scope = companyScope(req.user);
    if (scope !== null && scope !== company_id) return res.status(403).json({ error: 'You can only add departments to your own company' });
    const company = await db.get('SELECT name FROM companies WHERE id = ?', [company_id]);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    await orConflict(res, 'That company already has a department with this name', async () => {
      const { id } = await db.run('INSERT INTO departments (name, company_id) VALUES (?, ?) RETURNING id', [name, company_id]);
      logActivity(req, 'department.create', 'department', id, { name, company: company.name });
      res.status(201).json({ department: { id, name, company_id, company_name: company.name, member_count: 0 } });
    });
  })
);

async function departmentInScope(req, res) {
  const d = await db.get('SELECT * FROM departments WHERE id = ?', [Number(req.params.id) || 0]);
  if (!d) {
    res.status(404).json({ error: 'Department not found' });
    return null;
  }
  const scope = companyScope(req.user);
  if (scope !== null && scope !== d.company_id) {
    res.status(403).json({ error: 'That department belongs to another company' });
    return null;
  }
  return d;
}

router.patch(
  '/departments/:id',
  requireStaff,
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const d = await departmentInScope(req, res);
    if (!d) return;
    await orConflict(res, 'That company already has a department with this name', async () => {
      await db.run('UPDATE departments SET name = ? WHERE id = ?', [name, d.id]);
      logActivity(req, 'department.update', 'department', d.id, { name, was: d.name });
      res.json({ ok: true });
    });
  })
);

router.delete(
  '/departments/:id',
  requireStaff,
  wrap(async (req, res) => {
    const d = await departmentInScope(req, res);
    if (!d) return;
    await db.run('DELETE FROM departments WHERE id = ?', [d.id]);
    logActivity(req, 'department.delete', 'department', d.id, { name: d.name });
    res.json({ ok: true });
  })
);

// ---------- Users ----------
const ROLES = ['admin', 'manager', 'employee'];

// List employees. Optional: ?q=search&company_id=&role=&limit=&offset= — with `limit` the answer also carries
// `total` so the app can page through thousands of people instead of downloading them all.
router.get(
  '/users',
  requireStaff,
  wrap(async (req, res) => {
    const scope = companyScope(req.user);
    const where = [];
    const params = [];
    if (scope !== null) {
      where.push('u.company_id = ?');
      params.push(scope);
    } else if (req.query.company_id) {
      where.push("(u.company_id = ? OR u.role = 'admin')");
      params.push(Number(req.query.company_id) || 0);
    }
    if (req.query.role && ROLES.includes(String(req.query.role))) {
      where.push('u.role = ?');
      params.push(String(req.query.role));
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) {
      where.push('(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Number(req.query.limit) || 0);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await db.all(
      `SELECT u.id, u.name, u.email, u.role, u.company_id, u.department_id, u.active, u.created_at, u.email_notifications,
              d.name AS department_name, c.name AS company_name,
              CASE WHEN u.avatar_path IS NULL THEN NULL ELSE '/api/auth/avatar/' || u.id END AS avatar_url
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN companies c ON c.id = u.company_id
       ${whereSql}
       ORDER BY u.active DESC, c.name, u.name, u.id
       ${limit ? `LIMIT ${limit} OFFSET ${offset}` : ''}`,
      params
    );
    const out = { users: rows };
    if (limit) out.total = (await db.get(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, params)).n;
    res.json(out);
  })
);

/** Managers may only create/edit employees of their own company (never admins or other managers). */
function userChangeAllowed(actor, role, company_id) {
  if (actor.role === 'admin') return null;
  if (role !== 'employee') return 'Managers can only add employees';
  if (company_id !== actor.company_id) return 'Managers can only add employees to their own company';
  return null;
}

/** Department must belong to the chosen company; returns an error string or null. */
async function checkDeptCompany(department_id, company_id) {
  if (!department_id) return null;
  const d = await db.get('SELECT company_id FROM departments WHERE id = ?', [department_id]);
  if (!d) return 'Department not found';
  if (d.company_id && d.company_id !== company_id) return 'That department belongs to a different company';
  return null;
}

router.post(
  '/users',
  requireStaff,
  wrap(async (req, res) => {
    const { name, email, password, role = 'employee' } = req.body || {};
    const company_id = Number(req.body?.company_id) || null;
    const department_id = Number(req.body?.department_id) || null;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role !== 'admin' && !company_id) return res.status(400).json({ error: `Choose a company for this ${role}` });
    const denied = userChangeAllowed(req.user, role, company_id);
    if (denied) return res.status(403).json({ error: denied });
    const deptErr = await checkDeptCompany(department_id, company_id);
    if (deptErr) return res.status(400).json({ error: deptErr });
    await orConflict(res, 'A user with that email already exists', async () => {
      const { id } = await db.run(
        'INSERT INTO users (name, email, password_hash, role, company_id, department_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        [String(name).trim(), String(email).trim(), bcrypt.hashSync(password, 10), role, company_id, department_id]
      );
      logActivity(req, 'user.create', 'user', id, { name: String(name).trim(), email: String(email).trim(), role });
      res.status(201).json({ user: publicUser(await loadUser(id)) });
    });
  })
);

router.patch(
  '/users/:id',
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (req.user.role === 'manager' && (existing.role !== 'employee' || existing.company_id !== req.user.company_id)) {
      return res.status(403).json({ error: 'Managers can only edit employees of their own company' });
    }
    const { name, email, role, company_id, department_id, active, password } = req.body || {};
    if (id === req.user.id && (active === 0 || active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ error: 'You cannot deactivate or demote your own account' });
    }
    const next = {
      name: name !== undefined ? String(name).trim() : existing.name,
      email: email !== undefined ? String(email).trim() : existing.email,
      role: role !== undefined ? role : existing.role,
      company_id: company_id !== undefined ? Number(company_id) || null : existing.company_id,
      department_id: department_id !== undefined ? Number(department_id) || null : existing.department_id,
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
      password_hash: password ? bcrypt.hashSync(String(password), 10) : existing.password_hash,
    };
    if (!ROLES.includes(next.role)) return res.status(400).json({ error: 'Invalid role' });
    if (next.role !== 'admin' && !next.company_id) return res.status(400).json({ error: `Choose a company for this ${next.role}` });
    const denied = userChangeAllowed(req.user, next.role, next.company_id);
    if (denied) return res.status(403).json({ error: denied });
    const deptErr = await checkDeptCompany(next.department_id, next.company_id);
    if (deptErr) return res.status(400).json({ error: deptErr });
    await orConflict(res, 'A user with that email already exists', async () => {
      await db.run(
        `UPDATE users SET name = @name, email = @email, role = @role, company_id = @company_id, department_id = @department_id,
         active = @active, password_hash = @password_hash WHERE id = @id`,
        { ...next, id }
      );
      logActivity(req, 'user.update', 'user', id, { name: next.name, role: next.role, active: next.active, password_reset: !!password });
      res.json({ user: publicUser(await loadUser(id)) });
    });
  })
);

router.delete(
  '/users/:id',
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (req.user.role === 'manager' && (existing.role !== 'employee' || existing.company_id !== req.user.company_id)) {
      return res.status(403).json({ error: 'Managers can only remove employees of their own company' });
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    logActivity(req, 'user.delete', 'user', id, { name: existing.name, email: existing.email });
    res.json({ ok: true });
  })
);

// ---------- Bulk import from Excel / CSV ----------
// Columns (header row, any order, case-insensitive): Name, Email, Password, Company, Department, Role
// Missing password → a random one is generated and returned so you can hand it out.
router.get('/users/import-template', requireStaff, (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Email', 'Password', 'Company', 'Department', 'Role'],
    ['Juan dela Cruz', 'juan@company.com', 'welcome1', 'Upright Solutions', 'Operations', 'employee'],
    ['Liza Reyes', 'liza@company.com', '', 'SixthGear', 'Shop', 'employee'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="upnotice-employees-template.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
});

// The import runs as a background job so 10,000 rows don't tie up one HTTP request:
// - company / department / email lookups are loaded once into memory (not 3 queries per row)
// - passwords are hashed on all CPU cores (hash-pool.js) and identical passwords are hashed once
// - users are inserted 500 per statement (insertMany)
// Small files finish within the request; big ones return 202 + a job id the app polls for progress.
const importJobs = new Map();
const JOB_TTL_MS = 60 * 60000;

async function runImport(job, rows, actor, createIfMissing) {
  const norm = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[String(k).trim().toLowerCase()] = String(v).trim();
    return out;
  };
  const companies = new Map((await db.all('SELECT id, name FROM companies')).map((c) => [c.name.toLowerCase(), c.id]));
  const departments = new Map((await db.all('SELECT id, name, company_id FROM departments')).map((d) => [`${d.company_id}|${d.name.toLowerCase()}`, d.id]));
  const emails = new Set((await db.all('SELECT email FROM users')).map((u) => u.email.toLowerCase()));
  const hashCache = new Map();
  const CHUNK = 100; // small enough that the progress bar moves every few seconds

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const ready = []; // rows that passed validation, waiting for their hash
    await db.tx(async () => {
      for (let i = 0; i < chunk.length; i++) {
        const r = norm(chunk[i]);
        const line = start + i + 2;
        const name = r.name || r['full name'] || '';
        const email = r.email || '';
        const wanted = (r.role || 'employee').toLowerCase();
        const role = actor.role === 'manager' ? 'employee' : wanted === 'admin' ? 'admin' : wanted === 'manager' ? 'manager' : 'employee';
        if (!name || !email) {
          job.skipped.push({ line, email, reason: 'Name and email are required' });
          continue;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          job.skipped.push({ line, email, reason: 'Not a valid email address' });
          continue;
        }
        if (emails.has(email.toLowerCase())) {
          job.skipped.push({ line, email, reason: 'Email already exists' });
          continue;
        }
        let companyId = null, deptId = null;
        if (role !== 'admin') {
          const cname = r.company || '';
          if (!cname) {
            job.skipped.push({ line, email, reason: 'Company is required for employees' });
            continue;
          }
          companyId = companies.get(cname.toLowerCase()) ?? null;
          if (actor.role === 'manager' && companyId !== actor.company_id) {
            job.skipped.push({ line, email, reason: 'Managers can only import into their own company' });
            continue;
          }
          if (companyId === null && createIfMissing) {
            companyId = (await db.run('INSERT INTO companies (name) VALUES (?) RETURNING id', [cname])).id;
            companies.set(cname.toLowerCase(), companyId);
          }
          if (companyId === null) {
            job.skipped.push({ line, email, reason: `Company "${cname}" not found` });
            continue;
          }
          const dname = r.department || '';
          if (dname) {
            const key = `${companyId}|${dname.toLowerCase()}`;
            deptId = departments.get(key) ?? null;
            if (deptId === null && createIfMissing) {
              deptId = (await db.run('INSERT INTO departments (name, company_id) VALUES (?, ?) RETURNING id', [dname, companyId])).id;
              departments.set(key, deptId);
            }
            if (deptId === null) {
              job.skipped.push({ line, email, reason: `Department "${dname}" not found in ${cname}` });
              continue;
            }
          }
        }
        emails.add(email.toLowerCase());
        const password = r.password || Math.random().toString(36).slice(-8);
        ready.push({ line, name, email, password, given: !!r.password, role, companyId, deptId, company: r.company || '', department: r.department || '' });
      }
    });

    // Hash every distinct password once, in parallel.
    const distinct = [...new Set(ready.map((x) => x.password).filter((p) => !hashCache.has(p)))];
    const hashes = await hashMany(distinct);
    distinct.forEach((p, i) => hashCache.set(p, hashes[i]));

    await db.tx(async () => {
      await insertMany(
        'users',
        ['name', 'email', 'password_hash', 'role', 'company_id', 'department_id'],
        ready.map((x) => [x.name, x.email, hashCache.get(x.password), x.role, x.companyId, x.deptId])
      );
    });
    for (const x of ready) job.created.push({ line: x.line, name: x.name, email: x.email, password: x.given ? '(as given)' : x.password, company: x.company, department: x.department });
    job.done = Math.min(rows.length, start + CHUNK);
  }
}

function jobStatus(job, full) {
  const out = { job: job.id, total: job.total, done: job.done, finished: job.finished, error: job.error, created_count: job.created.length, skipped_count: job.skipped.length };
  if (full) {
    out.created = job.created;
    out.skipped = job.skipped;
  }
  return out;
}

router.post(
  '/users/import',
  requireStaff,
  sheetUpload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an Excel or CSV file' });
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } catch {
      return res.status(400).json({ error: 'Could not read that file. Use .xlsx, .xls or .csv' });
    }
    const createIfMissing = req.body?.create_missing !== 'false';
    const job = { id: Math.random().toString(36).slice(2, 10), user_id: req.user.id, total: rows.length, done: 0, created: [], skipped: [], finished: false, error: null };
    importJobs.set(job.id, job);
    setTimeout(() => importJobs.delete(job.id), JOB_TTL_MS).unref();

    const finish = () => {
      job.finished = true;
      logActivity(req, 'user.import', 'user', null, { created: job.created.length, skipped: job.skipped.length });
      if (job.created.length) notifyAll('users');
    };
    const running = runImport(job, rows, req.user, createIfMissing).then(finish, (err) => {
      job.error = err.message;
      console.error('Import failed:', err);
      finish();
    });

    // Small files: answer directly (same shape as before). Big ones: 202 + job id, the app polls.
    await Promise.race([running, new Promise((r) => setTimeout(r, 2500))]);
    if (job.finished) return res.json(jobStatus(job, true));
    res.status(202).json(jobStatus(job, false));
  })
);

router.get(
  '/users/import/:job',
  requireStaff,
  wrap(async (req, res) => {
    const job = importJobs.get(req.params.job);
    if (!job || job.user_id !== req.user.id) return res.status(404).json({ error: 'Import not found (it may have expired)' });
    res.json(jobStatus(job, job.finished));
  })
);

export default router;
