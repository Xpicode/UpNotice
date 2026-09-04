// Admin reports: read rates and attendance, with CSV export.
import { Router } from 'express';
import { db, audienceUserIds, nowIso } from '../db.js';
import { requireAuth, requireStaff, companyScope, wrap } from '../auth.js';

const router = Router();
router.use(requireAuth, requireStaff);

async function targets(table, key, id) {
  return (await db.all(`SELECT department_id FROM ${table} WHERE ${key} = ?`, [id])).map((r) => r.department_id);
}

function employees(scope) {
  return db.all(
    `SELECT u.id, u.name, u.email, u.company_id, u.department_id, c.name AS company_name, d.name AS department_name
     FROM users u LEFT JOIN companies c ON c.id = u.company_id LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.role IN ('employee', 'manager') AND u.active = 1 ${scope !== null ? 'AND u.company_id = ?' : ''} ORDER BY c.name, d.name, u.name`,
    scope !== null ? [scope] : []
  );
}

/** Builds the full report data once; the JSON and CSV endpoints both use it. */
async function buildReport({ from, to, scope = null }) {
  const inRange = (iso) => (!from || iso >= from) && (!to || iso <= to);
  const inScope = (row) => scope === null || row.company_id === scope || row.company_id === null;
  const emps = await employees(scope);
  const companyNames = new Map((await db.all('SELECT id, name FROM companies')).map((c) => [c.id, c.name]));
  const byId = new Map(emps.map((e) => [e.id, { ...e, sent: 0, read: 0, acked: 0, ackRequired: 0, invited: 0, going: 0, maybe: 0, declined: 0, noReply: 0, attended: 0 }]));

  // ---- announcements ----
  const anns = (await db.all('SELECT * FROM announcements WHERE is_draft = 0 ORDER BY COALESCE(publish_at, created_at) DESC')).filter((a) => inScope(a) && inRange((a.publish_at || a.created_at).replace(' ', 'T')));
  const annRows = [];
  for (const a of anns) {
    const audience = (await audienceUserIds(a.company_id, await targets('announcement_targets', 'announcement_id', a.id))).filter((id) => id !== a.author_id && (scope === null || byId.has(id)));
    const reads = new Map((await db.all('SELECT user_id, acknowledged_at FROM announcement_reads WHERE announcement_id = ?', [a.id])).map((r) => [r.user_id, r]));
    let readN = 0, ackN = 0;
    for (const uid of audience) {
      const e = byId.get(uid);
      const r = reads.get(uid);
      if (e) {
        e.sent++;
        if (a.ack_required) e.ackRequired++;
      }
      if (r) {
        readN++;
        if (e) e.read++;
        if (r.acknowledged_at) {
          ackN++;
          if (e) e.acked++;
        }
      }
    }
    const company = a.company_id ? companyNames.get(a.company_id) : 'All companies';
    annRows.push({ id: a.id, title: a.title, priority: a.priority, category: a.category || '', company, date: a.publish_at || a.created_at, audience: audience.length, read: readN, read_pct: audience.length ? Math.round((readN / audience.length) * 100) : 0, ack_required: !!a.ack_required, acked: ackN });
  }

  // ---- meetings ----
  const meets = (await db.all("SELECT * FROM meetings WHERE status = 'scheduled' ORDER BY starts_at DESC")).filter((m) => inScope(m) && inRange(m.starts_at));
  const meetRows = [];
  for (const m of meets) {
    const audience = (await audienceUserIds(m.company_id, await targets('meeting_targets', 'meeting_id', m.id))).filter((id) => id !== m.organizer_id && (scope === null || byId.has(id)));
    const rsvps = new Map((await db.all('SELECT user_id, status FROM meeting_rsvps WHERE meeting_id = ?', [m.id])).map((r) => [r.user_id, r.status]));
    const attended = new Set((await db.all('SELECT user_id FROM meeting_attendance WHERE meeting_id = ?', [m.id])).map((r) => r.user_id));
    const counts = { going: 0, maybe: 0, declined: 0, noReply: 0, attended: 0 };
    for (const uid of audience) {
      const st = rsvps.get(uid) || 'noReply';
      counts[st]++;
      if (attended.has(uid)) counts.attended++;
      const e = byId.get(uid);
      if (e) {
        e.invited++;
        e[st]++;
        if (attended.has(uid)) e.attended++;
      }
    }
    const company = m.company_id ? companyNames.get(m.company_id) : 'All companies';
    const past = m.ends_at < nowIso();
    meetRows.push({ id: m.id, title: m.title, company, date: m.starts_at, past, audience: audience.length, ...counts, going_pct: audience.length ? Math.round((counts.going / audience.length) * 100) : 0, attended_pct: audience.length && (past || counts.attended) ? Math.round((counts.attended / audience.length) * 100) : null, has_minutes: !!(m.minutes && m.minutes.trim()) });
  }

  // ---- per company / department roll-up ----
  const groups = new Map();
  for (const e of byId.values()) {
    const key = `${e.company_name || 'No company'}||${e.department_name || 'No department'}`;
    if (!groups.has(key)) groups.set(key, { company: e.company_name || 'No company', department: e.department_name || 'No department', employees: 0, sent: 0, read: 0, invited: 0, going: 0, declined: 0, attended: 0 });
    const g = groups.get(key);
    g.employees++;
    g.sent += e.sent; g.read += e.read; g.invited += e.invited; g.going += e.going; g.declined += e.declined; g.attended += e.attended;
  }
  const groupRows = [...groups.values()].map((g) => ({ ...g, read_pct: g.sent ? Math.round((g.read / g.sent) * 100) : null, going_pct: g.invited ? Math.round((g.going / g.invited) * 100) : null, attended_pct: g.invited ? Math.round((g.attended / g.invited) * 100) : null }));

  const empRows = [...byId.values()].map((e) => ({
    id: e.id, name: e.name, email: e.email, company: e.company_name, department: e.department_name,
    sent: e.sent, read: e.read, read_pct: e.sent ? Math.round((e.read / e.sent) * 100) : null,
    ack_required: e.ackRequired, acked: e.acked,
    invited: e.invited, going: e.going, maybe: e.maybe, declined: e.declined, no_reply: e.noReply,
    attendance_pct: e.invited ? Math.round((e.going / e.invited) * 100) : null,
    attended: e.attended, attended_pct: e.invited ? Math.round((e.attended / e.invited) * 100) : null,
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
router.get('/export/:kind', wrap(async (req, res) => {
  const data = await buildReport(range(req));
  const kind = String(req.params.kind).replace(/\.csv$/, '');
  const sets = {
    employees: [data.employees, [
      { key: 'name', label: 'Employee' }, { key: 'email', label: 'Email' }, { key: 'company', label: 'Company' }, { key: 'department', label: 'Department' },
      { key: 'sent', label: 'Announcements received' }, { key: 'read', label: 'Read' }, { key: 'read_pct', label: 'Read %' },
      { key: 'ack_required', label: 'Acknowledgements required' }, { key: 'acked', label: 'Acknowledged' },
      { key: 'invited', label: 'Meetings invited' }, { key: 'going', label: 'Going' }, { key: 'maybe', label: 'Maybe' }, { key: 'declined', label: 'Declined' }, { key: 'no_reply', label: 'No reply' }, { key: 'attendance_pct', label: 'Going %' },
      { key: 'attended', label: 'Actually attended' }, { key: 'attended_pct', label: 'Attended %' },
    ]],
    announcements: [data.announcements, [
      { key: 'date', label: 'Date' }, { key: 'title', label: 'Title' }, { key: 'priority', label: 'Priority' }, { key: 'category', label: 'Category' }, { key: 'company', label: 'Company' },
      { key: 'audience', label: 'Sent to' }, { key: 'read', label: 'Read' }, { key: 'read_pct', label: 'Read %' }, { label: 'Ack required', get: (r) => (r.ack_required ? 'yes' : 'no') }, { key: 'acked', label: 'Acknowledged' },
    ]],
    meetings: [data.meetings, [
      { key: 'date', label: 'Date' }, { key: 'title', label: 'Title' }, { key: 'company', label: 'Company' }, { key: 'audience', label: 'Invited' },
      { key: 'going', label: 'Going' }, { key: 'maybe', label: 'Maybe' }, { key: 'declined', label: 'Declined' }, { key: 'noReply', label: 'No reply' }, { key: 'going_pct', label: 'Going %' },
      { key: 'attended', label: 'Attended' }, { key: 'attended_pct', label: 'Attended %' }, { label: 'Minutes', get: (r) => (r.has_minutes ? 'yes' : 'no') },
    ]],
    departments: [data.groups, [
      { key: 'company', label: 'Company' }, { key: 'department', label: 'Department' }, { key: 'employees', label: 'Employees' },
      { key: 'sent', label: 'Announcements sent' }, { key: 'read', label: 'Read' }, { key: 'read_pct', label: 'Read %' },
      { key: 'invited', label: 'Meeting invites' }, { key: 'going', label: 'Going' }, { key: 'going_pct', label: 'Going %' }, { key: 'attended', label: 'Attended' }, { key: 'attended_pct', label: 'Attended %' },
    ]],
  };
  if (!sets[kind]) return res.status(404).json({ error: 'Unknown report' });
  const [rows, cols] = sets[kind];
  res.setHeader('Content-Disposition', `attachment; filename="upnotice-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.type('text/csv').send('﻿' + csv(rows, cols));
}));

export default router;
