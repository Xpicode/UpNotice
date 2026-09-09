// Admin reports: read rates and attendance, with CSV export.
import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { audiencePairsSql, reportItemsSql } from '../audience-sql.js';
import { requireAuthOrTicket, requireStaff, companyScope, wrap } from '../auth.js';

const router = Router();
router.use(requireAuthOrTicket, requireStaff);

function employees(scope) {
  return db.all(
    `SELECT u.id, u.name, u.email, u.company_id, u.department_id, c.name AS company_name, d.name AS department_name
     FROM users u LEFT JOIN companies c ON c.id = u.company_id LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.role IN ('employee', 'manager') AND u.active = 1 ${scope !== null ? 'AND u.company_id = ?' : ''} ORDER BY c.name, d.name, u.name`,
    scope !== null ? [scope] : []
  );
}

const pct = (n, d) => Math.round((n / d) * 100);

/** Per-announcement audience / read / acknowledged counts, newest first. */
function announcementStats(opts) {
  const pairs = audiencePairsSql('announcement', opts);
  const items = reportItemsSql('announcement', opts, 'a');
  return db.all(
    `SELECT a.id, a.title, a.priority, a.category, a.company_id, a.publish_at, a.created_at, a.ack_required,
            COALESCE(s.audience, 0) AS audience, COALESCE(s.read_n, 0) AS read_n, COALESCE(s.ack_n, 0) AS ack_n
     FROM announcements a
     LEFT JOIN (
       SELECT p.item_id, COUNT(*) AS audience,
              SUM(CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END) AS read_n,
              SUM(CASE WHEN r.acknowledged_at IS NULL THEN 0 ELSE 1 END) AS ack_n
       FROM (${pairs.sql}) p
       LEFT JOIN announcement_reads r ON r.announcement_id = p.item_id AND r.user_id = p.user_id
       GROUP BY p.item_id
     ) s ON s.item_id = a.id
     WHERE ${items.sql}
     ORDER BY COALESCE(a.publish_at, a.created_at) DESC, a.id`,
    { ...pairs.params, ...items.params }
  );
}

/** Per-meeting audience / RSVP / attendance counts, latest first. */
function meetingStats(opts) {
  const pairs = audiencePairsSql('meeting', opts);
  const items = reportItemsSql('meeting', opts, 'm');
  return db.all(
    `SELECT m.id, m.title, m.company_id, m.starts_at, m.ends_at, m.minutes,
            COALESCE(s.audience, 0) AS audience, COALESCE(s.going, 0) AS going, COALESCE(s.maybe, 0) AS maybe,
            COALESCE(s.declined, 0) AS declined, COALESCE(s.no_reply, 0) AS no_reply, COALESCE(s.attended, 0) AS attended
     FROM meetings m
     LEFT JOIN (
       SELECT p.item_id, COUNT(*) AS audience,
              SUM(CASE WHEN r.status = 'going' THEN 1 ELSE 0 END) AS going,
              SUM(CASE WHEN r.status = 'maybe' THEN 1 ELSE 0 END) AS maybe,
              SUM(CASE WHEN r.status = 'declined' THEN 1 ELSE 0 END) AS declined,
              SUM(CASE WHEN r.user_id IS NULL THEN 1 ELSE 0 END) AS no_reply,
              SUM(CASE WHEN att.user_id IS NULL THEN 0 ELSE 1 END) AS attended
       FROM (${pairs.sql}) p
       LEFT JOIN meeting_rsvps r ON r.meeting_id = p.item_id AND r.user_id = p.user_id
       LEFT JOIN meeting_attendance att ON att.meeting_id = p.item_id AND att.user_id = p.user_id AND att.status = 'approved'
       GROUP BY p.item_id
     ) s ON s.item_id = m.id
     WHERE ${items.sql}
     ORDER BY m.starts_at DESC, m.id`,
    { ...pairs.params, ...items.params }
  );
}

/** Per-employee announcement totals: how many they received, read, acknowledged (and had to). */
function employeeAnnouncementStats(opts) {
  const pairs = audiencePairsSql('announcement', opts);
  return db.all(
    `SELECT p.user_id, COUNT(*) AS sent,
            SUM(CASE WHEN a.ack_required <> 0 THEN 1 ELSE 0 END) AS ack_required,
            SUM(CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END) AS read_n,
            SUM(CASE WHEN r.acknowledged_at IS NULL THEN 0 ELSE 1 END) AS acked
     FROM (${pairs.sql}) p
     JOIN announcements a ON a.id = p.item_id
     LEFT JOIN announcement_reads r ON r.announcement_id = p.item_id AND r.user_id = p.user_id
     GROUP BY p.user_id`,
    pairs.params
  );
}

/** Per-employee meeting totals: invites, RSVP breakdown and check-ins. */
function employeeMeetingStats(opts) {
  const pairs = audiencePairsSql('meeting', opts);
  return db.all(
    `SELECT p.user_id, COUNT(*) AS invited,
            SUM(CASE WHEN r.status = 'going' THEN 1 ELSE 0 END) AS going,
            SUM(CASE WHEN r.status = 'maybe' THEN 1 ELSE 0 END) AS maybe,
            SUM(CASE WHEN r.status = 'declined' THEN 1 ELSE 0 END) AS declined,
            SUM(CASE WHEN r.user_id IS NULL THEN 1 ELSE 0 END) AS no_reply,
            SUM(CASE WHEN att.user_id IS NULL THEN 0 ELSE 1 END) AS attended
     FROM (${pairs.sql}) p
     LEFT JOIN meeting_rsvps r ON r.meeting_id = p.item_id AND r.user_id = p.user_id
     LEFT JOIN meeting_attendance att ON att.meeting_id = p.item_id AND att.user_id = p.user_id AND att.status = 'approved'
     GROUP BY p.user_id`,
    pairs.params
  );
}

/**
 * Builds the full report data once; the JSON and CSV endpoints both use it.
 * Six queries in total, whatever the number of employees / announcements / meetings:
 * the audience rule (see audience-sql.js) is joined and aggregated in SQL.
 */
async function buildReport({ from, to, scope = null }) {
  const opts = { scope, from: from || null, to: to || null };
  const [emps, companies, anns, meets, empAnn, empMeet] = await Promise.all([
    employees(scope),
    db.all('SELECT id, name FROM companies'),
    announcementStats(opts),
    meetingStats(opts),
    employeeAnnouncementStats(opts),
    employeeMeetingStats(opts),
  ]);
  const companyNames = new Map(companies.map((c) => [c.id, c.name]));
  const annByUser = new Map(empAnn.map((r) => [r.user_id, r]));
  const meetByUser = new Map(empMeet.map((r) => [r.user_id, r]));

  // ---- announcements ----
  const annRows = anns.map((a) => ({
    id: a.id,
    title: a.title,
    priority: a.priority,
    category: a.category || '',
    company: a.company_id ? companyNames.get(a.company_id) : 'All companies',
    date: a.publish_at || a.created_at,
    audience: a.audience,
    read: a.read_n,
    read_pct: a.audience ? pct(a.read_n, a.audience) : 0,
    ack_required: !!a.ack_required,
    acked: a.ack_n,
  }));

  // ---- meetings ----
  const now = nowIso();
  const meetRows = meets.map((m) => {
    const past = m.ends_at < now;
    return {
      id: m.id,
      title: m.title,
      company: m.company_id ? companyNames.get(m.company_id) : 'All companies',
      date: m.starts_at,
      past,
      audience: m.audience,
      going: m.going,
      maybe: m.maybe,
      declined: m.declined,
      noReply: m.no_reply,
      attended: m.attended,
      going_pct: m.audience ? pct(m.going, m.audience) : 0,
      attended_pct: m.audience && (past || m.attended) ? pct(m.attended, m.audience) : null,
      has_minutes: !!(m.minutes && m.minutes.trim()),
    };
  });

  // ---- employees ----
  const empRows = emps.map((e) => {
    const a = annByUser.get(e.id);
    const m = meetByUser.get(e.id);
    const sent = a ? a.sent : 0,
      read = a ? a.read_n : 0;
    const invited = m ? m.invited : 0,
      going = m ? m.going : 0,
      attended = m ? m.attended : 0;
    return {
      id: e.id,
      name: e.name,
      email: e.email,
      company: e.company_name,
      department: e.department_name,
      sent,
      read,
      read_pct: sent ? pct(read, sent) : null,
      ack_required: a ? a.ack_required : 0,
      acked: a ? a.acked : 0,
      invited,
      going,
      maybe: m ? m.maybe : 0,
      declined: m ? m.declined : 0,
      no_reply: m ? m.no_reply : 0,
      attendance_pct: invited ? pct(going, invited) : null,
      attended,
      attended_pct: invited ? pct(attended, invited) : null,
    };
  });

  // ---- per company / department roll-up (first-seen order follows the employee ordering) ----
  const groups = new Map();
  for (const e of empRows) {
    const key = `${e.company || 'No company'}||${e.department || 'No department'}`;
    if (!groups.has(key))
      groups.set(key, {
        company: e.company || 'No company',
        department: e.department || 'No department',
        employees: 0,
        sent: 0,
        read: 0,
        invited: 0,
        going: 0,
        declined: 0,
        attended: 0,
      });
    const g = groups.get(key);
    g.employees++;
    g.sent += e.sent;
    g.read += e.read;
    g.invited += e.invited;
    g.going += e.going;
    g.declined += e.declined;
    g.attended += e.attended;
  }
  const groupRows = [...groups.values()].map((g) => ({
    ...g,
    read_pct: g.sent ? pct(g.read, g.sent) : null,
    going_pct: g.invited ? pct(g.going, g.invited) : null,
    attended_pct: g.invited ? pct(g.attended, g.invited) : null,
  }));

  const totals = {
    announcements: annRows.length,
    avg_read_pct: annRows.length ? Math.round(annRows.reduce((n, r) => n + r.read_pct, 0) / annRows.length) : 0,
    meetings: meetRows.length,
    avg_going_pct: meetRows.length ? Math.round(meetRows.reduce((n, r) => n + r.going_pct, 0) / meetRows.length) : 0,
    avg_attended_pct: (() => {
      const withAtt = meetRows.filter((r) => r.attended_pct !== null);
      return withAtt.length ? Math.round(withAtt.reduce((n, r) => n + r.attended_pct, 0) / withAtt.length) : null;
    })(),
    employees: empRows.length,
  };
  return { totals, groups: groupRows, employees: empRows, announcements: annRows, meetings: meetRows };
}

function range(req) {
  const from = req.query.from ? new Date(req.query.from).toISOString() : null;
  const to = req.query.to ? new Date(new Date(req.query.to).getTime() + 86400000).toISOString() : null; // inclusive day
  return { from, to, scope: companyScope(req.user) };
}

router.get(
  '/summary',
  wrap(async (req, res) => {
    res.json(await buildReport(range(req)));
  })
);

function csv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','))].join('\r\n');
}

// /api/reports/export/:kind.csv  kind = employees | announcements | meetings | departments
router.get(
  '/export/:kind',
  wrap(async (req, res) => {
    const data = await buildReport(range(req));
    const kind = String(req.params.kind).replace(/\.csv$/, '');
    const sets = {
      employees: [
        data.employees,
        [
          { key: 'name', label: 'Employee' },
          { key: 'email', label: 'Email' },
          { key: 'company', label: 'Company' },
          { key: 'department', label: 'Department' },
          { key: 'sent', label: 'Announcements received' },
          { key: 'read', label: 'Read' },
          { key: 'read_pct', label: 'Read %' },
          { key: 'ack_required', label: 'Acknowledgements required' },
          { key: 'acked', label: 'Acknowledged' },
          { key: 'invited', label: 'Meetings invited' },
          { key: 'going', label: 'Going' },
          { key: 'maybe', label: 'Maybe' },
          { key: 'declined', label: 'Declined' },
          { key: 'no_reply', label: 'No reply' },
          { key: 'attendance_pct', label: 'Going %' },
          { key: 'attended', label: 'Actually attended' },
          { key: 'attended_pct', label: 'Attended %' },
        ],
      ],
      announcements: [
        data.announcements,
        [
          { key: 'date', label: 'Date' },
          { key: 'title', label: 'Title' },
          { key: 'priority', label: 'Priority' },
          { key: 'category', label: 'Category' },
          { key: 'company', label: 'Company' },
          { key: 'audience', label: 'Sent to' },
          { key: 'read', label: 'Read' },
          { key: 'read_pct', label: 'Read %' },
          { label: 'Ack required', get: (r) => (r.ack_required ? 'yes' : 'no') },
          { key: 'acked', label: 'Acknowledged' },
        ],
      ],
      meetings: [
        data.meetings,
        [
          { key: 'date', label: 'Date' },
          { key: 'title', label: 'Title' },
          { key: 'company', label: 'Company' },
          { key: 'audience', label: 'Invited' },
          { key: 'going', label: 'Going' },
          { key: 'maybe', label: 'Maybe' },
          { key: 'declined', label: 'Declined' },
          { key: 'noReply', label: 'No reply' },
          { key: 'going_pct', label: 'Going %' },
          { key: 'attended', label: 'Attended' },
          { key: 'attended_pct', label: 'Attended %' },
          { label: 'Minutes', get: (r) => (r.has_minutes ? 'yes' : 'no') },
        ],
      ],
      departments: [
        data.groups,
        [
          { key: 'company', label: 'Company' },
          { key: 'department', label: 'Department' },
          { key: 'employees', label: 'Employees' },
          { key: 'sent', label: 'Announcements sent' },
          { key: 'read', label: 'Read' },
          { key: 'read_pct', label: 'Read %' },
          { key: 'invited', label: 'Meeting invites' },
          { key: 'going', label: 'Going' },
          { key: 'going_pct', label: 'Going %' },
          { key: 'attended', label: 'Attended' },
          { key: 'attended_pct', label: 'Attended %' },
        ],
      ],
    };
    if (!sets[kind]) return res.status(404).json({ error: 'Unknown report' });
    const [rows, cols] = sets[kind];
    res.setHeader('Content-Disposition', `attachment; filename="upnotice-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('text/csv').send('﻿' + csv(rows, cols));
  })
);

export default router;
