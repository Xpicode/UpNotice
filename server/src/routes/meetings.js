import { Router } from 'express';
import crypto from 'node:crypto';
import { db, audienceUserIds, visibilitySql, nowIso } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { createNotifications, adminIds } from '../notify.js';
import { notifyAll, notifyUsers } from '../events.js';

const router = Router();
router.use(requireAuth);

function targetsFor(id) {
  return db
    .prepare(
      `SELECT d.id, d.name FROM meeting_targets t JOIN departments d ON d.id = t.department_id
       WHERE t.meeting_id = ? ORDER BY d.name`
    )
    .all(id);
}

function audienceFor(row, excludeUserId = null) {
  return audienceUserIds(row.company_id, targetsFor(row.id).map((t) => t.id), excludeUserId);
}

function canSee(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  if (row.company_id && row.company_id !== user.company_id) return false;
  const targets = targetsFor(row.id);
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

function shape(row, user) {
  const out = { ...row, targets: targetsFor(row.id) };
  delete out.reminder_sent;
  if (user.role === 'admin') out.audience_count = audienceFor(row).length;
  return out;
}

function isValidDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function parseTargeting(body) {
  const company_id = Number(body?.company_id) || null;
  const depts = Array.isArray(body?.department_ids) ? body.department_ids.map(Number).filter(Boolean) : [];
  if (company_id && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(company_id)) return 'Company not found';
  if (depts.length > 0) {
    if (!company_id) return 'Choose a company before picking departments';
    const rows = db.prepare(`SELECT id FROM departments WHERE company_id = ? AND id IN (${depts.map(() => '?').join(',')})`).all(company_id, ...depts);
    if (rows.length !== depts.length) return 'One of the departments does not belong to that company';
  }
  return { company_id, depts };
}

// ?scope=upcoming (default) | past | all
router.get('/', (req, res) => {
  const me = req.user.id;
  const scope = req.query.scope || 'upcoming';
  const nowIso = new Date().toISOString();
  const timeFilter = scope === 'past' ? 'm.ends_at < @now' : scope === 'all' ? '1=1' : 'm.ends_at >= @now';
  const order = scope === 'past' ? 'ORDER BY m.starts_at DESC' : 'ORDER BY m.starts_at ASC';
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare(`${baseSelect} WHERE ${timeFilter} ${order}`).all({ me, now: nowIso });
  } else {
    rows = db
      .prepare(`${baseSelect} WHERE ${timeFilter} AND ${visibilitySql('m', 'meeting_targets', 'meeting_id')} ${order}`)
      .all({ me, now: nowIso, company: req.user.company_id ?? -1, dept: req.user.department_id ?? -1 });
  }
  res.json({ meetings: rows.map((r) => shape(r, req.user)) });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`${baseSelect} WHERE m.id = @id`).get({ me: req.user.id, id });
  if (!canSee(req.user, row)) return res.status(404).json({ error: 'Meeting not found' });
  const out = shape(row, req.user);
  if (req.user.role === 'admin') {
    const audience = audienceFor(row);
    const placeholders = audience.map(() => '?').join(',') || 'NULL';
    out.attendees = db
      .prepare(
        `SELECT u.id, u.name, u.email, d.name AS department_name, c.name AS company_name, r.status, r.note, r.responded_at
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN companies c ON c.id = u.company_id
         LEFT JOIN meeting_rsvps r ON r.user_id = u.id AND r.meeting_id = ?
         WHERE u.id IN (${placeholders}) ORDER BY r.status IS NULL, r.status, u.name`
      )
      .all(id, ...audience);
  }
  res.json({ meeting: out });
});

const RECURRENCES = { weekly: { step: (d) => d.setDate(d.getDate() + 7), label: 'weekly' }, biweekly: { step: (d) => d.setDate(d.getDate() + 14), label: 'every 2 weeks' }, monthly: { step: (d) => d.setMonth(d.getMonth() + 1), label: 'monthly' } };

function fmtWhen(iso) {
  return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.TZ_DISPLAY || 'Asia/Manila' });
}

router.post('/', requireAdmin, (req, res) => {
  const { title, description = '', starts_at, ends_at, location = '', link = '', recurrence = null } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!isValidDate(starts_at) || !isValidDate(ends_at)) return res.status(400).json({ error: 'Start and end time are required' });
  if (Date.parse(ends_at) <= Date.parse(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });
  if (recurrence && !RECURRENCES[recurrence]) return res.status(400).json({ error: 'Invalid repeat option' });
  const count = recurrence ? Math.min(Math.max(Number(req.body.occurrences) || 12, 2), 52) : 1;
  const targeting = parseTargeting(req.body);
  if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
  const { company_id, depts } = targeting;

  const seriesId = recurrence ? crypto.randomUUID() : null;
  const duration = Date.parse(ends_at) - Date.parse(starts_at);
  const ids = db.transaction(() => {
    const out = [];
    const start = new Date(starts_at);
    const insM = db.prepare(
      'INSERT INTO meetings (title, description, starts_at, ends_at, location, link, company_id, organizer_id, series_id, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insT = db.prepare('INSERT INTO meeting_targets (meeting_id, department_id) VALUES (?, ?)');
    for (let i = 0; i < count; i++) {
      const s = new Date(start);
      const e = new Date(s.getTime() + duration);
      const id = insM.run(String(title).trim(), String(description).trim(), s.toISOString(), e.toISOString(), String(location).trim(), String(link).trim(), company_id, req.user.id, seriesId, recurrence).lastInsertRowid;
      for (const d of depts) insT.run(id, d);
      out.push(id);
      if (recurrence) RECURRENCES[recurrence].step(start);
    }
    return out;
  })();
  const id = ids[0];

  const audience = audienceUserIds(company_id, depts, req.user.id);
  const repeatNote = recurrence ? ` (repeats ${RECURRENCES[recurrence].label}, ${count} times)` : '';
  createNotifications(audience, { type: 'meeting', title: `Meeting invite: ${String(title).trim()}`, body: `${fmtWhen(starts_at)}${location ? ' · ' + location : ''}${repeatNote}`, refType: 'meeting', refId: id });
  notifyAll('meetings', { id });

  const row = db.prepare(`${baseSelect} WHERE m.id = @id`).get({ me: req.user.id, id });
  res.status(201).json({ meeting: shape(row, req.user), created: ids.length });
});

/** Called by the scheduler every minute: remind attendees ~1 hour before start. */
export function sendMeetingReminders() {
  const now = Date.now();
  const rows = db
    .prepare("SELECT * FROM meetings WHERE status = 'scheduled' AND reminder_sent = 0 AND starts_at > ? AND starts_at <= ?")
    .all(new Date(now).toISOString(), new Date(now + 60 * 60 * 1000).toISOString());
  for (const m of rows) {
    const audience = audienceUserIds(m.company_id, targetsFor(m.id).map((t) => t.id));
    const declined = new Set(db.prepare("SELECT user_id FROM meeting_rsvps WHERE meeting_id = ? AND status = 'declined'").all(m.id).map((r) => r.user_id));
    const recipients = audience.filter((u) => !declined.has(u));
    const mins = Math.max(1, Math.round((Date.parse(m.starts_at) - now) / 60000));
    createNotifications(recipients, { type: 'meeting', title: `Reminder: ${m.title} in ${mins} min`, body: `${fmtWhen(m.starts_at)}${m.location ? ' · ' + m.location : ''}`, refType: 'meeting', refId: m.id });
    db.prepare('UPDATE meetings SET reminder_sent = 1 WHERE id = ?').run(m.id);
  }
  return rows.length;
}

router.patch('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Meeting not found' });
  const { title, description, starts_at, ends_at, location, link, status } = req.body || {};
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
    targeting = parseTargeting({ company_id: req.body.company_id ?? existing.company_id, department_ids: req.body.department_ids ?? targetsFor(id).map((t) => t.id) });
    if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
    next.company_id = targeting.company_id;
  }

  const update = db.transaction(() => {
    db.prepare(
      `UPDATE meetings SET title=@title, description=@description, starts_at=@starts_at, ends_at=@ends_at,
       location=@location, link=@link, status=@status, company_id=@company_id WHERE id=@id`
    ).run({ ...next, id });
    if (targeting) {
      db.prepare('DELETE FROM meeting_targets WHERE meeting_id = ?').run(id);
      const ins = db.prepare('INSERT INTO meeting_targets (meeting_id, department_id) VALUES (?, ?)');
      for (const d of targeting.depts) ins.run(id, d);
    }
  });
  update();

  const audience = audienceFor({ id, company_id: next.company_id }, req.user.id);
  const changed = next.starts_at !== existing.starts_at || next.ends_at !== existing.ends_at || next.location !== existing.location;
  if (next.status === 'cancelled' && existing.status !== 'cancelled') {
    createNotifications(audience, { type: 'meeting', title: `Meeting cancelled: ${next.title}`, refType: 'meeting', refId: id });
  } else if (changed) {
    createNotifications(audience, { type: 'meeting', title: `Meeting updated: ${next.title}`, body: 'Time or place has changed — please check the details.', refType: 'meeting', refId: id });
  }
  notifyAll('meetings', { id });
  res.json({ ok: true });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare('SELECT series_id, starts_at FROM meetings WHERE id = ?').get(id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (req.query.series === 'all' && m.series_id) {
    db.prepare('DELETE FROM meetings WHERE series_id = ?').run(m.series_id);
  } else if (req.query.series === 'future' && m.series_id) {
    db.prepare('DELETE FROM meetings WHERE series_id = ? AND starts_at >= ?').run(m.series_id, m.starts_at);
  } else {
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  }
  notifyAll('meetings', { id, deleted: true });
  res.json({ ok: true });
});

router.post('/:id/rsvp', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  // "Going" needs no explanation; "Maybe" and "Can't go" must say why so the organizer knows.
  const note = status === 'going' ? '' : String(req.body?.note || '').trim().slice(0, 300);
  if (!['going', 'maybe', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid RSVP' });
  if (status !== 'going' && !note) return res.status(400).json({ error: 'Please add a short reason' });
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!canSee(req.user, meeting)) return res.status(404).json({ error: 'Meeting not found' });
  if (meeting.status === 'cancelled') return res.status(400).json({ error: 'This meeting was cancelled' });
  db.prepare(
    `INSERT INTO meeting_rsvps (meeting_id, user_id, status, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(meeting_id, user_id) DO UPDATE SET status = excluded.status, note = excluded.note, responded_at = datetime('now')`
  ).run(id, req.user.id, status, note);
  notifyUsers(adminIds(), 'meetings', { id });
  res.json({ ok: true, status, note });
});

export default router;
