// Companies, departments + user management (admin only, except listing).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { db, isUniqueViolation, insertMany } from '../db.js';
import { hashMany } from '../hash-pool.js';
import { requireAuth, requireAdmin, requireStaff, requireAuthOrTicket, companyScope, publicUser, loadUser, wrap, revokeUserSessions } from '../auth.js';
import { sheetUpload } from '../uploads.js';
import { logActivity } from '../activity.js';
import { notifyAll } from '../events.js';
import { uploadLimiter } from '../limits.js';
import { parse, companyBody, departmentBody, departmentRename, userCreate, userPatch, usersQuery, importBody, idParam } from '../validate.js';
import { passwordProblem, generatePassword, MIN_PASSWORD_LENGTH } from '../passwords.js';
import { log } from '../log.js';

const router = Router();

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
  requireAuth,
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
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const { name } = parse(companyBody, req.body);
    await orConflict(res, 'A company with that name already exists', async () => {
      const { id } = await db.run('INSERT INTO companies (name) VALUES (?) RETURNING id', [name]);
      logActivity(req, 'company.create', 'company', id, { name });
      res.status(201).json({ company: { id, name, member_count: 0, department_count: 0 } });
    });
  })
);

router.patch(
  '/companies/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const { name } = parse(companyBody, req.body);
    const id = Number(req.params.id) || 0;
    await orConflict(res, 'A company with that name already exists', async () => {
      const info = await db.run('UPDATE companies SET name = ? WHERE id = ?', [name, id]);
      if (!info.changes) return res.status(404).json({ error: 'Company not found' });
      logActivity(req, 'company.update', 'company', id, { name });
      res.json({ ok: true });
    });
  })
);

router.delete(
  '/companies/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const employees = (await db.get("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role IN ('employee', 'manager')", [id])).n;
    if (employees > 0) {
      return res.status(400).json({ error: `This company still has ${employees} employee(s). Move or remove them first.` });
    }
    const c = await db.get('SELECT name FROM companies WHERE id = ?', [id]);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    await db.run('DELETE FROM companies WHERE id = ?', [id]);
    logActivity(req, 'company.delete', 'company', id, { name: c.name });
    res.json({ ok: true });
  })
);

// ---------- Departments ----------
router.get(
  '/departments',
  requireAuth,
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
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const { name, company_id } = parse(departmentBody, req.body);
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
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const { name } = parse(departmentRename, req.body);
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
  requireAuth,
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
// List employees. Optional: ?q=search&company_id=&role=&limit=&offset= — with `limit` the answer also carries
// `total` so the app can page through thousands of people instead of downloading them all.
router.get(
  '/users',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const query = parse(usersQuery, req.query);
    const scope = companyScope(req.user);
    const where = [];
    const params = [];
    if (scope !== null) {
      where.push('u.company_id = ?');
      params.push(scope);
    } else if (query.company_id) {
      where.push("(u.company_id = ? OR u.role = 'admin')");
      params.push(query.company_id);
    }
    if (query.role) {
      where.push('u.role = ?');
      params.push(query.role);
    }
    const q = (query.q || '').toLowerCase();
    if (q) {
      where.push('(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = query.limit || 0;
    const offset = query.offset || 0;
    const rows = await db.all(
      `SELECT u.id, u.name, u.email, u.role, u.company_id, u.department_id, u.active, u.created_at, u.email_notifications, u.must_change_password,
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
    const out = { users: rows.map((u) => ({ ...u, must_change_password: !!u.must_change_password })) };
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
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const body = parse(userCreate, req.body);
    const { name, email, password, role, department_id } = body;
    const company_id = role === 'admin' ? null : body.company_id;
    if (role !== 'admin' && !company_id) return res.status(400).json({ error: `Choose a company for this ${role}` });
    const denied = userChangeAllowed(req.user, role, company_id);
    if (denied) return res.status(403).json({ error: denied });
    const problem = passwordProblem(password, { email, name });
    if (problem) return res.status(400).json({ error: problem });
    const deptErr = await checkDeptCompany(department_id, company_id);
    if (deptErr) return res.status(400).json({ error: deptErr });
    await orConflict(res, 'A user with that email already exists', async () => {
      // A password typed in by staff is a temporary one: the person picks their own at the first sign-in.
      const { id } = await db.run(
        'INSERT INTO users (name, email, password_hash, role, company_id, department_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id',
        [name, email, bcrypt.hashSync(password, 10), role, company_id, role === 'admin' ? null : department_id]
      );
      logActivity(req, 'user.create', 'user', id, { name, email, role });
      res.status(201).json({ user: publicUser(await loadUser(id)) });
    });
  })
);

router.patch(
  '/users/:id',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const body = parse(userPatch, req.body);
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (req.user.role === 'manager' && (existing.role !== 'employee' || existing.company_id !== req.user.company_id)) {
      return res.status(403).json({ error: 'Managers can only edit employees of their own company' });
    }
    if (id === req.user.id && (body.active === false || (body.role && body.role !== 'admin'))) {
      return res.status(400).json({ error: 'You cannot deactivate or demote your own account' });
    }
    const next = {
      name: body.name ?? existing.name,
      email: body.email ?? existing.email,
      role: body.role ?? existing.role,
      company_id: body.company_id !== undefined ? body.company_id : existing.company_id,
      department_id: body.department_id !== undefined ? body.department_id : existing.department_id,
      active: body.active !== undefined ? (body.active ? 1 : 0) : existing.active,
      password_hash: existing.password_hash,
      must_change_password: existing.must_change_password,
    };
    if (next.role === 'admin') next.company_id = next.company_id ?? null;
    if (next.role !== 'admin' && !next.company_id) return res.status(400).json({ error: `Choose a company for this ${next.role}` });
    const denied = userChangeAllowed(req.user, next.role, next.company_id);
    if (denied) return res.status(403).json({ error: denied });
    if (body.password) {
      const problem = passwordProblem(body.password, next);
      if (problem) return res.status(400).json({ error: problem });
      next.password_hash = bcrypt.hashSync(body.password, 10);
      next.must_change_password = id === req.user.id ? 0 : 1; // a reset by staff is temporary
    }
    const deptErr = await checkDeptCompany(next.department_id, next.company_id);
    if (deptErr) return res.status(400).json({ error: deptErr });
    await orConflict(res, 'A user with that email already exists', async () => {
      await db.run(
        `UPDATE users SET name = @name, email = @email, role = @role, company_id = @company_id, department_id = @department_id,
         active = @active, password_hash = @password_hash, must_change_password = @must_change_password WHERE id = @id`,
        { ...next, id }
      );
      // A password reset, deactivation or role change ends the person's current sessions everywhere.
      if (body.password || next.active === 0 || next.role !== existing.role) {
        if (id !== req.user.id) await revokeUserSessions(id);
      }
      logActivity(req, 'user.update', 'user', id, { name: next.name, role: next.role, active: next.active, password_reset: !!body.password });
      res.json({ user: publicUser(await loadUser(id)) });
    });
  })
);

router.delete(
  '/users/:id',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (req.user.role === 'manager' && (existing.role !== 'employee' || existing.company_id !== req.user.company_id)) {
      return res.status(403).json({ error: 'Managers can only remove employees of their own company' });
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]); // sessions, reads, RSVPs cascade
    logActivity(req, 'user.delete', 'user', id, { name: existing.name, email: existing.email });
    res.json({ ok: true });
  })
);

/**
 * The lost-phone route: switch two-factor off for someone else so they can sign in with their password
 * and set it up again. Only an admin, never for your own account (that would make it a way round it),
 * and it is written to the activity log — turning off someone's second factor should never be quiet.
 */
router.post(
  '/users/:id/2fa/reset',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (id === req.user.id) return res.status(400).json({ error: 'Turn your own two-factor off in Settings, where it asks for your password and a code' });
    const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (!existing.totp_enabled) return res.status(400).json({ error: 'That person does not have two-factor authentication on' });
    await db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?', [id]);
    await db.run('DELETE FROM recovery_codes WHERE user_id = ?', [id]);
    // Anyone holding a session for that account keeps it; signing out everywhere is a separate decision.
    logActivity(req, 'user.twofa_reset', 'user', id, { name: existing.name, email: existing.email });
    res.json({ ok: true });
  })
);

// ---------- Bulk import from Excel / CSV ----------
// Columns (header row, any order, case-insensitive): Name, Email, Password, Company, Department, Role
// Missing password → a random one is generated and returned so you can hand it out.
router.get(
  '/users/import-template',
  requireAuthOrTicket,
  requireStaff,
  wrap(async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow(['Name', 'Email', 'Password', 'Company', 'Department', 'Role']);
    ws.addRow(['Juan dela Cruz', 'juan@company.com', 'Welcome2Upright', 'Upright Solutions', 'Operations', 'employee']);
    ws.addRow(['Liza Reyes', 'liza@company.com', '', 'SixthGear', 'Shop', 'employee']);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 22));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Disposition', 'attachment; filename="upnotice-employees-template.xlsx"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  })
);

/** Reads the first sheet of an .xlsx or a .csv into objects keyed by the header row. */
async function readSheet(buffer, originalName) {
  const wb = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(originalName || '') || buffer.subarray(0, 4).toString('hex') !== '504b0304';
  let ws;
  if (isCsv) {
    const { Readable } = await import('node:stream');
    ws = await wb.csv.read(Readable.from([buffer.toString('utf8').replace(/^\uFEFF/, '')]));
  } else {
    await wb.xlsx.load(buffer);
    ws = wb.worksheets[0];
  }
  if (!ws) return [];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v.text !== undefined) return String(v.text);
      if (v.result !== undefined) return String(v.result);
      if (v instanceof Date) return v.toISOString();
      return String(v.hyperlink || '');
    }
    return String(v);
  };
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => (headers[i] = cell(c.value).trim().toLowerCase()));
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const out = {};
    let any = false;
    row.eachCell({ includeEmpty: true }, (c, i) => {
      if (!headers[i]) return;
      const v = cell(c.value).trim();
      out[headers[i]] = v;
      if (v) any = true;
    });
    if (any) rows.push(out);
  });
  return rows;
}

// The import runs as a background job so 10,000 rows don't tie up one HTTP request:
// - company / department / email lookups are loaded once into memory (not 3 queries per row)
// - passwords are hashed on all CPU cores (hash-pool.js) and identical passwords are hashed once
// - users are inserted 500 per statement (insertMany)
// Small files finish within the request; big ones return 202 + a job id the app polls for progress.
const importJobs = new Map();
const JOB_TTL_MS = 60 * 60000;

async function runImport(job, rows, actor, createIfMissing) {
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
        const r = chunk[i];
        const line = start + i + 2;
        const name = (r.name || r['full name'] || '').slice(0, 120);
        const email = (r.email || '').toLowerCase();
        const wanted = (r.role || 'employee').toLowerCase();
        const role = actor.role === 'manager' ? 'employee' : wanted === 'admin' ? 'admin' : wanted === 'manager' ? 'manager' : 'employee';
        if (!name || !email) {
          job.skipped.push({ line, email, reason: 'Name and email are required' });
          continue;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
          job.skipped.push({ line, email, reason: 'Not a valid email address' });
          continue;
        }
        if (emails.has(email)) {
          job.skipped.push({ line, email, reason: 'Email already exists' });
          continue;
        }
        if (r.password) {
          const problem = passwordProblem(r.password, { email, name });
          if (problem) {
            job.skipped.push({ line, email, reason: problem });
            continue;
          }
        }
        let companyId = null,
          deptId = null;
        if (role !== 'admin') {
          const cname = (r.company || '').slice(0, 80);
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
          const dname = (r.department || '').slice(0, 80);
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
        emails.add(email);
        const password = r.password || generatePassword(10);
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
        ['name', 'email', 'password_hash', 'role', 'company_id', 'department_id', 'must_change_password'],
        ready.map((x) => [x.name, x.email, hashCache.get(x.password), x.role, x.companyId, x.deptId, 1])
      );
    });
    for (const x of ready)
      job.created.push({ line: x.line, name: x.name, email: x.email, password: x.given ? '(as given)' : x.password, company: x.company, department: x.department });
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
  requireAuth,
  requireStaff,
  uploadLimiter,
  sheetUpload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an Excel or CSV file' });
    const { create_missing } = parse(importBody, req.body);
    let rows;
    try {
      rows = await readSheet(req.file.buffer, req.file.originalname);
    } catch (err) {
      log.warn({ err: err.message }, 'Import: could not read spreadsheet');
      return res.status(400).json({ error: 'Could not read that file. Use .xlsx or .csv' });
    }
    if (rows.length > 20000) return res.status(400).json({ error: 'Import at most 20,000 rows at a time' });
    const job = { id: generatePassword(12), user_id: req.user.id, total: rows.length, done: 0, created: [], skipped: [], finished: false, error: null };
    importJobs.set(job.id, job);
    setTimeout(() => importJobs.delete(job.id), JOB_TTL_MS).unref();

    const finish = () => {
      job.finished = true;
      logActivity(req, 'user.import', 'user', null, { created: job.created.length, skipped: job.skipped.length });
      if (job.created.length) notifyAll('users');
    };
    const running = runImport(job, rows, req.user, create_missing).then(finish, (err) => {
      job.error = 'The import stopped because of a server error';
      log.error({ err }, 'Import failed');
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
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const job = importJobs.get(String(req.params.job));
    if (!job || job.user_id !== req.user.id) return res.status(404).json({ error: 'Import not found (it may have expired)' });
    res.json(jobStatus(job, job.finished));
  })
);

export { MIN_PASSWORD_LENGTH, idParam };
export default router;
