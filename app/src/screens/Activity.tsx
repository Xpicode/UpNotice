// Admin-only activity log: who did what and when. Entries can be deleted one at a time or several at once;
// the deletion itself is recorded by the server, so the log always shows that something was removed.
import { useState } from 'react';
import { api, timeAgo, formatDateTime, sqlToIso, type ActivityEntry } from '../api';
import { useLoader, useStore } from '../store';
import { ChipButton, Confirm, Empty, SkeletonList } from '../components/ui';
import { Avatar } from '../components/social';
import { ActivityIcon, SearchIcon, TrashIcon } from '../icons';
import { useDebounced } from '../components/filters';

type PendingDelete = { kind: 'one'; id: number } | { kind: 'selected' };

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
  const { go, toast } = useStore();
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dq = useDebounced(q);
  const [extra, setExtra] = useState<ActivityEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const { data, loading, error, setData } = useLoader(async () => {
    setExtra([]);
    setSelecting(false);
    setSelected(new Set());
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

  const canOpen = (e: ActivityEntry) => !!e.target_id && !e.action.endsWith('.delete') && (e.target_type === 'announcement' || e.target_type === 'meeting');

  const open = (e: ActivityEntry) => {
    if (selecting) return toggle(e.id);
    if (!canOpen(e)) return;
    if (e.target_type === 'announcement') go('announcements', { type: 'announcement', id: e.target_id! });
    else go('meetings', { type: 'meeting', id: e.target_id! });
  };

  // ---------- selecting and deleting ----------
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(selected.size === items.length ? new Set() : new Set(items.map((x) => x.id)));
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  // Drop the deleted rows from the list without reloading the whole page.
  const removeLocally = (ids: Set<number>) => {
    if (data) setData({ ...data, activity: data.activity.filter((x) => !ids.has(x.id)) });
    setExtra((rest) => rest.filter((x) => !ids.has(x.id)));
  };

  const runDelete = async () => {
    if (!pending) return;
    const ids = pending.kind === 'one' ? new Set([pending.id]) : new Set(selected);
    try {
      if (pending.kind === 'one') await api.deleteActivity(pending.id);
      else await api.deleteActivityEntries([...ids]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete');
      throw err;
    }
    removeLocally(ids);
    toast(ids.size === 1 ? 'Activity entry deleted' : `${ids.size} entries deleted`);
    if (pending.kind !== 'one') stopSelecting();
  };

  const confirmText =
    pending?.kind === 'selected'
      ? { title: `Delete ${selected.size} selected entr${selected.size === 1 ? 'y' : 'ies'}?`, label: `Delete ${selected.size}` }
      : { title: 'Delete this activity entry?', label: 'Delete' };

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

      {items.length > 0 && (
        <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          {selecting ? (
            <>
              <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={selected.size === items.length} onChange={toggleAll} />
                {selected.size ? `${selected.size} selected` : 'Select all'}
              </label>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn ghost sm" onClick={stopSelecting}>
                  Cancel
                </button>
                <button className="btn danger sm" disabled={selected.size === 0} onClick={() => setPending({ kind: 'selected' })}>
                  <TrashIcon /> Delete{selected.size ? ` (${selected.size})` : ''}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">
                {items.length} entr{items.length === 1 ? 'y' : 'ies'}
                {more ? ' so far' : ''}
              </p>
              <button className="btn ghost sm" onClick={() => setSelecting(true)}>
                Select
              </button>
            </>
          )}
        </div>
      )}

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
                  className={`list-item notif-row${selected.has(e.id) ? ' selected' : ''}`}
                  style={{ cursor: selecting || canOpen(e) ? 'pointer' : undefined }}
                  onClick={() => open(e)}
                >
                  {selecting ? (
                    <input
                      type="checkbox"
                      checked={selected.has(e.id)}
                      onChange={() => toggle(e.id)}
                      onClick={(ev) => ev.stopPropagation()}
                      aria-label={`Select entry by ${e.user_name || 'System'}`}
                    />
                  ) : (
                    <Avatar userId={e.user_id || 0} name={e.user_name || '?'} avatarUrl={e.avatar_url} size={34} />
                  )}
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
                  {!selecting && (
                    <button
                      className="btn ghost icon-btn notif-delete"
                      title="Delete"
                      aria-label="Delete activity entry"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setPending({ kind: 'one', id: e.id });
                      }}
                    >
                      <TrashIcon />
                    </button>
                  )}
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
      {pending && (
        <Confirm
          title={confirmText.title}
          message="This cannot be undone. The announcement, meeting or person the entry refers to is not affected, and the log will record that you removed it."
          confirmLabel={confirmText.label}
          danger
          onClose={() => setPending(null)}
          onConfirm={runDelete}
        />
      )}
    </>
  );
}
