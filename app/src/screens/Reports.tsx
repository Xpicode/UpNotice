// Admin reports: read rates and attendance, per company/department and per employee, with CSV export.
import { useState } from 'react';
import { api, formatDateTime, type ReportSummary } from '../api';
import { useLoader, useStore } from '../store';
import { Spinner } from '../components/ui';
import { LinkIcon } from '../icons';

function Pct({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="pct none">–</span>;
  const cls = v >= 80 ? 'good' : v >= 50 ? 'mid' : 'bad';
  return <span className={`pct ${cls}`}>{v}%</span>;
}

type View = 'departments' | 'employees' | 'announcements' | 'meetings';

export function ReportsScreen() {
  const { go } = useStore();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [view, setView] = useState<View>('departments');
  const [q, setQ] = useState('');
  const { data, loading, error } = useLoader(() => api.reportSummary(from || undefined, to || undefined), [from, to]);

  const open = (kind: View) => {
    const url = api.reportCsvUrl(kind, from || undefined, to || undefined);
    window.open(url, '_blank');
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label>From</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label>To</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {(from || to) && <button className="btn" onClick={() => { setFrom(''); setTo(''); }}>All time</button>}
          <button className="btn primary" onClick={() => open(view)}><LinkIcon /> Download CSV</button>
        </div>
        <p className="tiny muted" style={{ marginTop: 8 }}>CSV files open in Excel. The download uses the current tab and date range.</p>
      </div>

      {loading && <Spinner />}
      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <div className="grid-3" style={{ marginBottom: 14 }}>
            <div className="stat"><div className="num">{data.totals.announcements}</div><div className="lbl">Announcements</div></div>
            <div className="stat"><div className="num"><Pct v={data.totals.avg_read_pct} /></div><div className="lbl">Average read rate</div></div>
            <div className="stat"><div className="num">{data.totals.meetings}</div><div className="lbl">Meetings</div></div>
            <div className="stat"><div className="num"><Pct v={data.totals.avg_going_pct} /></div><div className="lbl">Average "going" rate</div></div>
            <div className="stat"><div className="num"><Pct v={data.totals.avg_attended_pct} /></div><div className="lbl">Average actual attendance</div></div>
          </div>

          <div className="row between wrap" style={{ marginBottom: 10 }}>
            <div className="seg">
              <button className={view === 'departments' ? 'active' : ''} onClick={() => setView('departments')}>Departments</button>
              <button className={view === 'employees' ? 'active' : ''} onClick={() => setView('employees')}>Employees</button>
              <button className={view === 'announcements' ? 'active' : ''} onClick={() => setView('announcements')}>Announcements</button>
              <button className={view === 'meetings' ? 'active' : ''} onClick={() => setView('meetings')}>Meetings</button>
            </div>
            {view === 'employees' && <input className="input" style={{ maxWidth: 240 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />}
          </div>

          <div className="card table-wrap" style={{ padding: 0 }}>
            {view === 'departments' && <DepartmentsTable d={data} />}
            {view === 'employees' && <EmployeesTable d={data} q={q} />}
            {view === 'announcements' && <AnnouncementsTable d={data} onOpen={(id) => go('announcements', { type: 'announcement', id })} />}
            {view === 'meetings' && <MeetingsTable d={data} onOpen={(id) => go('meetings', { type: 'meeting', id })} />}
          </div>
        </>
      )}
    </>
  );
}

function DepartmentsTable({ d }: { d: ReportSummary }) {
  return (
    <table className="report">
      <thead><tr><th>Company</th><th>Department</th><th className="num">Employees</th><th className="num">Announcements sent</th><th className="num">Read</th><th className="num">Read %</th><th className="num">Invites</th><th className="num">Going</th><th className="num">Going %</th><th className="num">Attended</th><th className="num">Attended %</th></tr></thead>
      <tbody>
        {d.groups.length === 0 && <tr><td colSpan={11} className="muted">No employees yet.</td></tr>}
        {d.groups.map((g, i) => (
          <tr key={i}><td>{g.company}</td><td>{g.department}</td><td className="num">{g.employees}</td><td className="num">{g.sent}</td><td className="num">{g.read}</td><td className="num"><Pct v={g.read_pct} /></td><td className="num">{g.invited}</td><td className="num">{g.going}</td><td className="num"><Pct v={g.going_pct} /></td><td className="num">{g.attended}</td><td className="num"><Pct v={g.attended_pct} /></td></tr>
        ))}
      </tbody>
    </table>
  );
}

function EmployeesTable({ d, q }: { d: ReportSummary; q: string }) {
  const rows = d.employees.filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase()) || (e.department || '').toLowerCase().includes(q.toLowerCase()) || (e.company || '').toLowerCase().includes(q.toLowerCase()));
  return (
    <table className="report">
      <thead><tr><th>Employee</th><th>Company · Dept</th><th className="num">Received</th><th className="num">Read</th><th className="num">Read %</th><th className="num">Ack'd</th><th className="num">Invited</th><th className="num">Going</th><th className="num">Maybe</th><th className="num">Declined</th><th className="num">No reply</th><th className="num">Going %</th><th className="num">Attended</th><th className="num">Attended %</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={14} className="muted">No employees match.</td></tr>}
        {rows.map((e) => (
          <tr key={e.id}>
            <td><strong>{e.name}</strong><div className="tiny muted">{e.email}</div></td>
            <td className="small">{[e.company, e.department].filter(Boolean).join(' · ') || '–'}</td>
            <td className="num">{e.sent}</td><td className="num">{e.read}</td><td className="num"><Pct v={e.read_pct} /></td>
            <td className="num">{e.ack_required ? `${e.acked}/${e.ack_required}` : '–'}</td>
            <td className="num">{e.invited}</td><td className="num">{e.going}</td><td className="num">{e.maybe}</td><td className="num">{e.declined}</td><td className="num">{e.no_reply}</td>
            <td className="num"><Pct v={e.attendance_pct} /></td>
            <td className="num">{e.attended}</td><td className="num"><Pct v={e.attended_pct} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnnouncementsTable({ d, onOpen }: { d: ReportSummary; onOpen: (id: number) => void }) {
  return (
    <table className="report">
      <thead><tr><th>Date</th><th>Title</th><th>Topic</th><th>Sent to</th><th className="num">People</th><th className="num">Read</th><th className="num">Read %</th><th className="num">Acknowledged</th></tr></thead>
      <tbody>
        {d.announcements.length === 0 && <tr><td colSpan={8} className="muted">No announcements in this range.</td></tr>}
        {d.announcements.map((a) => (
          <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(a.id)}>
            <td className="small">{formatDateTime(a.date.includes('T') ? a.date : a.date.replace(' ', 'T') + 'Z')}</td>
            <td><strong>{a.title}</strong>{a.priority !== 'normal' && <span className={`chip ${a.priority === 'urgent' ? 'danger' : 'warn'}`} style={{ marginLeft: 6 }}>{a.priority}</span>}</td>
            <td className="small">{a.category || '–'}</td>
            <td className="small">{a.company}</td>
            <td className="num">{a.audience}</td><td className="num">{a.read}</td><td className="num"><Pct v={a.read_pct} /></td>
            <td className="num">{a.ack_required ? `${a.acked}/${a.audience}` : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MeetingsTable({ d, onOpen }: { d: ReportSummary; onOpen: (id: number) => void }) {
  return (
    <table className="report">
      <thead><tr><th>Date</th><th>Title</th><th>Sent to</th><th className="num">Invited</th><th className="num">Going</th><th className="num">Maybe</th><th className="num">Declined</th><th className="num">No reply</th><th className="num">Going %</th><th className="num">Attended</th><th className="num">Attended %</th><th>Minutes</th></tr></thead>
      <tbody>
        {d.meetings.length === 0 && <tr><td colSpan={12} className="muted">No meetings in this range.</td></tr>}
        {d.meetings.map((m) => (
          <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(m.id)}>
            <td className="small">{formatDateTime(m.date)}{m.past && <span className="chip" style={{ marginLeft: 6 }}>Ended</span>}</td>
            <td><strong>{m.title}</strong></td>
            <td className="small">{m.company}</td>
            <td className="num">{m.audience}</td><td className="num">{m.going}</td><td className="num">{m.maybe}</td><td className="num">{m.declined}</td><td className="num">{m.noReply}</td>
            <td className="num"><Pct v={m.going_pct} /></td>
            <td className="num">{m.attended}</td><td className="num"><Pct v={m.attended_pct} /></td>
            <td className="small">{m.has_minutes ? 'yes' : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
