import { Router } from 'express';
import path from 'node:path';
import { db, audienceWhere, audienceUserIds, visibilitySql, nowIso } from '../db.js';
import { requireAuth, requireAuthOrTicket, requireStaff, isStaff, canManage, wrap } from '../auth.js';
import { createNotifications, managerIds } from '../notify.js';
import { logActivity } from '../activity.js';
import { notifyAll, notifyUsers } from '../events.js';
import { attachmentUpload, checkUploads, fileHeaders, uploadDir, removeStored } from '../uploads.js';
import { uploadLimiter } from '../limits.js';
import { parse, announcementsQuery, announcementCreate, announcementPatch, voteBody } from '../validate.js';

const router = Router();

/** Suggested categories; admins can also type their own. */
export const DEFAULT_CATEGORIES = ['General', 'HR', 'Safety', 'Events', 'Finance', 'IT', 'Operations', 'Sales'];

// ---------- helpers ----------
function targetsFor(id) {
  return db.all(`SELECT d.id, d.name FROM announcement_targets t JOIN departments d ON d.id = t.department_id WHERE t.announcement_id = ? ORDER BY d.name`, [id]);
}
async function pollFor(id, userId) {
  const options = await db.all(
    `SELECT o.id, o.label, (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes
     FROM poll_options o WHERE o.announcement_id = ? ORDER BY o.position, o.id`,
    [id]
  );
  if (options.length === 0) return null;
  const mine = await db.get('SELECT option_id FROM poll_votes WHERE announcement_id = ? AND user_id = ?', [id, userId]);
  return { options, my_vote: mine ? mine.option_id : null, total: options.reduce((n, o) => n + o.votes, 0) };
}
/** Number of people an announcement reaches, as one COUNT query (no list of ids for a 10,000-person audience). */
async function audienceCount(row, targets, ownerId) {
  const aud = audienceWhere(
    row.company_id,
    targets.map((t) => t.id)
  );
  return (await db.get(`SELECT COUNT(*) AS n FROM users WHERE ${aud.sql} AND id <> ?`, [...aud.params, ownerId])).n;
}
async function audienceFor(row, excludeUserId = null) {
  const targets = await targetsFor(row.id);
  // The author never counts as part of the audience (matters when a manager posts to their own company).
  return (
    await audienceUserIds(
      row.company_id,
      targets.map((t) => t.id),
      excludeUserId
    )
  ).filter((id) => id !== row.author_id);
}
function isLive(row) {
  const now = nowIso();
  return !row.is_draft && (!row.publish_at || row.publish_at <= now) && (!row.expires_at || row.expires_at > now);
}
async function canSee(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  // Managers see everything of their own company (drafts and scheduled included), plus live all-company items.
  if (user.role === 'manager' && row.company_id != null && row.company_id === user.company_id) return true;
  if (!isLive(row)) return false;
  if (row.company_id && row.company_id !== user.company_id) return false;
  const targets = await targetsFor(row.id);
  if (targets.length === 0) return true;
  return targets.some((t) => t.id === user.department_id);
}

const baseSelect = `
  SELECT a.*, u.name AS author_name, c.name AS company_name,
         (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS read_count,
         (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id AND r.acknowledged_at IS NOT NULL) AS ack_count,
         (SELECT COUNT(*) FROM comments cm WHERE cm.ref_type = 'announcement' AND cm.ref_id = a.id) AS comment_count,
         (SELECT COUNT(*) FROM announcement_attachments at WHERE at.announcement_id = a.id) AS attachment_count,
         EXISTS(SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = @me) AS read_by_me,
         EXISTS(SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = @me AND r.acknowledged_at IS NOT NULL) AS acked_by_me
  FROM announcements a JOIN users u ON u.id = a.author_id LEFT JOIN companies c ON c.id = a.company_id`;

function statusOf(row, now) {
  return row.is_draft ? 'draft' : row.publish_at && row.publish_at > now ? 'scheduled' : row.expires_at && row.expires_at <= now ? 'expired' : 'live';
}

/** Turns rows into API objects. Targets and attachments for the whole page come from two queries, not two per row. */
async function shapeAll(rows, user) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const targetRows = await db.all(
    `SELECT t.announcement_id, d.id, d.name FROM announcement_targets t JOIN departments d ON d.id = t.department_id WHERE t.announcement_id IN (${marks}) ORDER BY d.name`,
    ids
  );
  const fileRows = await db.all(`SELECT id, announcement_id, filename, mime, size FROM announcement_attachments WHERE announcement_id IN (${marks}) ORDER BY id`, ids);
  const targets = new Map();
  for (const t of targetRows) (targets.get(t.announcement_id) || targets.set(t.announcement_id, []).get(t.announcement_id)).push({ id: t.id, name: t.name });
  const files = new Map();
  for (const f of fileRows)
    (files.get(f.announcement_id) || files.set(f.announcement_id, []).get(f.announcement_id)).push({ id: f.id, filename: f.filename, mime: f.mime, size: f.size });
  const now = nowIso();
  const staff = isStaff(user);
  const out = [];
  for (const row of rows) {
    const t = targets.get(row.id) || [];
    const item = {
      ...row,
      read_by_me: !!row.read_by_me,
      acked_by_me: !!row.acked_by_me,
      pinned: !!row.pinned,
      ack_required: !!row.ack_required,
      status: statusOf(row, now),
      is_draft: !!row.is_draft,
      can_manage: canManage(user, row),
      targets: t,
      attachments: files.get(row.id) || [],
      poll: row.poll_question ? { question: row.poll_question, ...(await pollFor(row.id, user.id)) } : null,
    };
    delete item.notified;
    if (staff) item.audience_count = await audienceCount(row, t, row.author_id);
    out.push(item);
  }
  return out;
}
const shape = async (row, user) => (await shapeAll([row], user))[0];

/** Turns the list filters into SQL. */
function listFilters(query, params) {
  const where = [];
  const q = String(query.q || '').toLowerCase();
  if (q) {
    where.push('(LOWER(a.title) LIKE @q OR LOWER(a.body) LIKE @q OR LOWER(u.name) LIKE @q)');
    params.q = `%${q}%`;
  }
  if (query.category) {
    where.push("LOWER(COALESCE(a.category, '')) = @category");
    params.category = query.category.toLowerCase();
  }
  if (query.company_id) {
    where.push('a.company_id = @companyFilter');
    params.companyFilter = query.company_id;
  }
  if (query.department_id) {
    where.push('EXISTS (SELECT 1 FROM announcement_targets ft WHERE ft.announcement_id = a.id AND ft.department_id = @deptFilter)');
    params.deptFilter = query.department_id;
  }
  if (query.from && !Number.isNaN(Date.parse(query.from))) {
    where.push('COALESCE(a.publish_at, a.created_at) >= @from');
    params.from = new Date(query.from).toISOString();
  }
  if (query.to && !Number.isNaN(Date.parse(query.to))) {
    where.push('COALESCE(a.publish_at, a.created_at) < @to');
    params.to = new Date(new Date(query.to).getTime() + 86400000).toISOString();
  }
  if (query.status === 'draft') where.push('a.is_draft = 1');
  else if (query.status === 'scheduled') where.push('a.is_draft = 0 AND a.publish_at IS NOT NULL AND a.publish_at > @nowTs');
  else if (query.status === 'expired') where.push('a.is_draft = 0 AND a.expires_at IS NOT NULL AND a.expires_at <= @nowTs');
  else if (query.status === 'live') where.push('a.is_draft = 0 AND (a.publish_at IS NULL OR a.publish_at <= @nowTs) AND (a.expires_at IS NULL OR a.expires_at > @nowTs)');
  if (query.unread) where.push('NOT EXISTS (SELECT 1 FROM announcement_reads ur WHERE ur.announcement_id = a.id AND ur.user_id = @me)');
  return where;
}

async function parseTargeting({ company_id, department_ids }, user = null) {
  if (user?.role === 'manager' && company_id !== user.company_id) return 'Managers can only post to their own company';
  const depts = department_ids || [];
  if (company_id && !(await db.get('SELECT 1 FROM companies WHERE id = ?', [company_id]))) return 'Company not found';
  if (depts.length > 0) {
    if (!company_id) return 'Choose a company before picking departments';
    const rows = await db.all(`SELECT id FROM departments WHERE company_id = ? AND id IN (${depts.map(() => '?').join(',')})`, [company_id, ...depts]);
    if (rows.length !== depts.length) return 'One of the departments does not belong to that company';
  }
  return { company_id, depts };
}

async function sendNewAnnouncementNotifications(row, excludeUserId) {
  const audience = await audienceFor(row, excludeUserId);
  const label = row.priority === 'urgent' ? 'Urgent announcement' : row.priority === 'important' ? 'Important announcement' : 'New announcement';
  await createNotifications(audience, { type: 'announcement', title: `${label}: ${row.title}`, body: String(row.body).slice(0, 140), refType: 'announcement', refId: row.id });
  await db.run('UPDATE announcements SET notified = 1 WHERE id = ?', [row.id]);
  notifyAll('announcements', { id: row.id });
}

/** Called by the scheduler every minute: publish announcements whose time has come. */
export async function publishDueAnnouncements() {
  const due = await db.all('SELECT * FROM announcements WHERE notified = 0 AND is_draft = 0 AND publish_at IS NOT NULL AND publish_at <= ?', [nowIso()]);
  for (const a of due) await sendNewAnnouncementNotifications(a, null);
  return due.length;
}

// ---------- list / detail ----------
// Filters: ?q=text  ?category=HR  ?company_id=  ?department_id=  ?from=YYYY-MM-DD  ?to=YYYY-MM-DD
//          ?status=live|scheduled|expired|draft   ?unread=1   ?limit=30&offset=0 (paged: adds total + has_more)
router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const query = parse(announcementsQuery, req.query);
    const me = req.user.id;
    const params = { me, company: req.user.company_id ?? -1, dept: req.user.department_id ?? -1, nowTs: nowIso() };
    const where = listFilters(query, params);
    if (req.user.role === 'manager') {
      // Own company: everything. Other items: only what an employee of this company would see.
      where.push(`(a.company_id = @company OR (${visibilitySql('a', 'announcement_targets', 'announcement_id')}))`);
    } else if (req.user.role !== 'admin') {
      where.push(visibilitySql('a', 'announcement_targets', 'announcement_id'));
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = 'ORDER BY a.pinned DESC, COALESCE(a.publish_at, a.created_at) DESC, a.id DESC';
    const out = {};
    let sql = `${baseSelect} ${whereSql} ${order}`;
    if (query.limit) {
      const offset = query.offset || 0;
      out.total = (await db.get(`SELECT COUNT(*) AS n FROM announcements a JOIN users u ON u.id = a.author_id ${whereSql}`, params)).n;
      sql += ` LIMIT ${query.limit} OFFSET ${offset}`;
      out.has_more = offset + query.limit < out.total;
    }
    out.announcements = await shapeAll(await db.all(sql, params), req.user);
    res.json(out);
  })
);

// Categories in use + the suggested defaults (for the filter chips and the compose form).
router.get(
  '/categories',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await db.all("SELECT DISTINCT category FROM announcements WHERE category IS NOT NULL AND category <> '' ORDER BY category");
    const used = rows.map((r) => r.category);
    res.json({ categories: [...new Set([...DEFAULT_CATEGORIES, ...used])] });
  })
);

router.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get(`${baseSelect} WHERE a.id = @id`, { me: req.user.id, id });
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    const out = await shape(row, req.user);
    if (canManage(req.user, row)) {
      // Join the audience rule directly (no list of 10,000 ids) and the poll answers with one LEFT JOIN.
      const aud = audienceWhere(
        row.company_id,
        out.targets.map((t) => t.id),
        'u'
      );
      const people = await db.all(
        `SELECT u.id, u.name, u.email, d.name AS department_name, c.name AS company_name, r.read_at, r.acknowledged_at, o.label AS poll_answer
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN companies c ON c.id = u.company_id
         LEFT JOIN announcement_reads r ON r.user_id = u.id AND r.announcement_id = ?
         LEFT JOIN poll_votes v ON v.announcement_id = ? AND v.user_id = u.id
         LEFT JOIN poll_options o ON o.id = v.option_id
         WHERE ${aud.sql} AND u.id <> ? ORDER BY (r.read_at IS NULL), u.name`,
        [id, id, ...aud.params, row.author_id]
      );
      // Full lists for normal audiences; for very large ones send the first 300 of each plus the totals.
      const readers = people.filter((p) => p.read_at);
      const unread = people.filter((p) => !p.read_at);
      out.readers_total = readers.length;
      out.unread_total = unread.length;
      out.readers = readers.slice(0, 300);
      out.unread = unread.slice(0, 300);
    }
    res.json({ announcement: out });
  })
);

// ---------- create / update ----------
// Accepts JSON or multipart/form-data (when files are attached).
router.post(
  '/',
  requireAuth,
  requireStaff,
  uploadLimiter,
  attachmentUpload.array('files', 5),
  checkUploads(),
  wrap(async (req, res) => {
    const b = parse(announcementCreate, req.body);
    const isDraft = b.draft;
    if (!b.body && !isDraft) return res.status(400).json({ error: 'Title and message are required' });
    const targeting = await parseTargeting(b, req.user);
    if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
    if (b.publish_at && b.expires_at && b.expires_at <= b.publish_at) return res.status(400).json({ error: 'Expiry must be after the publish time' });
    const pollQuestion = b.poll_question || null;
    if (pollQuestion && b.poll_options.length < 2) return res.status(400).json({ error: 'A poll needs at least 2 options' });
    const category = b.category || null;

    const scheduled = !!b.publish_at && b.publish_at > nowIso();
    const id = await db.tx(async () => {
      const { id: newId } = await db.run(
        `INSERT INTO announcements (title, body, priority, pinned, company_id, author_id, publish_at, expires_at, ack_required, poll_question, notified, category, is_draft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          b.title,
          b.body,
          b.priority,
          b.pinned ? 1 : 0,
          targeting.company_id,
          req.user.id,
          b.publish_at,
          b.expires_at,
          b.ack_required ? 1 : 0,
          pollQuestion,
          scheduled || isDraft ? 0 : 1,
          category,
          isDraft ? 1 : 0,
        ]
      );
      for (const d of targeting.depts) await db.run('INSERT INTO announcement_targets (announcement_id, department_id) VALUES (?, ?)', [newId, d]);
      if (pollQuestion) {
        for (let i = 0; i < b.poll_options.length; i++) await db.run('INSERT INTO poll_options (announcement_id, label, position) VALUES (?, ?, ?)', [newId, b.poll_options[i], i]);
      }
      for (const f of req.files || []) {
        await db.run('INSERT INTO announcement_attachments (announcement_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)', [
          newId,
          f.originalname,
          f.filename,
          f.mimetype,
          f.size,
        ]);
      }
      return newId;
    });

    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (isDraft) notifyAll('announcements', { id });
    else if (!scheduled) await sendNewAnnouncementNotifications(row, req.user.id);
    else notifyAll('announcements', { id });
    logActivity(req, isDraft ? 'announcement.draft' : 'announcement.create', 'announcement', id, { title: b.title, scheduled });
    const full = await db.get(`${baseSelect} WHERE a.id = @id`, { me: req.user.id, id });
    res.status(201).json({ announcement: await shape(full, req.user) });
  })
);

router.patch(
  '/:id',
  requireAuth,
  requireStaff,
  uploadLimiter,
  attachmentUpload.array('files', 5),
  checkUploads(),
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!existing) {
      for (const f of req.files || []) removeStored(f.filename);
      return res.status(404).json({ error: 'Announcement not found' });
    }
    if (!canManage(req.user, existing)) {
      for (const f of req.files || []) removeStored(f.filename);
      return res.status(403).json({ error: 'You can only edit announcements of your own company' });
    }
    const b = parse(announcementPatch, req.body);
    const retarget = b.company_id !== undefined || b.department_ids !== undefined;
    let targeting = null;
    if (retarget) {
      targeting = await parseTargeting(
        { company_id: b.company_id !== undefined ? b.company_id : existing.company_id, department_ids: b.department_ids ?? (await targetsFor(id)).map((t) => t.id) },
        req.user
      );
      if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
    }
    const category = b.category !== undefined ? b.category || null : existing.category;
    // draft=false on a draft publishes it (now, or at publish_at if that is in the future).
    const wasDraft = existing.is_draft === 1;
    const isDraft = b.draft !== undefined ? b.draft : wasDraft;
    const publishing = wasDraft && !isDraft;
    if (!isDraft && !String(b.body !== undefined ? b.body : existing.body).trim()) return res.status(400).json({ error: 'Add a message before publishing' });
    const publish_at = b.publish_at !== undefined ? b.publish_at : existing.publish_at;
    const expires_at = b.expires_at !== undefined ? b.expires_at : existing.expires_at;
    if (publish_at && expires_at && expires_at <= publish_at) return res.status(400).json({ error: 'Expiry must be after the publish time' });
    const pollQuestion = b.poll_question !== undefined ? b.poll_question || null : existing.poll_question;
    const pollOptions = b.poll_options !== undefined ? b.poll_options : null;
    if (pollQuestion && pollOptions && pollOptions.length < 2) return res.status(400).json({ error: 'A poll needs at least 2 options' });
    const removeIds = b.remove_attachment_ids || [];

    // If it was scheduled and is still in the future, keep it unnotified so the scheduler sends it later.
    const stillScheduled = !!publish_at && publish_at > nowIso();
    const notified = existing.notified === 0 || isDraft ? 0 : 1;

    const removedFiles = [];
    await db.tx(async () => {
      await db.run(
        `UPDATE announcements SET title=?, body=?, priority=?, pinned=?, company_id=?, publish_at=?, expires_at=?, ack_required=?, poll_question=?, notified=?, category=?, is_draft=? WHERE id=?`,
        [
          b.title ?? existing.title,
          b.body ?? existing.body,
          b.priority ?? existing.priority,
          b.pinned !== undefined ? (b.pinned ? 1 : 0) : existing.pinned,
          targeting ? targeting.company_id : existing.company_id,
          publish_at,
          expires_at,
          b.ack_required !== undefined ? (b.ack_required ? 1 : 0) : existing.ack_required,
          pollQuestion,
          notified,
          category,
          isDraft ? 1 : 0,
          id,
        ]
      );
      if (targeting) {
        await db.run('DELETE FROM announcement_targets WHERE announcement_id = ?', [id]);
        for (const d of targeting.depts) await db.run('INSERT INTO announcement_targets (announcement_id, department_id) VALUES (?, ?)', [id, d]);
      }
      if (pollOptions) {
        // Replacing options resets votes (labels changed).
        await db.run('DELETE FROM poll_options WHERE announcement_id = ?', [id]);
        if (pollQuestion) {
          for (let i = 0; i < pollOptions.length; i++) await db.run('INSERT INTO poll_options (announcement_id, label, position) VALUES (?, ?, ?)', [id, pollOptions[i], i]);
        }
      } else if (!pollQuestion) {
        await db.run('DELETE FROM poll_options WHERE announcement_id = ?', [id]);
      }
      for (const rid of removeIds) {
        const f = await db.get('SELECT stored_name FROM announcement_attachments WHERE id = ? AND announcement_id = ?', [rid, id]);
        if (f) {
          removedFiles.push(f.stored_name);
          await db.run('DELETE FROM announcement_attachments WHERE id = ?', [rid]);
        }
      }
      for (const f of req.files || []) {
        await db.run('INSERT INTO announcement_attachments (announcement_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)', [
          id,
          f.originalname,
          f.filename,
          f.mimetype,
          f.size,
        ]);
      }
    });
    for (const name of removedFiles) removeStored(name);

    // Publishing a previously scheduled/draft item right now (publish_at in the past / cleared, draft switched off).
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!isDraft && existing.notified === 0 && !stillScheduled) await sendNewAnnouncementNotifications(row, req.user.id);
    else notifyAll('announcements', { id });
    logActivity(req, publishing ? 'announcement.publish' : 'announcement.update', 'announcement', id, { title: row.title });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Announcement not found' });
    if (!canManage(req.user, existing)) return res.status(403).json({ error: 'You can only delete announcements of your own company' });
    for (const f of await db.all('SELECT stored_name FROM announcement_attachments WHERE announcement_id = ?', [id])) removeStored(f.stored_name);
    await db.run('DELETE FROM announcements WHERE id = ?', [id]);
    notifyAll('announcements', { id, deleted: true });
    logActivity(req, 'announcement.delete', 'announcement', id, { title: existing.title });
    res.json({ ok: true });
  })
);

// ---------- attachments ----------
// Opened with a Bearer token (in-app preview) or a ticket from POST /api/auth/ticket (new tab / download).
router.get(
  '/:id/files/:fileId',
  requireAuthOrTicket,
  wrap(async (req, res) => {
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [Number(req.params.id) || 0]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Not found' });
    const f = await db.get('SELECT * FROM announcement_attachments WHERE id = ? AND announcement_id = ?', [Number(req.params.fileId) || 0, row.id]);
    if (!f) return res.status(404).json({ error: 'File not found' });
    fileHeaders(res, { mime: f.mime, filename: f.filename, download: !!req.query.download });
    res.sendFile(path.join(uploadDir, path.basename(f.stored_name)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
    });
  })
);

// ---------- read / acknowledge / vote ----------
router.post(
  '/:id/read',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    await db.run('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT (announcement_id, user_id) DO NOTHING', [
      id,
      req.user.id,
      nowIso(),
    ]);
    notifyUsers(await managerIds(row.company_id), 'announcements', { id });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/acknowledge',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    const now = nowIso();
    await db.run(
      `INSERT INTO announcement_reads (announcement_id, user_id, read_at, acknowledged_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (announcement_id, user_id) DO UPDATE SET acknowledged_at = COALESCE(announcement_reads.acknowledged_at, excluded.acknowledged_at)`,
      [id, req.user.id, now, now]
    );
    notifyUsers(await managerIds(row.company_id), 'announcements', { id });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/vote',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    const { option_id: optionId } = parse(voteBody, req.body);
    const opt = await db.get('SELECT id FROM poll_options WHERE id = ? AND announcement_id = ?', [optionId, id]);
    if (!opt) return res.status(400).json({ error: 'Choose one of the options' });
    const now = nowIso();
    await db.run(
      `INSERT INTO poll_votes (announcement_id, user_id, option_id, voted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (announcement_id, user_id) DO UPDATE SET option_id = excluded.option_id, voted_at = excluded.voted_at`,
      [id, req.user.id, optionId, now]
    );
    await db.run('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT (announcement_id, user_id) DO NOTHING', [id, req.user.id, now]);
    notifyAll('announcements', { id });
    res.json({ ok: true, poll: await pollFor(id, req.user.id) });
  })
);

export default router;
