// Companies, departments + user management (admin only, except listing).
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import * as XLSX from 'xlsx';
import { requireAuth, requireAdmin, publicUser, loadUser } from '../auth.js';
import { sheetUpload } from '../uploads.js';

const router = Router();
router.use(requireAuth);

// ---------- Companies ----------
router.get('/companies', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name,
         (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1 AND u.role = 'employee') AS member_count,
         (SELECT COUNT(*) FROM departments d WHERE d.company_id = c.id) AS department_count
       FROM companies c ORDER BY c.name`
    )
    .all();
  res.json({ companies: rows });
});

router.post('/companies', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  try {
    const info = db.prepare('INSERT INTO companies (name) VALUES (?)').run(name);
    res.status(201).json({ company: { id: info.lastInsertRowid, name, member_count: 0, department_count: 0 } });
  } catch {
    res.status(409).json({ error: 'A company with that name already exists' });
  }
});

router.patch('/companies/:id', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  try {
    const info = db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'A company with that name already exists' });
  }
});

router.delete('/companies/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const employees = db.prepare("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'employee'").get(id).n;
  if (employees > 0) {
    return res.status(400).json({ error: `This company still has ${employees} employee(s). Move or remove them first.` });
  }
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Departments ----------
router.get('/departments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.company_id, c.name AS company_name, COUNT(u.id) AS member_count
       FROM departments d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN users u ON u.department_id = d.id AND u.active = 1
       GROUP BY d.id ORDER BY c.name, d.name`
    )
    .all();
  res.json({ departments: rows });
});

router.post('/departments', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const company_id = Number(req.body?.company_id) || null;
  if (!name) return res.status(400).json({ error: 'Department name is required' });
  if (!company_id) return res.status(400).json({ error: 'Choose which company the department belongs to' });
  if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(company_id)) return res.status(404).json({ error: 'Company not found' });
  try {
    const info = db.prepare('INSERT INTO departments (name, company_id) VALUES (?, ?)').run(name, company_id);
    const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(company_id);
    res.status(201).json({ department: { id: info.lastInsertRowid, name, company_id, company_name: company.name, member_count: 0 } });
  } catch {
    res.status(409).json({ error: 'That company already has a department with this name' });
  }
});

router.patch('/departments/:id', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Department name is required' });
  try {
    const info = db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Department not found' });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'That company already has a department with this name' });
  }
});

router.delete('/departments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Users ----------
router.get('/users', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.company_id, u.department_id, u.active, u.created_at,
              d.name AS department_name, c.name AS company_name,
              CASE WHEN u.avatar_path IS NULL THEN NULL ELSE '/api/auth/avatar/' || u.id END AS avatar_url
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN companies c ON c.id = u.company_id
       ORDER BY u.active DESC, c.name, u.name`
    )
    .all();
  res.json({ users: rows });
});

/** Department must belong to the chosen company; returns an error string or null. */
function checkDeptCompany(department_id, company_id) {
  if (!department_id) return null;
  const d = db.prepare('SELECT company_id FROM departments WHERE id = ?').get(department_id);
  if (!d) return 'Department not found';
  if (d.company_id && d.company_id !== company_id) return 'That department belongs to a different company';
  return null;
}

router.post('/users', requireAdmin, (req, res) => {
  const { name, email, password, role = 'employee' } = req.body || {};
  const company_id = Number(req.body?.company_id) || null;
  const department_id = Number(req.body?.department_id) || null;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['admin', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role === 'employee' && !company_id) return res.status(400).json({ error: 'Choose a company for this employee' });
  const deptErr = checkDeptCompany(department_id, company_id);
  if (deptErr) return res.status(400).json({ error: deptErr });
  try {
    const info = db
      .prepare('INSERT INTO users (name, email, password_hash, role, company_id, department_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(name).trim(), String(email).trim(), bcrypt.hashSync(password, 10), role, company_id, department_id);
    res.status(201).json({ user: publicUser(loadUser(info.lastInsertRowid)) });
  } catch {
    res.status(409).json({ error: 'A user with that email already exists' });
  }
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
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
  if (next.role === 'employee' && !next.company_id) return res.status(400).json({ error: 'Choose a company for this employee' });
  const deptErr = checkDeptCompany(next.department_id, next.company_id);
  if (deptErr) return res.status(400).json({ error: deptErr });
  try {
    db.prepare(
      `UPDATE users SET name = @name, email = @email, role = @role, company_id = @company_id, department_id = @department_id,
       active = @active, password_hash = @password_hash WHERE id = @id`
    ).run({ ...next, id });
    res.json({ user: publicUser(loadUser(id)) });
  } catch {
    res.status(409).json({ error: 'A user with that email already exists' });
  }
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Bulk import from Excel / CSV ----------
// Columns (header row, any order, case-insensitive): Name, Email, Password, Company, Department, Role
// Missing password → a random one is generated and returned so you can hand it out.
router.get('/users/import-template', requireAdmin, (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Email', 'Password', 'Company', 'Department', 'Role'],
    ['Juan dela Cruz', 'juan@company.com', 'welcome1', 'Upright Solutions', 'Operations', 'employee'],
    ['Liza Reyes', 'liza@company.com', '', 'SixthGear', 'Shop', 'employee'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Employees');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="teamannounce-employees-template.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
});

router.post('/users/import', requireAdmin, sheetUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an Excel or CSV file' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch {
    return res.status(400).json({ error: 'Could not read that file. Use .xlsx, .xls or .csv' });
  }
  const norm = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[String(k).trim().toLowerCase()] = String(v).trim();
    return out;
  };
  const createIfMissing = req.body?.create_missing !== 'false';
  const results = { created: [], skipped: [] };
  const findCompany = db.prepare('SELECT id FROM companies WHERE name = ? COLLATE NOCASE');
  const findDept = db.prepare('SELECT id FROM departments WHERE company_id = ? AND name = ? COLLATE NOCASE');
  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role, company_id, department_id) VALUES (?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    rows.forEach((raw, i) => {
      const r = norm(raw);
      const line = i + 2;
      const name = r.name || r['full name'] || '';
      const email = r.email || '';
      const role = (r.role || 'employee').toLowerCase() === 'admin' ? 'admin' : 'employee';
      if (!name || !email) return results.skipped.push({ line, email, reason: 'Name and email are required' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return results.skipped.push({ line, email, reason: 'Email already exists' });
      let companyId = null, deptId = null;
      if (role === 'employee') {
        const cname = r.company || '';
        if (!cname) return results.skipped.push({ line, email, reason: 'Company is required for employees' });
        let c = findCompany.get(cname);
        if (!c && createIfMissing) c = { id: db.prepare('INSERT INTO companies (name) VALUES (?)').run(cname).lastInsertRowid };
        if (!c) return results.skipped.push({ line, email, reason: `Company "${cname}" not found` });
        companyId = c.id;
        const dname = r.department || '';
        if (dname) {
          let d = findDept.get(companyId, dname);
          if (!d && createIfMissing) d = { id: db.prepare('INSERT INTO departments (name, company_id) VALUES (?, ?)').run(dname, companyId).lastInsertRowid };
          if (!d) return results.skipped.push({ line, email, reason: `Department "${dname}" not found in ${cname}` });
          deptId = d.id;
        }
      }
      const password = r.password || Math.random().toString(36).slice(-8);
      insertUser.run(name, email, bcrypt.hashSync(password, 10), role, companyId, deptId);
      results.created.push({ line, name, email, password: r.password ? '(as given)' : password, company: r.company || '', department: r.department || '' });
    });
  })();
  res.json(results);
});

export default router;
