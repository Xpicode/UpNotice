import { Router } from 'express';
import crypto from 'node:crypto';
import { db, audienceWhere, audienceUserIds, visibilitySql, nowIso } from '../db.js';
import { requireAuth, requireStaff, isStaff, canManage, wrap } from '../auth.js';
import { checkinLimiter } from '../limits.js';
import { parse, meetingsQuery, meetingCreate, meetingPatch, rsvpBody, attendanceBody, attendanceDecision, minutesBody } from '../validate.js';
import { createNotifications, managerIds } from '../notify.js';
import { logActivity } from '../activity.js';
import { notifyAll, notifyUsers } from '../events.js';

const router = Router();

// The attendance window, in one place: the client shows the check-in box for exactly as long as the server accepts it.
export const CHECKIN_OPENS_BEFORE_MS = 5 * 60 * 1000;
export const CHECKIN_CLOSES_AFTER_MS = 120 * 60 * 1000;
/** When the check-in box appears and disappears for a meeting, as ISO strings. */
export function checkinWindow(row) {
  return {
    checkin_opens_at: new Date(Date.parse(row.starts_at) - CHECKIN_OPENS_BEFORE_MS).toISOString(),
    checkin_closes_at: new Date(Date.parse(row.ends_at) + CHECKIN_CLOSES_AFTER_MS).toISOString(),
  };
}

function targetsFor(id) {
  return db.all(
    `SELECT d.id, d.name FROM meeting_targets t JOIN departments d ON d.id = t.department_id
     WHERE t.meeting_id = ? ORDER BY d.name`,
    [id]
  );
}

/** Same as audienceFor(row).length but as one COUNT query (no list of ids for a 10,000-person audience). */
async function audienceCount(row, ownerId) {
  const targets = await targetsFor(row.id);
  const aud = audienceWhere(
    row.company_id,
    targets.map((t) => t.id)
  );
  return (await db.get(`SELECT COUNT(*) AS n FROM users WHERE ${aud.sql} AND id <> ?`, [...aud.params, ownerId])).n;
}
async function audienceFor(row, excludeUserId = null) {
  const targets = await targetsFor(row.id);
  return (
    await audienceUserIds(
      row.company_id,
      targets.map((t) => t.id),
      excludeUserId
    )
  ).filter((id) => id !== row.organizer_id);
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
         (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.status = 'approved') AS attended_count,
         (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.status = 'pending') AS pending_count,
         (SELECT ma.status FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.user_id = @me) AS my_checkin
  FROM meetings m JOIN users u ON u.id = m.organizer_id LEFT JOIN companies c ON c.id = m.company_id`;

async function shape(row, user) {
  const mine = canManage(user, row);
  const approved = row.my_checkin === 'approved';
  const out = {
    ...row,
    targets: await targetsFor(row.id),
    attended_by_me: approved,
    // 'none' = has not asked yet, 'pending' = waiting for the organizer, 'approved' = counted as present.
    my_checkin: row.my_checkin || 'none',
    has_minutes: !!(row.minutes && row.minutes.trim()),
    can_manage: mine,
    // Whether there is a joining link at all — said out loud even when the link itself is withheld.
    has_link: !!row.link,
    ...checkinWindow(row),
  };
  delete out.reminder_sent;
  delete out.checkin_notice_sent;
  // Databases made before check-in became a request the organizer approves still carry this column.
  // Nothing writes it any more, and nobody is shown it.
  delete out.checkin_code;
  // The link to the online meeting is only handed over once the organizer has approved the check-in,
  // so it is never in the response for anyone else to read out of the network tab.
  if (!mine && !approved) out.link = '';
  if (isStaff(user)) out.audience_count = await audienceCount(row, row.organizer_id);
  return out;
}

/** ?q= ?company_id= ?department_id= ?from= ?to= */
function listFilters(query, params) {
  const where = [];
  const q = String(query.q || '').toLowerCase();
  if (q) {
    where.push('(LOWER(m.title) LIKE @q OR LOWER(m.description) LIKE @q OR LOWER(m.location) LIKE @q)');
    params.q = `%${q}%`;
  }
  if (query.company_id) {
    where.push('m.company_id = @companyFilter');
    params.companyFilter = query.company_id;
  }
  if (query.department_id) {
    where.push('EXISTS (SELECT 1 FROM meeting_targets ft WHERE ft.meeting_id = m.id AND ft.department_id = @deptFilter)');
    params.deptFilter = query.department_id;
  }
  if (query.from && !Number.isNaN(Date.parse(query.from))) {
    where.push('m.starts_at >= @from');
    params.from = new Date(query.from).toISOString();
  }
  if (query.to && !Number.isNaN(Date.parse(query.to))) {
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

async function parseTargeting({ company_id, department_ids }, user = null) {
  if (user?.role === 'manager' && company_id !== user.company_id) return 'Managers can only schedule meetings for their own company';
  const depts = department_ids || [];
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
  requireAuth,
  wrap(async (req, res) => {
    const me = req.user.id;
    const query = parse(meetingsQuery, req.query);
    const scope = query.scope;
    const now = nowIso();
    const timeFilter = scope === 'past' ? 'm.ends_at < @now' : scope === 'all' ? '1=1' : 'm.ends_at >= @now';
    const order = scope === 'past' ? 'ORDER BY m.starts_at DESC' : 'ORDER BY m.starts_at ASC';
    const params = { me, now, company: req.user.company_id ?? -1, dept: req.user.department_id ?? -1 };
    const where = [timeFilter, ...listFilters(query, params)];
    if (req.user.role === 'manager') where.push(`(m.company_id = @company OR (${visibilitySql('m', 'meeting_targets', 'meeting_id')}))`);
    else if (req.user.role !== 'admin') where.push(visibilitySql('m', 'meeting_targets', 'meeting_id'));
    const rows = await db.all(`${baseSelect} WHERE ${where.join(' AND ')} ${order}`, params);
    res.json({ meetings: await shapeAll(rows, req.user) });
  })
);

router.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const row = await db.get(`${baseSelect} WHERE m.id = @id`, { me: req.user.id, id });
    if (!(await canSee(req.user, row))) return res.status(404).json({ error: 'Meeting not found' });
    const out = await shape(row, req.user);
    if (canManage(req.user, row)) {
      const targets = await targetsFor(row.id);
      const aud = audienceWhere(
        row.company_id,
        targets.map((t) => t.id),
        'u'
      );
      const attendees = await db.all(
        `SELECT u.id, u.name, u.email, d.name AS department_name, c.name AS company_name, r.status, r.note, r.responded_at,
                CASE WHEN ma.status = 'approved' THEN ma.checked_in_at END AS attended_at, ma.method AS attended_method,
                ma.status AS checkin_status, ma.checked_in_at AS checkin_requested_at
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN companies c ON c.id = u.company_id
         LEFT JOIN meeting_rsvps r ON r.user_id = u.id AND r.meeting_id = ?
         LEFT JOIN meeting_attendance ma ON ma.user_id = u.id AND ma.meeting_id = ?
         WHERE ${aud.sql} AND u.id <> ?
         ORDER BY (CASE WHEN ma.status = 'pending' THEN 0 ELSE 1 END), (r.status IS NULL), r.status, u.name`,
        [id, id, ...aud.params, row.organizer_id]
      );
      // Very large audiences: the first 300 people plus the totals (the counts per RSVP status stay exact).
      out.attendees_total = attendees.length;
      out.attendees = attendees.slice(0, 300);
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
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const body = parse(meetingCreate, req.body);
    const { title, description, starts_at, ends_at, location, link, recurrence } = body;
    if (Date.parse(ends_at) <= Date.parse(starts_at)) return res.status(400).json({ error: 'End time must be after start time' });
    const count = recurrence ? body.occurrences || 12 : 1;
    const targeting = await parseTargeting(body, req.user);
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
          [title, description, s.toISOString(), e.toISOString(), location, link, company_id, req.user.id, seriesId, recurrence]
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
      title: `Meeting invite: ${title}`,
      body: `${fmtWhen(starts_at)}${location ? ' · ' + location : ''}${repeatNote}`,
      refType: 'meeting',
      refId: id,
    });
    notifyAll('meetings', { id });
    logActivity(req, 'meeting.create', 'meeting', id, { title, count });

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

/**
 * Called by the scheduler every minute: as a meeting starts, tell everyone still expected that the
 * attendance check-in is open, so they do not have to go looking for it.
 */
export async function sendCheckInNotices() {
  const now = Date.now();
  // Only meetings that started in the last 15 minutes: a server that was off for a while must not send a late burst.
  const from = new Date(now - 15 * 60000).toISOString();
  const rows = await db.all("SELECT * FROM meetings WHERE status = 'scheduled' AND checkin_notice_sent = 0 AND starts_at <= ? AND starts_at > ?", [
    new Date(now).toISOString(),
    from,
  ]);
  for (const m of rows) {
    const audience = await audienceFor(m);
    // Skip people who said they can't come and anyone already marked present.
    const skip = new Set([
      ...(await db.all("SELECT user_id FROM meeting_rsvps WHERE meeting_id = ? AND status = 'declined'", [m.id])).map((r) => r.user_id),
      ...(await db.all('SELECT user_id FROM meeting_attendance WHERE meeting_id = ?', [m.id])).map((r) => r.user_id),
    ]);
    const recipients = audience.filter((u) => !skip.has(u));
    await createNotifications(recipients, {
      type: 'meeting',
      title: `Check in now: ${m.title}`,
      body: `The meeting is starting${m.location ? ' · ' + m.location : ''}. Enter the code the organizer shows to be marked present.`,
      refType: 'meeting',
      refId: m.id,
      email: false, // a "starting now" nudge belongs in the app and on the phone, not in an inbox
    });
    await db.run('UPDATE meetings SET checkin_notice_sent = 1 WHERE id = ?', [m.id]);
    notifyUsers(recipients, 'meetings', { id: m.id });
  }
  // Anything older than the window is never sent, so mark it done and keep the query above small.
  await db.run('UPDATE meetings SET checkin_notice_sent = 1 WHERE checkin_notice_sent = 0 AND starts_at <= ?', [from]);
  return rows.length;
}

router.patch(
  '/:id',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const existing = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, existing)) return res.status(403).json({ error: 'You can only edit meetings of your own company' });
    const body = parse(meetingPatch, req.body);
    const next = {
      title: body.title ?? existing.title,
      description: body.description ?? existing.description,
      starts_at: body.starts_at ?? existing.starts_at,
      ends_at: body.ends_at ?? existing.ends_at,
      location: body.location ?? existing.location,
      link: body.link ?? existing.link,
      status: body.status ?? existing.status,
      company_id: existing.company_id,
    };
    if (Date.parse(next.ends_at) <= Date.parse(next.starts_at)) return res.status(400).json({ error: 'End time must be after start time' });

    const retarget = body.company_id !== undefined || body.department_ids !== undefined;
    let targeting = null;
    if (retarget) {
      targeting = await parseTargeting(
        { company_id: body.company_id !== undefined ? body.company_id : existing.company_id, department_ids: body.department_ids ?? (await targetsFor(id)).map((t) => t.id) },
        req.user
      );
      if (typeof targeting === 'string') return res.status(400).json({ error: targeting });
      next.company_id = targeting.company_id;
    }

    // Moving the meeting re-arms the hour-before reminder and the "check in now" notice for the new time.
    const moved = next.starts_at !== existing.starts_at;
    await db.tx(async () => {
      await db.run(
        `UPDATE meetings SET title=@title, description=@description, starts_at=@starts_at, ends_at=@ends_at,
         location=@location, link=@link, status=@status, company_id=@company_id WHERE id=@id`,
        { ...next, id }
      );
      if (moved) await db.run('UPDATE meetings SET reminder_sent = 0, checkin_notice_sent = 0 WHERE id = ?', [id]);
      if (targeting) {
        await db.run('DELETE FROM meeting_targets WHERE meeting_id = ?', [id]);
        for (const d of targeting.depts) await db.run('INSERT INTO meeting_targets (meeting_id, department_id) VALUES (?, ?)', [id, d]);
      }
    });

    const audience = await audienceFor({ id, company_id: next.company_id }, req.user.id);
    const changed = moved || next.ends_at !== existing.ends_at || next.location !== existing.location;
    if (next.status === 'cancelled' && existing.status !== 'cancelled') {
      await createNotifications(audience, { type: 'meeting', title: `Meeting cancelled: ${next.title}`, refType: 'meeting', refId: id });
    } else if (changed) {
      await createNotifications(audience, {
        type: 'meeting',
        title: `Meeting updated: ${next.title}`,
        body: 'Time or place has changed — please check the details.',
        refType: 'meeting',
        refId: id,
      });
    }
    notifyAll('meetings', { id });
    logActivity(req, next.status === 'cancelled' && existing.status !== 'cancelled' ? 'meeting.cancel' : 'meeting.update', 'meeting', id, { title: next.title });
    res.json({ ok: true });
  })
);

router.delete(
  '/:id',
  requireAuth,
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
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const body = parse(rsvpBody, req.body);
    const { status } = body;
    // "Going" needs no explanation; "Maybe" and "Can't go" must say why so the organizer knows.
    const note = status === 'going' ? '' : body.note;
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
// An attendee taps "Check in" and that becomes a request; the person who scheduled the meeting (and the
// managers of that company) approve or turn it down. Only an approved row counts as present, so nobody
// can mark themselves attended at a meeting they were not at. Staff can still tick people themselves,
// and the code / QR is a shortcut that skips the queue: knowing the code is proof of being in the room.

// Staff: mark someone present / absent.  { user_id, present: true|false }
router.post(
  '/:id/attendance',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, meeting)) return res.status(403).json({ error: 'You can only take attendance for your own company' });
    const { user_id: userId, present } = parse(attendanceBody, req.body);
    const audience = await audienceFor(meeting);
    if (!audience.includes(userId)) return res.status(400).json({ error: 'That person is not invited to this meeting' });
    if (present) {
      await db.run(
        `INSERT INTO meeting_attendance (meeting_id, user_id, checked_in_at, method, status, decided_at, decided_by) VALUES (?, ?, ?, ?, 'approved', ?, ?)
         ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = 'approved', decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
        [id, userId, nowIso(), 'staff', nowIso(), req.user.id]
      );
    } else {
      await db.run('DELETE FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?', [id, userId]);
    }
    notifyAll('meetings', { id });
    const person = await db.get('SELECT name FROM users WHERE id = ?', [userId]);
    logActivity(req, 'meeting.attendance', 'meeting', id, { user_id: userId, present, title: meeting.title, person: person?.name });
    res.json({ ok: true, attended: present });
  })
);

/**
 * Attendee: "I'm here" — one button, no code. It waits for the organizer, who sees it straight away.
 * Asking twice is harmless: an approved row is left alone and a pending one keeps its first time.
 */
router.post(
  '/:id/checkin-request',
  requireAuth,
  checkinLimiter,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!(await canSee(req.user, meeting))) return res.status(404).json({ error: 'Meeting not found' });
    if (meeting.status === 'cancelled') return res.status(400).json({ error: 'This meeting was cancelled' });
    if (meeting.organizer_id === req.user.id) return res.status(400).json({ error: 'You are the organizer of this meeting' });
    const now = Date.now();
    if (now < Date.parse(meeting.starts_at) - CHECKIN_OPENS_BEFORE_MS || now > Date.parse(meeting.ends_at) + CHECKIN_CLOSES_AFTER_MS) {
      return res.status(400).json({ error: 'Check-in is only open around the meeting time' });
    }
    await db.run(
      `INSERT INTO meeting_attendance (meeting_id, user_id, checked_in_at, method, status) VALUES (?, ?, ?, 'request', 'pending')
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [id, req.user.id, nowIso()]
    );
    const row = await db.get('SELECT status FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?', [id, req.user.id]);
    if (row?.status === 'pending') {
      // The organizer decides; the managers of that company can stand in when the organizer is busy.
      const deciders = [...new Set([meeting.organizer_id, ...(await managerIds(meeting.company_id))])].filter((u) => u !== req.user.id);
      await createNotifications(deciders, {
        type: 'meeting',
        title: `${req.user.name} is checking in`,
        body: `Approve or turn down the check-in for ${meeting.title}.`,
        refType: 'meeting',
        refId: id,
        email: false, // this needs answering during the meeting, not in an inbox afterwards
      });
    }
    res.json({ ok: true, status: row?.status || 'pending' });
  })
);

/** Organizer (or a manager of that company): approve or turn down check-ins.  { user_ids: [...], approve } */
router.post(
  '/:id/attendance/decide',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, meeting)) return res.status(403).json({ error: 'You can only take attendance for your own company' });
    const { user_ids: userIds, approve } = parse(attendanceDecision, req.body);
    const holes = userIds.map(() => '?').join(',');
    // Only rows still waiting are touched, so a second tap cannot undo an approval or re-approve a refusal.
    const waiting = (await db.all(`SELECT user_id FROM meeting_attendance WHERE meeting_id = ? AND status = 'pending' AND user_id IN (${holes})`, [id, ...userIds])).map(
      (r) => r.user_id
    );
    if (waiting.length === 0) return res.json({ ok: true, decided: 0 });
    const inList = waiting.map(() => '?').join(',');
    if (approve) {
      await db.run(`UPDATE meeting_attendance SET status = 'approved', decided_at = ?, decided_by = ? WHERE meeting_id = ? AND user_id IN (${inList})`, [
        nowIso(),
        req.user.id,
        id,
        ...waiting,
      ]);
    } else {
      // Turned down: the row goes, so the person can put their hand up again if it was a mistake.
      await db.run(`DELETE FROM meeting_attendance WHERE meeting_id = ? AND status = 'pending' AND user_id IN (${inList})`, [id, ...waiting]);
    }
    await createNotifications(waiting, {
      type: 'meeting',
      title: approve ? `You're marked present: ${meeting.title}` : `Check-in not approved: ${meeting.title}`,
      body: approve ? 'The organizer approved your check-in.' : 'Speak to the organizer if you think this is wrong — you can check in again.',
      refType: 'meeting',
      refId: id,
      email: false,
    });
    notifyAll('meetings', { id });
    logActivity(req, 'meeting.attendance', 'meeting', id, { title: meeting.title, count: waiting.length, present: approve });
    res.json({ ok: true, decided: waiting.length });
  })
);

// ---------- minutes ----------
router.patch(
  '/:id/minutes',
  requireAuth,
  requireStaff,
  wrap(async (req, res) => {
    const id = Number(req.params.id) || 0;
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', [id]);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!canManage(req.user, meeting)) return res.status(403).json({ error: 'You can only write minutes for your own company' });
    const body = parse(minutesBody, req.body);
    const minutes = body.minutes;
    const first = !meeting.minutes && minutes;
    await db.run('UPDATE meetings SET minutes = ?, minutes_updated_at = ? WHERE id = ?', [minutes || null, minutes ? nowIso() : null, id]);
    if (first && body.notify !== false) {
      const audience = await audienceFor(meeting, req.user.id);
      await createNotifications(audience, { type: 'meeting', title: `Minutes posted: ${meeting.title}`, body: minutes.slice(0, 140), refType: 'meeting', refId: id });
    }
    notifyAll('meetings', { id });
    logActivity(req, 'meeting.minutes', 'meeting', id, { title: meeting.title });
    res.json({ ok: true });
  })
);

export default router;
