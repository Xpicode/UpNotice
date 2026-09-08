// Admin-only activity log: who did what and when.
import { useState } from 'react';
import { api, timeAgo, formatDateTime, sqlToIso, type ActivityEntry } from '../api';
import { useLoader, useStore } from '../store';
import { ChipButton, Empty, SkeletonList } from '../components/ui';
import { Avatar } from '../components/social';
import { ActivityIcon, SearchIcon } from '../icons';
import { useDebounced } from '../components/filters';

const GROUPS: { key: string; label: string }[] = [
  { key: '', label: 'Everything' },
  { key: 'announcement.', label: 'Announcements' },
  { key: 'meeting.', label: 'Meetings' },
  { key: 'user.', label: 'People' },
  { key: 'company.', label: 'Companies' },
  { key: 'department.', label: 'Departments' },
  { key: 'auth.', label: 'Sign-ins & passwords' },
  { key: 'template.', label: 'Templates' },
];

function describe(e: ActivityEntry): string {
  const d = e.details || {};
  const title = typeof d.title === 'string' ? d.title : typeof d.name === 'string' ? d.name : '';
  const parts: string[] = [];
  if (title) parts.push(`“${title}”`);
  if (typeof d.email === 'string') parts.push(d.email);
  if (typeof d.role === 'string' && e.action === 'user.create') parts.push(`as ${d.role}`);
  if (e.action === 'user.update' && d.password_reset === true) parts.push('password reset');
  if (e.action === 'user.update' && d.active === 0) parts.push('deactivated');
  if (e.action === 'user.import') parts.push(`${d.created ?? 0} added, ${d.skipped ?? 0} skipped`);
  if (e.action === 'meeting.create' && Number(d.count) > 1) parts.push(`${d.count} occurrences`);
  if (e.action === 'meeting.attendance') parts.push(`${typeof d.person === 'string' ? d.person + ' ' : ''}${d.present ? 'marked present' : 'marked absent'}`);
  if (e.action === 'meeting.delete' && d.series && d.series !== 'one') parts.push(`series: ${d.series}`);
  if (e.action === 'announcement.create' && d.scheduled) parts.push('scheduled');
  return parts.join(' · ');
}

export function ActivityScreen() {
  const { go } = useStore();
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dq = useDebounced(q);
  const [extra, setExtra] = useState<ActivityEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const { data, loading, error } = useLoader(async () => {
    setExtra([]);
    return api.activity({ limit: 100, action: group || undefined, q: dq || undefined, from: from || undefined, to: to || undefined });
  }, [group, dq, from, to]);
  const items = [...(data?.activity || []), ...extra];
  const lastId = items[items.length - 1]?.id;
  const more = extra.length ? extra.length % 100 === 0 : !!data?.more;

  const loadMore = async () => {
    if (!lastId) return;
    setLoadingMore(true);
    try {
      const r = await api.activity({ limit: 100, before: lastId, action: group || undefined, q: dq || undefined, from: from || undefined, to: to || undefined });
      setExtra((x) => [...x, ...r.activity]);
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (e: ActivityEntry) => {
    if (e.target_type === 'announcement' && e.target_id && !e.action.endsWith('.delete')) go('announcements', { type: 'announcement', id: e.target_id });
    else if (e.target_type === 'meeting' && e.target_id && !e.action.endsWith('.delete')) go('meetings', { type: 'meeting', id: e.target_id });
  };

  // Group by day for readability.
  const days = new Map<string, ActivityEntry[]>();
  for (const e of items) {
    const day = new Date(sqlToIso(e.created_at)).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(e);
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="search" style={{ flex: 2, minWidth: 200 }}>
            <SearchIcon />
            <input className="input" placeholder="Search by person or item…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label>From</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}>
            <label>To</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="dept-pick scroll-x" style={{ marginTop: 12 }} role="group" aria-label="Type">
          {GROUPS.map((g) => (
            <ChipButton key={g.key} active={group === g.key} onClick={() => setGroup(g.key)}>
              {g.label}
            </ChipButton>
          ))}
        </div>
      </div>

      {loading && <SkeletonList count={3} />}
      {error && <div className="error">{error}</div>}
      {!loading && items.length === 0 && <Empty icon={<ActivityIcon />} title="No activity yet" hint="Actions like posting, editing, deleting and signing in are recorded here." />}

      {[...days.entries()].map(([day, list]) => (
        <div key={day}>
          <div className="section-title">{day}</div>
          <div className="card" style={{ padding: '4px 16px' }}>
            <div className="list">
              {list.map((e) => (
                <div
                  key={e.id}
                  className="list-item"
                  style={{ cursor: e.target_type && !e.action.endsWith('.delete') && (e.target_type === 'announcement' || e.target_type === 'meeting') ? 'pointer' : undefined }}
                  onClick={() => open(e)}
                >
                  <Avatar userId={e.user_id || 0} name={e.user_name || '?'} avatarUrl={e.avatar_url} size={34} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      <strong>{e.user_name || 'System'}</strong> <span className="muted">{e.label.toLowerCase()}</span> {describe(e)}
                    </div>
                    <div className="tiny muted" title={formatDateTime(sqlToIso(e.created_at))}>
                      {timeAgo(e.created_at)} · {new Date(sqlToIso(e.created_at)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                  <span className="chip" style={{ flexShrink: 0 }}>
                    {e.action.split('.')[0]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
      {more && items.length > 0 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older activity'}
          </button>
        </div>
      )}
    </>
  );
}
