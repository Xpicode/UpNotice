import { useState } from 'react';
import { api, timeAgo, type Notification } from '../api';
import { useLoader, useStore } from '../store';
import { Confirm, Empty, Spinner } from '../components/ui';
import { BellIcon, CalendarIcon, MegaphoneIcon, TrashIcon } from '../icons';

type PendingDelete = { kind: 'one'; id: number } | { kind: 'selected' } | { kind: 'read' } | { kind: 'all' };

export function NotificationsScreen() {
  const { go, bump, toast } = useStore();
  const { data, loading, error, setData } = useLoader(() => api.notifications());
  const items = data?.notifications || [];
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const readCount = items.filter((x) => x.read_at).length;

  const open = async (n: Notification) => {
    if (selecting) {
      toggle(n.id);
      return;
    }
    if (!n.read_at) {
      api.markNotificationRead(n.id).then(bump).catch(() => {});
      setData({ notifications: items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)), unread: Math.max(0, (data?.unread || 1) - 1) });
    }
    if (n.ref_type && n.ref_id) go(n.ref_type === 'meeting' ? 'meetings' : 'announcements', { type: n.ref_type, id: n.ref_id });
  };

  const readAll = async () => {
    await api.markAllNotificationsRead();
    setData({ notifications: items.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })), unread: 0 });
    bump();
  };

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => setSelected(selected.size === items.length ? new Set() : new Set(items.map((x) => x.id)));
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  // Remove the given rows from the list without waiting for a reload.
  const removeLocally = (ids: Set<number>) => {
    const remaining = items.filter((x) => !ids.has(x.id));
    setData({ notifications: remaining, unread: remaining.filter((x) => !x.read_at).length });
  };

  const runDelete = async () => {
    if (!pending) return;
    let removed: Set<number>;
    try {
      removed = await deleteOnServer(pending);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete');
      throw err;
    }
    removeLocally(removed);
    toast(removed.size === 1 ? 'Notification deleted' : `${removed.size} notifications deleted`);
    if (pending.kind !== 'one') stopSelecting();
    bump();
  };

  const deleteOnServer = async (pending: PendingDelete): Promise<Set<number>> => {
    let removed: Set<number>;
    if (pending.kind === 'one') {
      await api.deleteNotification(pending.id);
      removed = new Set([pending.id]);
    } else if (pending.kind === 'selected') {
      await api.deleteNotifications({ ids: [...selected] });
      removed = new Set(selected);
    } else if (pending.kind === 'read') {
      await api.deleteNotifications({ read: true });
      removed = new Set(items.filter((x) => x.read_at).map((x) => x.id));
    } else {
      await api.deleteNotifications({ all: true });
      removed = new Set(items.map((x) => x.id));
    }
    return removed;
  };

  const confirmText: Record<PendingDelete['kind'], { title: string; message: string; label: string }> = {
    one: { title: 'Delete this notification?', message: 'It will be removed from your alerts. The announcement or meeting itself is not affected.', label: 'Delete' },
    selected: { title: `Delete ${selected.size} selected?`, message: 'The selected notifications will be removed from your alerts. Announcements and meetings are not affected.', label: `Delete ${selected.size}` },
    read: { title: `Clear ${readCount} read notification${readCount === 1 ? '' : 's'}?`, message: 'Only notifications you have already opened will be removed.', label: 'Clear read' },
    all: { title: 'Clear all notifications?', message: 'Every notification in your alerts will be removed. Announcements and meetings are not affected.', label: 'Clear all' },
  };

  return (
    <>
      <div className="row between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        {selecting ? (
          <>
            <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={items.length > 0 && selected.size === items.length} onChange={toggleAll} />
              {selected.size ? `${selected.size} selected` : 'Select all'}
            </label>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn ghost sm" onClick={stopSelecting}>Cancel</button>
              <button className="btn danger sm" disabled={selected.size === 0} onClick={() => setPending({ kind: 'selected' })}>
                <TrashIcon /> Delete{selected.size ? ` (${selected.size})` : ''}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">{data?.unread ? `${data.unread} unread` : 'All caught up'}</p>
            <div className="row" style={{ gap: 6 }}>
              {!!data?.unread && <button className="btn ghost sm" onClick={readAll}>Mark all as read</button>}
              {items.length > 0 && <button className="btn ghost sm" onClick={() => setSelecting(true)}>Select</button>}
            </div>
          </>
        )}
      </div>
      {loading && <Spinner />}
      {error && <div className="error">{error}</div>}
      {!loading && items.length === 0 && <Empty icon={<BellIcon />} title="No notifications" hint="You'll be notified about new announcements and meeting invites." />}
      <div className="card" style={{ padding: '4px 16px', display: items.length ? undefined : 'none' }}>
        <div className="list">
          {items.map((n) => (
            <div
              key={n.id}
              className={`list-item notif-row${selected.has(n.id) ? ' selected' : ''}`}
              style={{ cursor: 'pointer', opacity: n.read_at && !selecting ? 0.7 : 1 }}
              onClick={() => open(n)}
            >
              {selecting ? (
                <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggle(n.id)} onClick={(e) => e.stopPropagation()} aria-label="Select notification" />
              ) : (
                <div className={`avatar ${n.read_at ? 'grey' : ''}`}>
                  {n.type === 'meeting' ? <CalendarIcon style={{ width: 18, height: 18 }} /> : <MegaphoneIcon style={{ width: 18, height: 18 }} />}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: n.read_at ? 500 : 700 }}>{n.title}</div>
                {n.body && <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>}
              </div>
              <span className="tiny muted" style={{ flexShrink: 0 }}>{timeAgo(n.created_at)}</span>
              {!selecting && (
                <button
                  className="btn ghost icon-btn notif-delete"
                  title="Delete"
                  aria-label="Delete notification"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPending({ kind: 'one', id: n.id });
                  }}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {items.length > 0 && !selecting && (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
          {readCount > 0 && <button className="btn ghost sm" onClick={() => setPending({ kind: 'read' })}>Clear read ({readCount})</button>}
          <button className="btn ghost sm" onClick={() => setPending({ kind: 'all' })}>Clear all</button>
        </div>
      )}
      {pending && (
        <Confirm
          title={confirmText[pending.kind].title}
          message={confirmText[pending.kind].message}
          confirmLabel={confirmText[pending.kind].label}
          danger
          onClose={() => setPending(null)}
          onConfirm={runDelete}
        />
      )}
    </>
  );
}
