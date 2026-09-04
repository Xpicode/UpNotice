import { Router } from 'express';
import crypto from 'node:crypto';
import { db, audienceUserIds, visibilitySql, nowIso, shortCode } from '../db.js';
import { requireAuth, requireStaff, isStaff, canManage, wrap } from '../auth.js';
import { createNotifications, managerIds } from '../notify.js';
import { logActivity } from '../activity.js';
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
  return (await audienceUserIds(row.company_id, targets.map((t) => t.id), excludeUserId)).filter((id) => id !== row.organizer_id);
}

async function canSee(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'manager' && row.company_id != null && row.company_id === user.company_id) return true;
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
         (SELECT COUNT(*) FROM comments cm WHERE cm.ref_type = 'meeting' AND cm.ref_id = m.id) AS comment_count,
         (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = m.id) AS attended_count,
         EXISTS(SELECT 1 FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.user_id = @me) AS attended_by_me
  FROM meetings m JOIN users u ON u.id = m.organizer_id LEFT JOIN companies c ON c.id = m.company_id`;

async function shape(row, user) {
  const out = { ...row, targets: await targetsFor(row.id), attended_by_me: !!row.attended_by_me, has_minutes: !!(row.minutes && row.minutes.trim()), can_manage: canManage(user, row) };
  delete out.reminder_sent;
  if (!canManage(user, row)) delete out.checkin_code;
  if (isStaff(user)) out.audience_count = (await audienceFor(row)).length;
  return out;
}

/** ?q= ?company_id= ?department_id= ?from= ?to= */
function listFilters(query, params) {
  const where = [];
  const q = String(query.q || '').trim().toLowerCase();
  if (q) {
    where.push('(LOWER(m.title) LIKE @q OR LOWER(m.description) LIKE @q OR LOWER(m.location) LIKE @q)');
    params.q = `%${q}%`;
  }
  if (query.company_id) {
    where.push('m.company_id = @companyFilter');
    params.companyFilter = Number(query.company_id) || 0;
  }
  if (query.department_id) {
    where.push('EXISTS (SELECT 1 FROM meeting_targets ft WHERE ft.meeting_id = m.id AND ft.department_id = @deptFilter)');
    params.deptFilter = Number(query.department_id) || 0;
  }
  if (query.from) {
    where.push('m.starts_at >= @from');
    params.from = new Date(query.from).toISOString();
  }
  if (query.to) {
    where.push('m.starts_at < @to');
    params.to = new Date(new Date(query.to).getTime() + 86400000).toISOString();
  }
  return where;
}

async function shapeAll(rows, user) {
  const out = [];
  for (const r of rows) out.push(await shape(r, user));
  return out;
}

function isValidDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

async function parseTargeting(body, user = null) {
  const company_id = Number(body?.company_id) || null;
  if (user?.role === 'manager' && company_id !== user.company_id) return 'Managers can only schedule meetings for their own company';
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
    const params = { me, now, company: req.user.company_id ?? -1, dept: req.user.department_id ?? -1 };
    const where = [timeFilter, ...listFilters(req.query, params)];
    if (req.user.role === 'manager') where.push(`(m.company_id = @company OR (${visibilitySql('m', 'meeting_targets', 'meeting_id')}))`);
    else if (req.user.role !== 'admin') where.push(visibilitySql('m', 'meeting_targets', 'meeting_id'));
    const rows = await db.all(`${baseSelect} WHERE ${where.join(' AND ')} ${order}`, params);
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
    if (canManage(req.user, row)) {
      // Check-in code for the QR / "enter code" attendance; created the first time staff open the meeting.
      if (!row.checkin_code) {
        out.checkin_code = shortCode();
        await db.run('UPDATE meetings SET checkin_code = ? WHERE id = ?', [out.checkin_code, id]);
      }
      const audience = await audienceFor(row);
      const placeholders = audience.map(() => '?').join(',') || 'NULL';
      out.attendees = await db.all(
        `SELECT u.id, u.name, u.email, d.name AS department_name, c.name AS company_name, r.status, r.note, r.responded_at,
                ma.checked_in_at AS attended_at, ma.method AS attended_method
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN companies c ON c.id = u.company_id
         LEFT JOIN meeting_rsvps r ON r.user_id = u.id AND r.meeting_id = ?
         LEFT JOIN meeting_attendance ma ON ma.user_id = u.id AND ma.meeting_id = ?
         WHERE u.id IN (${placeholders}) ORDER BY (r.status IS NULL), r.status, u.name`,
        [id, id, ...audience]
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
  requireStaff,
  wrap(async (req, res) => {
    const { title, description = '', starts_at, ends_at, location = '', link = '', recurrence = null } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (!isValidDate(starts_at) || !isValidDate(ends_at)) return res.status(400).json({ error: 'Start and end time are required' });
    if (Date.parse(ends_at) <= Date.parse(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });
    if (recurrence && !RECURRENCES[recurrence]) return res.status(400).json({ error: 'Invalid repeat option' });
    const count = recurrence ? Math.min(Math.max(Number(req.body.occurrences) || 12, 2), 52) : 1;
    const targeting = await parseTargeting(req.body, req.user);
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
          'INSERT INTO meetings (title, description, starts_at, ends_at, location, link, company_id, organizer_id, series_id, recurrence, checkin_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
          [String(title).trim(), String(description).trim(), s.toISOString(), e.toISOString(), String(location).trim(), String(link).trim(), company_id, req.user.id, seriesId, recurrence, shortCode()]
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
    logActivity(req, 'meeting.create', 'meeting', id, { title: String(title).trim(), count });

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
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, existing)) return res.status(403).json({ error: 'You can only edit meetings of your own company' });
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
      targeting = await parseTargeting({ company_id: req.body.company_id ?? existing.company_id, department_ids: req.body.department_ids ?? (await targetsFor(id)).map((t) => t.id) }, req.user);
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
    logActivity(req, next.status === 'cancelled' && existing.status !== 'cancelled' ? 'meeting.cancel' : 'meeting.update', 'meeting', id, { title: next.title });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const m = await db.get('SELECT series_id, starts_at, company_id, title FROM meetings WHERE id = ?', [id]);
    if (!m) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, m)) return res.status(403).json({ error: 'You can only delete meetings of your own company' });
    if (req.query.series === 'all' && m.series_id) {
      await db.run('DELETE FROM meetings WHERE series_id = ?', [m.series_id]);
    } else if (req.query.series === 'future' && m.series_id) {
      await db.run('DELETE FROM meetings WHERE series_id = ? AND starts_at >= ?', [m.series_id, m.starts_at]);
    } else {
      await db.run('DELETE FROM meetings WHERE id = ?', [id]);
    }
    notifyAll('meetings', { id, deleted: true });
    logActivity(req, 'meeting.delete', 'meeting', id, { title: m.title, series: req.query.series || 'one' });
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
    notifyUsers(await managerIds(meeting.company_id), 'meetings', { id });
    res.json({ ok: true, status, note });
  })
);

// ---------- attendance ----------
// Staff: mark someone present / absent.  { user_id, present: true|false }
router.post(
  '/:id/attendance',
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, meeting)) return res.status(403).json({ error: 'You can only take attendance for your own company' });
    const userId = Number(req.body?.user_id) || 0;
    const present = req.body?.present !== false && req.body?.present !== 'false';
    const audience = await audienceFor(meeting);
    if (!audience.includes(userId)) return res.status(400).json({ error: 'That person is not invited to this meeting' });
    if (present) {
      await db.run('INSERT INTO meeting_attendance (meeting_id, user_id, checked_in_at, method) VALUES (?, ?, ?, ?) ON CONFLICT (meeting_id, user_id) DO NOTHING', [id, userId, nowIso(), 'staff']);
    } else {
      await db.run('DELETE FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?', [id, userId]);
    }
    notifyAll('meetings', { id });
    const person = await db.get('SELECT name FROM users WHERE id = ?', [userId]);
    logActivity(req, 'meeting.attendance', 'meeting', id, { user_id: userId, present, title: meeting.title, person: person?.name });
    res.json({ ok: true, attended: present });
  })
);

// Employee: check in with the code shown by the organizer (on screen / QR).
router.post(
  '/:id/checkin',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!(await canSee(req.user, meeting))) return res.status(404).json({ error: 'Meeting not found' });
    if (meeting.status === 'cancelled') return res.status(400).json({ error: 'This meeting was cancelled' });
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code || code !== (meeting.checkin_code || '').toUpperCase()) return res.status(400).json({ error: 'Wrong check-in code' });
    // Allowed from 30 minutes before the start until 2 hours after the end.
    const now = Date.now();
    if (now < Date.parse(meeting.starts_at) - 30 * 60000 || now > Date.parse(meeting.ends_at) + 120 * 60000) {
      return res.status(400).json({ error: 'Check-in is only open around the meeting time' });
    }
    await db.run('INSERT INTO meeting_attendance (meeting_id, user_id, checked_in_at, method) VALUES (?, ?, ?, ?) ON CONFLICT (meeting_id, user_id) DO NOTHING', [id, req.user.id, nowIso(), 'self']);
    notifyUsers(await managerIds(meeting.company_id), 'meetings', { id });
    res.json({ ok: true });
  })
);

// ---------- minutes ----------
router.patch(
  '/:id/minutes',
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, meeting)) return res.status(403).json({ error: 'You can only write minutes for your own company' });
    const minutes = String(req.body?.minutes || '').trim().slice(0, 20000);
    const first = !meeting.minutes && minutes;
    await db.run('UPDATE meetings SET minutes = ?, minutes_updated_at = ? WHERE id = ?', [minutes || null, minutes ? nowIso() : null, id]);
    if (first && req.body?.notify !== false) {
      const audience = await audienceFor(meeting, req.user.id);
      await createNotifications(audience, { type: 'meeting', title: `Minutes posted: ${meeting.title}`, body: minutes.slice(0, 140), refType: 'meeting', refId: id });
    }
    notifyAll('meetings', { id });
    logActivity(req, 'meeting.minutes', 'meeting', id, { title: meeting.title });
    res.json({ ok: true });
  })
);

// ---------- calendar file ----------
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
export function buildIcs(m) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UpNotice//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:upnotice-meeting-${m.id}@upnotice`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(m.starts_at)}`,
    `DTEND:${icsDate(m.ends_at)}`,
    `SUMMARY:${icsEscape(m.title)}`,
  ];
  if (m.description) lines.push(`DESCRIPTION:${icsEscape(m.description)}`);
  if (m.location) lines.push(`LOCATION:${icsEscape(m.location)}`);
  if (m.link) lines.push(`URL:${icsEscape(m.link)}`);
  if (m.status === 'cancelled') lines.push('STATUS:CANCELLED');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

router.get(
  '/:id/ics',
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const m = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!(await canSee(req.user, m))) return res.status(404).json({ error: 'Meeting not found' });
    res.setHeader('Content-Disposition', `attachment; filename="upnotice-meeting-${id}.ics"`);
    res.type('text/calendar').send(buildIcs(m));
  })
);

export default router;
