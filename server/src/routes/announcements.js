import { Router } from 'express';
import path from 'node:path';
import { db, audienceUserIds, visibilitySql, nowIso } from '../db.js';
import { requireAuth, requireAdmin, wrap } from '../auth.js';
import { createNotifications, adminIds } from '../notify.js';
import { notifyAll, notifyUsers } from '../events.js';
import { attachmentUpload, uploadDir, removeStored } from '../uploads.js';

const router = Router();
router.use(requireAuth);

// ---------- helpers ----------
function targetsFor(id) {
  return db.all(`SELECT d.id, d.name FROM announcement_targets t JOIN departments d ON d.id = t.department_id WHERE t.announcement_id = ? ORDER BY d.name`, [id]);
}
function attachmentsFor(id) {
  return db.all('SELECT id, filename, mime, size FROM announcement_attachments WHERE announcement_id = ? ORDER BY id', [id]);
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
async function audienceFor(row, excludeUserId = null) {
  const targets = await targetsFor(row.id);
  return audienceUserIds(row.company_id, targets.map((t) => t.id), excludeUserId);
}
function isLive(row) {
  const now = nowIso();
  return (!row.publish_at || row.publish_at <= now) && (!row.expires_at || row.expires_at > now);
}
async function canSee(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
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

async function shape(row, user) {
  const now = nowIso();
  const out = {
    ...row,
    read_by_me: !!row.read_by_me,
    acked_by_me: !!row.acked_by_me,
    pinned: !!row.pinned,
    ack_required: !!row.ack_required,
    status: row.publish_at && row.publish_at > now ? 'scheduled' : row.expires_at && row.expires_at <= now ? 'expired' : 'live',
    targets: await targetsFor(row.id),
    attachments: await attachmentsFor(row.id),
    poll: row.poll_question ? { question: row.poll_question, ...(await pollFor(row.id, user.id)) } : null,
  };
  delete out.notified;
  if (user.role === 'admin') out.audience_count = (await audienceFor(row)).length;
  return out;
}

async function parseTargeting(body) {
  const company_id = Number(body?.company_id) || null;
  let depts = body?.department_ids;
  if (typeof depts === 'string') {
    try { depts = JSON.parse(depts); } catch { depts = []; }
  }
  depts = Array.isArray(depts) ? depts.map(Number).filter(Boolean) : [];
  if (company_id && !(await db.get('SELECT 1 FROM companies WHERE id = ?', [company_id]))) return 'Company not found';
  if (depts.length > 0) {
    if (!company_id) return 'Choose a company before picking departments';
    const rows = await db.all(`SELECT id FROM departments WHERE company_id = ? AND id IN (${depts.map(() => '?').join(',')})`, [company_id, ...depts]);
    if (rows.length !== depts.length) return 'One of the departments does not belong to that company';
  }
  return { company_id, depts };
}

function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function parsePollOptions(v) {
  if (v === undefined || v === null || v === '') return [];
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { arr = v.split('\n'); }
  }
  return (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
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
  const due = await db.all('SELECT * FROM announcements WHERE notified = 0 AND publish_at IS NOT NULL AND publish_at <= ?', [nowIso()]);
  for (const a of due) await sendNewAnnouncementNotifications(a, null);
  return due.length;
}

async function shapeAll(rows, user) {
  const out = [];
  for (const r of rows) out.push(await shape(r, user));
  return out;
}

// ---------- list / detail ----------
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user.id;
    let rows;
    if (req.user.role === 'admin') {
      rows = await db.all(`${baseSelect} ORDER BY a.pinned DESC, COALESCE(a.publish_at, a.created_at) DESC`, { me });
    } else {
      rows = await db.all(`${baseSelect} WHERE ${visibilitySql('a', 'announcement_targets', 'announcement_id')} ORDER BY a.pinned DESC, COALESCE(a.publish_at, a.created_at) DESC`, {
        me,
        company: req.user.company_id ?? -1,
        dept: req.user.department_id ?? -1,
        nowTs: nowIso(),
      });
    }
    res.json({ announcements: await shapeAll(rows, req.user) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get(`${baseSelect} WHERE a.id = @id`, { me: req.user.id, id });
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    const out = await shape(row, req.user);
    if (req.user.role === 'admin') {
      const audience = await audienceFor(row);
      const placeholders = audience.map(() => '?').join(',') || 'NULL';
      const people = await db.all(
        `SELECT u.id, u.name, u.email, d.name AS department_name, c.name AS company_name, r.read_at, r.acknowledged_at,
                (SELECT o.label FROM poll_votes v JOIN poll_options o ON o.id = v.option_id WHERE v.announcement_id = ? AND v.user_id = u.id) AS poll_answer
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN companies c ON c.id = u.company_id
         LEFT JOIN announcement_reads r ON r.user_id = u.id AND r.announcement_id = ?
         WHERE u.id IN (${placeholders}) ORDER BY (r.read_at IS NULL), u.name`,
        [id, id, ...audience]
      );
      out.readers = people.filter((p) => p.read_at);
      out.unread = people.filter((p) => !p.read_at);
    }
    res.json({ announcement: out });
  })
);

// ---------- create / update ----------
// Accepts JSON or multipart/form-data (when files are attached).
router.post(
  '/',
  requireAdmin,
  attachmentUpload.array('files', 5),
  wrap(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const body = String(b.body || '').trim();
    const priority = b.priority || 'normal';
    if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
    if (!['normal', 'important', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    const targeting = await parseTargeting(b);
    if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
    const publish_at = parseDate(b.publish_at);
    const expires_at = parseDate(b.expires_at);
    if (publish_at === undefined || expires_at === undefined) return res.status(400).json({ error: 'Invalid date' });
    if (publish_at && expires_at && expires_at <= publish_at) return res.status(400).json({ error: 'Expiry must be after the publish time' });
    const pollQuestion = String(b.poll_question || '').trim() || null;
    const pollOptions = parsePollOptions(b.poll_options);
    if (pollQuestion && pollOptions.length < 2) return res.status(400).json({ error: 'A poll needs at least 2 options' });

    const scheduled = !!publish_at && publish_at > nowIso();
    const id = await db.tx(async () => {
      const { id: newId } = await db.run(
        `INSERT INTO announcements (title, body, priority, pinned, company_id, author_id, publish_at, expires_at, ack_required, poll_question, notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [title, body, priority, bool(b.pinned) ? 1 : 0, targeting.company_id, req.user.id, publish_at, expires_at, bool(b.ack_required) ? 1 : 0, pollQuestion, scheduled ? 0 : 1]
      );
      for (const d of targeting.depts) await db.run('INSERT INTO announcement_targets (announcement_id, department_id) VALUES (?, ?)', [newId, d]);
      if (pollQuestion) {
        for (let i = 0; i < pollOptions.length; i++) await db.run('INSERT INTO poll_options (announcement_id, label, position) VALUES (?, ?, ?)', [newId, pollOptions[i], i]);
      }
      for (const f of req.files || []) {
        await db.run('INSERT INTO announcement_attachments (announcement_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)', [newId, f.originalname, f.filename, f.mimetype, f.size]);
      }
      return newId;
    });

    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!scheduled) await sendNewAnnouncementNotifications(row, req.user.id);
    else notifyAll('announcements', { id });
    const full = await db.get(`${baseSelect} WHERE a.id = @id`, { me: req.user.id, id });
    res.status(201).json({ announcement: await shape(full, req.user) });
  })
);

router.patch(
  '/:id',
  requireAdmin,
  attachmentUpload.array('files', 5),
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Announcement not found' });
    const b = req.body || {};
    const retarget = b.company_id !== undefined || b.department_ids !== undefined;
    let targeting = null;
    if (retarget) {
      targeting = await parseTargeting({ company_id: b.company_id ?? existing.company_id, department_ids: b.department_ids ?? (await targetsFor(id)).map((t) => t.id) });
      if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
    }
    const publish_at = b.publish_at !== undefined ? parseDate(b.publish_at) : existing.publish_at;
    const expires_at = b.expires_at !== undefined ? parseDate(b.expires_at) : existing.expires_at;
    if (publish_at === undefined || expires_at === undefined) return res.status(400).json({ error: 'Invalid date' });
    if (publish_at && expires_at && expires_at <= publish_at) return res.status(400).json({ error: 'Expiry must be after the publish time' });
    const pollQuestion = b.poll_question !== undefined ? String(b.poll_question || '').trim() || null : existing.poll_question;
    const pollOptions = b.poll_options !== undefined ? parsePollOptions(b.poll_options) : null;
    if (pollQuestion && pollOptions && pollOptions.length < 2) return res.status(400).json({ error: 'A poll needs at least 2 options' });
    let removeIds = b.remove_attachment_ids;
    if (typeof removeIds === 'string') { try { removeIds = JSON.parse(removeIds); } catch { removeIds = []; } }
    removeIds = Array.isArray(removeIds) ? removeIds.map(Number).filter(Boolean) : [];

    // If it was scheduled and is still in the future, keep it unnotified so the scheduler sends it later.
    const stillScheduled = !!publish_at && publish_at > nowIso();
    const notified = existing.notified === 0 ? 0 : 1;

    const removedFiles = [];
    await db.tx(async () => {
      await db.run(
        `UPDATE announcements SET title=?, body=?, priority=?, pinned=?, company_id=?, publish_at=?, expires_at=?, ack_required=?, poll_question=?, notified=? WHERE id=?`,
        [
          b.title !== undefined ? String(b.title).trim() : existing.title,
          b.body !== undefined ? String(b.body).trim() : existing.body,
          b.priority !== undefined ? b.priority : existing.priority,
          b.pinned !== undefined ? (bool(b.pinned) ? 1 : 0) : existing.pinned,
          targeting ? targeting.company_id : existing.company_id,
          publish_at, expires_at,
          b.ack_required !== undefined ? (bool(b.ack_required) ? 1 : 0) : existing.ack_required,
          pollQuestion, notified, id,
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
        await db.run('INSERT INTO announcement_attachments (announcement_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)', [id, f.originalname, f.filename, f.mimetype, f.size]);
      }
    });
    for (const name of removedFiles) removeStored(name);

    // Publishing a previously scheduled item right now (publish_at moved to the past / cleared).
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (existing.notified === 0 && !stillScheduled) await sendNewAnnouncementNotifications(row, req.user.id);
    else notifyAll('announcements', { id });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    for (const f of await db.all('SELECT stored_name FROM announcement_attachments WHERE announcement_id = ?', [id])) removeStored(f.stored_name);
    await db.run('DELETE FROM announcements WHERE id = ?', [id]);
    notifyAll('announcements', { id, deleted: true });
    res.json({ ok: true });
  })
);

// ---------- attachments ----------
router.get(
  '/:id/files/:fileId',
  wrap(async (req, res) => {
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [Number(req.params.id) || 0]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Not found' });
    const f = await db.get('SELECT * FROM announcement_attachments WHERE id = ? AND announcement_id = ?', [Number(req.params.fileId) || 0, row.id]);
    if (!f) return res.status(404).json({ error: 'File not found' });
    const inline = f.mime.startsWith('image/') || f.mime === 'application/pdf';
    res.setHeader('Content-Disposition', `${req.query.download || !inline ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.type(f.mime);
    res.sendFile(path.join(uploadDir, path.basename(f.stored_name)));
  })
);

// ---------- read / acknowledge / vote ----------
router.post(
  '/:id/read',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    await db.run('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT (announcement_id, user_id) DO NOTHING', [id, req.user.id, nowIso()]);
    notifyUsers(await adminIds(), 'announcements', { id });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/acknowledge',
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
    notifyUsers(await adminIds(), 'announcements', { id });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/vote',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Announcement not found' });
    const optionId = Number(req.body?.option_id) || 0;
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
