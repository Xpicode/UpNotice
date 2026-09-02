import { useEffect, useState } from 'react';
import { api, getToken, setToken, type User } from './api';
import { StoreProvider, useStore, type Tab } from './store';
import { Toast } from './components/ui';
import { LoginScreen } from './screens/Login';
import { HomeScreen } from './screens/Home';
import { AnnouncementsScreen, AnnouncementDetail } from './screens/Announcements';
import { MeetingsScreen, MeetingDetail } from './screens/Meetings';
import { NotificationsScreen } from './screens/Notifications';
import { PeopleScreen } from './screens/People';
import { SettingsScreen } from './screens/Settings';
import { ReportsScreen } from './screens/Reports';
import { Avatar } from './components/social';
import { BackIcon, BellIcon, CalendarIcon, ChartIcon, HomeIcon, MegaphoneIcon, SettingsIcon, UsersIcon } from './icons';
import { requestNotificationPermission, enablePush } from './notify';

const TITLES: Record<Tab, string> = {
  home: 'Home',
  announcements: 'Announcements',
  meetings: 'Meetings',
  notifications: 'Notifications',
  people: 'People',
  reports: 'Reports',
  settings: 'Settings',
};

export default function App() {
  const [booting, setBooting] = useState(!!getToken());
  const [user, setUser] = useState<User | null>(null);

  // Restore the session on startup.
  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((r) => setUser(r.user))
      .catch((e: { status?: number }) => {
        if (e.status === 401 || e.status === 403) setToken(null);
      })
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="spinner" style={{ marginTop: '40vh' }} />;
  if (!user) return <LoginScreen onLogin={(u) => { setUser(u); requestNotificationPermission(); enablePush(); }} />;

  return (
    <StoreProvider initialUser={user} key={user.id}>
      <Shell onSignedOut={() => setUser(null)} />
    </StoreProvider>
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const { user, tab, detail, go, back, dashboard } = useStore();

  // When the store's user is cleared (logout), fall back to the login screen.
  useEffect(() => {
    if (!user) onSignedOut();
  }, [user, onSignedOut]);

  // Mobile: register for push and open the right screen when a push is tapped.
  useEffect(() => {
    if (!user) return;
    enablePush((data) => {
      const id = Number(data.refId);
      if (data.refType === 'meeting' && id) go('meetings', { type: 'meeting', id });
      else if (data.refType === 'announcement' && id) go('announcements', { type: 'announcement', id });
      else go('notifications');
    });
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user) return null;

  const isAdmin = user.role === 'admin';
  const unread = dashboard?.unreadNotifications || 0;
  type TabDef = { id: Tab; label: string; icon: typeof HomeIcon; badge?: number; adminOnly?: boolean };
  const allTabs: TabDef[] = [
    { id: 'home', label: 'Home', icon: HomeIcon },
    { id: 'announcements', label: 'Announcements', icon: MegaphoneIcon, badge: isAdmin ? 0 : dashboard?.unreadAnnouncements },
    { id: 'meetings', label: 'Meetings', icon: CalendarIcon, badge: isAdmin ? 0 : dashboard?.pendingRsvps },
    { id: 'notifications', label: 'Alerts', icon: BellIcon, badge: unread },
    { id: 'people', label: 'People', icon: UsersIcon, adminOnly: true },
    { id: 'reports', label: 'Reports', icon: ChartIcon, adminOnly: true },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];
  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);

  // Mobile bottom bar shows at most 5 tabs; admins get People instead of Settings there (Settings is reachable via the top-right gear).
  const mobileTabs = tabs.filter((t) => t.id !== 'settings' && t.id !== 'reports').slice(0, 5);

  let title = TITLES[tab];
  let body: React.ReactNode;
  if (detail?.type === 'announcement') {
    title = 'Announcement';
    body = <AnnouncementDetail id={detail.id} />;
  } else if (detail?.type === 'meeting') {
    title = 'Meeting';
    body = <MeetingDetail id={detail.id} />;
  } else {
    body = {
      home: <HomeScreen />,
      announcements: <AnnouncementsScreen />,
      meetings: <MeetingsScreen />,
      notifications: <NotificationsScreen />,
      people: isAdmin ? <PeopleScreen /> : <HomeScreen />,
      reports: isAdmin ? <ReportsScreen /> : <HomeScreen />,
      settings: <SettingsScreen />,
    }[tab];
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><MegaphoneIcon style={{ width: 20, height: 20 }} /></div>
          TeamAnnounce
        </div>
        {tabs.map((t) => (
          <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            <t.icon /> {t.label}
            {!!t.badge && <span className="count">{t.badge}</span>}
          </button>
        ))}
        <div className="nav-spacer" />
        <div className="nav-user row" style={{ gap: 10 }}>
          <Avatar userId={user.id} name={user.name} avatarUrl={user.avatar_url} size={36} />
          <div style={{ minWidth: 0 }}>
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</strong>
            {user.role === 'admin' ? 'Administrator' : [user.company_name, user.department_name].filter(Boolean).join(' · ') || 'Employee'}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {detail ? (
            <button className="btn ghost icon-btn" onClick={back} aria-label="Back"><BackIcon /></button>
          ) : (
            <div className="brand-mark" style={{ width: 30, height: 30, borderRadius: 8 }}><MegaphoneIcon style={{ width: 16, height: 16 }} /></div>
          )}
          <h1>{title}</h1>
          {!detail && isAdmin && tab !== 'reports' && (
            <button className="btn ghost icon-btn mobile-only" onClick={() => go('reports')} aria-label="Reports"><ChartIcon /></button>
          )}
          {!detail && tab !== 'settings' && (
            <button className="btn ghost icon-btn" onClick={() => go('settings')} aria-label="Settings"><SettingsIcon /></button>
          )}
        </header>
        <main className="content">{body}</main>
      </div>

      <nav className="tabbar">
        {mobileTabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id && !detail ? 'active' : ''}`} onClick={() => go(t.id)}>
            <t.icon />
            {t.label}
            {!!t.badge && <span className="badge-dot">{t.badge}</span>}
          </button>
        ))}
      </nav>

      <Toast />
    </div>
  );
}
