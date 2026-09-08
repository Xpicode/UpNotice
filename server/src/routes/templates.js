// Announcement templates: save a frequently used announcement (e.g. "Holiday notice") and reuse it.
// Admin templates with company_id NULL are shared with everyone; a manager's templates belong to their company.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireStaff, companyScope, wrap } from '../auth.js';
import { logActivity } from '../activity.js';
import { parse, templateBody } from '../validate.js';

const router = Router();
router.use(requireAuth, requireStaff);

function shape(t) {
  let options = [];
  try {
    options = JSON.parse(t.poll_options || '[]');
  } catch {
    options = [];
  }
  return { ...t, ack_required: !!t.ack_required, poll_options: Array.isArray(options) ? options : [] };
}

router.get(
  '/',
  wrap(async (req, res) => {
    const scope = companyScope(req.user);
    const rows =
      scope === null
        ? await db.all('SELECT t.*, u.name AS created_by_name FROM templates t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.name')
        : await db.all(
            'SELECT t.*, u.name AS created_by_name FROM templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.company_id IS NULL OR t.company_id = ? ORDER BY t.name',
            [scope]
          );
    res.json({ templates: rows.map(shape) });
  })
);

router.post(
  '/',
  wrap(async (req, res) => {
    const b = parse(templateBody, req.body);
    const { name, priority } = b;
    const options = b.poll_options;
    // Managers' templates stay inside their company; admins' templates are shared unless they pick a company.
    const company_id = req.user.role === 'manager' ? req.user.company_id : b.company_id;
    const { id } = await db.run(
      `INSERT INTO templates (name, title, body, priority, category, ack_required, poll_question, poll_options, company_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [name, b.title, b.body, priority, b.category || null, b.ack_required ? 1 : 0, b.poll_question || null, JSON.stringify(options), company_id, req.user.id]
    );
    logActivity(req, 'template.create', 'template', id, { name });
    res.status(201).json({ template: shape(await db.get('SELECT * FROM templates WHERE id = ?', [id])) });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const t = await db.get('SELECT * FROM templates WHERE id = ?', [Number(req.params.id) || 0]);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const scope = companyScope(req.user);
    if (scope !== null && t.company_id !== scope) return res.status(403).json({ error: 'You can only delete templates of your own company' });
    await db.run('DELETE FROM templates WHERE id = ?', [t.id]);
    logActivity(req, 'template.delete', 'template', t.id, { name: t.name });
    res.json({ ok: true });
  })
);

export default router;
