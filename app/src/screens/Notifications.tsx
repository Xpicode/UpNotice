import { api, timeAgo, type Notification } from '../api';
import { useLoader, useStore } from '../store';
import { Empty, Spinner } from '../components/ui';
import { BellIcon, CalendarIcon, MegaphoneIcon } from '../icons';

export function NotificationsScreen() {
  const { go, bump } = useStore();
  const { data, loading, error, setData } = useLoader(() => api.notifications());
  const items = data?.notifications || [];

  const open = async (n: Notification) => {
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

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <p className="muted small">{data?.unread ? `${data.unread} unread` : 'All caught up'}</p>
        {!!data?.unread && <button className="btn ghost sm" onClick={readAll}>Mark all as read</button>}
      </div>
      {loading && <Spinner />}
      {error && <div className="error">{error}</div>}
      {!loading && items.length === 0 && <Empty icon={<BellIcon />} title="No notifications" hint="You'll be notified about new announcements and meeting invites." />}
      <div className="card" style={{ padding: '4px 16px', display: items.length ? undefined : 'none' }}>
        <div className="list">
          {items.map((n) => (
            <div key={n.id} className="list-item" style={{ cursor: 'pointer', opacity: n.read_at ? 0.7 : 1 }} onClick={() => open(n)}>
              <div className={`avatar ${n.read_at ? 'grey' : ''}`}>
                {n.type === 'meeting' ? <CalendarIcon style={{ width: 18, height: 18 }} /> : <MegaphoneIcon style={{ width: 18, height: 18 }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: n.read_at ? 500 : 700 }}>{n.title}</div>
                {n.body && <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>}
              </div>
              <span className="tiny muted" style={{ flexShrink: 0 }}>{timeAgo(n.created_at)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
