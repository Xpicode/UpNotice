import { Router } from 'express';
import crypto from 'node:crypto';
import { db, audienceUserIds, visibilitySql, nowIso } from '../db.js';
import { requireAuth, requireAdmin, wrap } from '../auth.js';
import { createNotifications, adminIds } from '../notify.js';
import { notifyAll, notifyUsers } from '../events.js';

const router = Router();
router.use(requireAuth);

function targetsFor(id) {
  return db.all(
    `SELECT d.id, d.name FROM meeting_targets t JOIN departments d ON d.id = t.department_id
     WHERE t.meeting_id = ? ORDER BY d.name`,
    [id]
  );
}

async function audienceFor(row, excludeUserId = null) {
  const targets = await targetsFor(row.id);
  return audienceUserIds(row.company_id, targets.map((t) => t.id), excludeUserId);
}

async function canSee(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  if (row.company_id && row.company_id !== user.company_id) return false;
  const targets = await targetsFor(row.id);
  if (targets.length === 0) return true;
  return targets.some((t) => t.id === user.department_id);
}

const baseSelect = `
  SELECT m.*, u.name AS organizer_name, c.name AS company_name,
         (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.status = 'going') AS going_count,
         (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.status = 'maybe') AS maybe_count,
         (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.status = 'declined') AS declined_count,
         (SELECT status FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.user_id = @me) AS my_rsvp,
         (SELECT note FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.user_id = @me) AS my_rsvp_note,
         (SELECT COUNT(*) FROM comments cm WHERE cm.ref_type = 'meeting' AND cm.ref_id = m.id) AS comment_count
  FROM meetings m JOIN users u ON u.id = m.organizer_id LEFT JOIN companies c ON c.id = m.company_id`;

async function shape(row, user) {
  const out = { ...row, targets: await targetsFor(row.id) };
  delete out.reminder_sent;
  if (user.role === 'admin') out.audience_count = (await audienceFor(row)).length;
  return out;
}

async function shapeAll(rows, user) {
  const out = [];
  for (const r of rows) out.push(await shape(r, user));
  return out;
}

function isValidDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

async function parseTargeting(body) {
  const company_id = Number(body?.company_id) || null;
  const depts = Array.isArray(body?.department_ids) ? body.department_ids.map(Number).filter(Boolean) : [];
  if (company_id && !(await db.get('SELECT 1 FROM companies WHERE id = ?', [company_id]))) return 'Company not found';
  if (depts.length > 0) {
    if (!company_id) return 'Choose a company before picking departments';
    const rows = await db.all(`SELECT id FROM departments WHERE company_id = ? AND id IN (${depts.map(() => '?').join(',')})`, [company_id, ...depts]);
    if (rows.length !== depts.length) return 'One of the departments does not belong to that company';
  }
  return { company_id, depts };
}

// ?scope=upcoming (default) | past | all
router.get(
  '/',
  wrap(async (req, res) => {
    const me = req.user.id;
    const scope = req.query.scope || 'upcoming';
    const now = nowIso();
    const timeFilter = scope === 'past' ? 'm.ends_at < @now' : scope === 'all' ? '1=1' : 'm.ends_at >= @now';
    const order = scope === 'past' ? 'ORDER BY m.starts_at DESC' : 'ORDER BY m.starts_at ASC';
    let rows;
    if (req.user.role === 'admin') {
      rows = await db.all(`${baseSelect} WHERE ${timeFilter} ${order}`, { me, now });
    } else {
      rows = await db.all(`${baseSelect} WHERE ${timeFilter} AND ${visibilitySql('m', 'meeting_targets', 'meeting_id')} ${order}`, {
        me,
        now,
        company: req.user.company_id ?? -1,
        dept: req.user.department_id ?? -1,
      });
    }
    res.json({ meetings: await shapeAll(rows, req.user) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get(`${baseSelect} WHERE m.id = @id`, { me: req.user.id, id });
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Meeting not found' });
    const out = await shape(row, req.user);
    if (req.user.role === 'admin') {
      const audience = await audienceFor(row);
      const placeholders = audience.map(() => '?').join(',') || 'NULL';
      out.attendees = await db.all(
        `SELECT u.id, u.name, u.email, d.name AS department_name, c.name AS company_name, r.status, r.note, r.responded_at
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN companies c ON c.id = u.company_id
         LEFT JOIN meeting_rsvps r ON r.user_id = u.id AND r.meeting_id = ?
         WHERE u.id IN (${placeholders}) ORDER BY (r.status IS NULL), r.status, u.name`,
        [id, ...audience]
      );
    }
    res.json({ meeting: out });
  })
);

const RECURRENCES = {
  weekly: { step: (d) => d.setDate(d.getDate() + 7), label: 'weekly' },
  biweekly: { step: (d) => d.setDate(d.getDate() + 14), label: 'every 2 weeks' },
  monthly: { step: (d) => d.setMonth(d.getMonth() + 1), label: 'monthly' },
};

function fmtWhen(iso) {
  return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.TZ_DISPLAY || 'Asia/Manila' });
}

router.post(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    const { title, description = '', starts_at, ends_at, location = '', link = '', recurrence = null } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!isValidDate(starts_at) || !isValidDate(ends_at)) return res.status(400).json({ error: 'Start and end time are required' });
    if (Date.parse(ends_at) <= Date.parse(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });
    if (recurrence && !RECURRENCES[recurrence]) return res.status(400).json({ error: 'Invalid repeat option' });
    const count = recurrence ? Math.min(Math.max(Number(req.body.occurrences) || 12, 2), 52) : 1;
    const targeting = await parseTargeting(req.body);
    if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
    const { company_id, depts } = targeting;

    const seriesId = recurrence ? crypto.randomUUID() : null;
    const duration = Date.parse(ends_at) - Date.parse(starts_at);
    const ids = await db.tx(async () => {
      const out = [];
      const start = new Date(starts_at);
      for (let i = 0; i < count; i++) {
        const s = new Date(start);
        const e = new Date(s.getTime() + duration);
        const { id } = await db.run(
          'INSERT INTO meetings (title, description, starts_at, ends_at, location, link, company_id, organizer_id, series_id, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          [String(title).trim(), String(description).trim(), s.toISOString(), e.toISOString(), String(location).trim(), String(link).trim(), company_id, req.user.id, seriesId, recurrence]
        );
        for (const d of depts) await db.run('INSERT INTO meeting_targets (meeting_id, department_id) VALUES (?, ?)', [id, d]);
        out.push(id);
        if (recurrence) RECURRENCES[recurrence].step(start);
      }
      return out;
    });
    const id = ids[0];

    const audience = await audienceUserIds(company_id, depts, req.user.id);
    const repeatNote = recurrence ? ` (repeats ${RECURRENCES[recurrence].label}, ${count} times)` : '';
    await createNotifications(audience, {
      type: 'meeting',
      title: `Meeting invite: ${String(title).trim()}`,
      body: `${fmtWhen(starts_at)}${location ? ' · ' + location : ''}${repeatNote}`,
      refType: 'meeting',
      refId: id,
    });
    notifyAll('meetings', { id });

    const row = await db.get(`${baseSelect} WHERE m.id = @id`, { me: req.user.id, id });
    res.status(201).json({ meeting: await shape(row, req.user), created: ids.length });
  })
);

/** Called by the scheduler every minute: remind attendees ~1 hour before start. */
export async function sendMeetingReminders() {
  const now = Date.now();
  const rows = await db.all("SELECT * FROM meetings WHERE status = 'scheduled' AND reminder_sent = 0 AND starts_at > ? AND starts_at <= ?", [
    new Date(now).toISOString(),
    new Date(now + 60 * 60 * 1000).toISOString(),
  ]);
  for (const m of rows) {
    const audience = await audienceFor(m);
    const declined = new Set((await db.all("SELECT user_id FROM meeting_rsvps WHERE meeting_id = ? AND status = 'declined'", [m.id])).map((r) => r.user_id));
    const recipients = audience.filter((u) => !declined.has(u));
    const mins = Math.max(1, Math.round((Date.parse(m.starts_at) - now) / 60000));
    await createNotifications(recipients, {
      type: 'meeting',
      title: `Reminder: ${m.title} in ${mins} min`,
      body: `${fmtWhen(m.starts_at)}${m.location ? ' · ' + m.location : ''}`,
      refType: 'meeting',
      refId: m.id,
    });
    await db.run('UPDATE meetings SET reminder_sent = 1 WHERE id = ?', [m.id]);
  }
  return rows.length;
}

router.patch(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Meeting not found' });
    const { title, description, starts_at, ends_at, location, link, status } = req.body || {};
    if ((starts_at !== undefined && !isValidDate(starts_at)) || (ends_at !== undefined && !isValidDate(ends_at))) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    const next = {
      title: title !== undefined ? String(title).trim() : existing.title,
      description: description !== undefined ? String(description).trim() : existing.description,
      starts_at: starts_at !== undefined ? new Date(starts_at).toISOString() : existing.starts_at,
      ends_at: ends_at !== undefined ? new Date(ends_at).toISOString() : existing.ends_at,
      location: location !== undefined ? String(location).trim() : existing.location,
      link: link !== undefined ? String(link).trim() : existing.link,
      status: status !== undefined ? status : existing.status,
      company_id: existing.company_id,
    };
    if (!['scheduled', 'cancelled'].includes(next.status)) return res.status(400).json({ error: 'Invalid status' });
    if (Date.parse(next.ends_at) <= Date.parse(next.starts_at)) return res.status(400).json({ error: 'End time must be after start time' });

    const retarget = req.body?.company_id !== undefined || Array.isArray(req.body?.department_ids);
    let targeting = null;
    if (retarget) {
      targeting = await parseTargeting({ company_id: req.body.company_id ?? existing.company_id, department_ids: req.body.department_ids ?? (await targetsFor(id)).map((t) => t.id) });
      if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
      next.company_id = targeting.company_id;
    }

    await db.tx(async () => {
      await db.run(
        `UPDATE meetings SET title=@title, description=@description, starts_at=@starts_at, ends_at=@ends_at,
         location=@location, link=@link, status=@status, company_id=@company_id WHERE id=@id`,
        { ...next, id }
      );
      if (targeting) {
        await db.run('DELETE FROM meeting_targets WHERE meeting_id = ?', [id]);
        for (const d of targeting.depts) await db.run('INSERT INTO meeting_targets (meeting_id, department_id) VALUES (?, ?)', [id, d]);
      }
    });

    const audience = await audienceFor({ id, company_id: next.company_id }, req.user.id);
    const changed = next.starts_at !== existing.starts_at || next.ends_at !== existing.ends_at || next.location !== existing.location;
    if (next.status === 'cancelled' && existing.status !== 'cancelled') {
      await createNotifications(audience, { type: 'meeting', title: `Meeting cancelled: ${next.title}`, refType: 'meeting', refId: id });
    } else if (changed) {
      await createNotifications(audience, { type: 'meeting', title: `Meeting updated: ${next.title}`, body: 'Time or place has changed — please check the details.', refType: 'meeting', refId: id });
    }
    notifyAll('meetings', { id });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const m = await db.get('SELECT series_id, starts_at FROM meetings WHERE id = ?', [id]);
    if (!m) return res.status(404).json({ error: 'Meeting not found' });
    if (req.query.series === 'all' && m.series_id) {
      await db.run('DELETE FROM meetings WHERE series_id = ?', [m.series_id]);
    } else if (req.query.series === 'future' && m.series_id) {
      await db.run('DELETE FROM meetings WHERE series_id = ? AND starts_at >= ?', [m.series_id, m.starts_at]);
    } else {
      await db.run('DELETE FROM meetings WHERE id = ?', [id]);
    }
    notifyAll('meetings', { id, deleted: true });
    res.json({ ok: true });
  })
);

router.post(
  '/:id/rsvp',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const { status } = req.body || {};
    // "Going" needs no explanation; "Maybe" and "Can't go" must say why so the organizer knows.
    const note = status === 'going' ? '' : String(req.body?.note || '').trim().slice(0, 300);
    if (!['going', 'maybe', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid RSVP' });
    if (status !== 'going' && !note) return res.status(400).json({ error: 'Please add a short reason' });
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!(await canSee(req.user, meeting))) return res.status(404).json({ error: 'Meeting not found' });
    if (meeting.status === 'cancelled') return res.status(400).json({ error: 'This meeting was cancelled' });
    await db.run(
      `INSERT INTO meeting_rsvps (meeting_id, user_id, status, note, responded_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = excluded.status, note = excluded.note, responded_at = excluded.responded_at`,
      [id, req.user.id, status, note, nowIso()]
    );
    notifyUsers(await adminIds(), 'meetings', { id });
    res.json({ ok: true, status, note });
  })
);

export default router;
