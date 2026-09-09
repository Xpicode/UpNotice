import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, openLiveStream, signOutLocally, type Company, type Dashboard, type Department, type User } from './api';
import { showSystemNotification } from './notify';

export type Tab = 'home' | 'announcements' | 'meetings' | 'notifications' | 'people' | 'reports' | 'activity' | 'settings';
export type Detail = { type: 'announcement' | 'meeting'; id: number } | null;

interface Store {
  user: User | null;
  setUser: (u: User | null) => void;
  logout: () => void;
  tab: Tab;
  detail: Detail;
  go: (tab: Tab, detail?: Detail) => void;
  back: () => void;
  dashboard: Dashboard | null;
  departments: Department[];
  companies: Company[];
  /** Reloads companies + departments (call after adding either). */
  reloadDepartments: () => Promise<void>;
  /** Increments whenever the server says something changed; screens re-fetch when it changes. */
  version: number;
  bump: () => void;
  toast: (msg: string) => void;
  toastMsg: string | null;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children, initialUser }: { children: ReactNode; initialUser: User | null }) {
  const [user, setUserState] = useState<User | null>(initialUser);
  const [tab, setTab] = useState<Tab>('home');
  const [detail, setDetail] = useState<Detail>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [version, setVersion] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    if (!u) {
      setTab('home');
      setDetail(null);
      setDashboard(null);
    }
  }, []);

  const logout = useCallback(() => {
    // Tell the server first (so the refresh token is dead), then forget everything on this device.
    api.logout().catch(() => {});
    signOutLocally();
    setUser(null);
  }, [setUser]);

  const go = useCallback((t: Tab, d: Detail = null) => {
    setTab(t);
    setDetail(d);
    window.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => setDetail(null), []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3500);
  }, []);

  const reloadDepartments = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([api.departments(), api.companies()]);
      setDepartments(d.departments);
      setCompanies(c.companies);
    } catch {
      /* ignore */
    }
  }, []);

  // Dashboard counts: refresh on every change + every minute.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = () =>
      api
        .dashboard()
        .then((d) => alive && setDashboard(d))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 60000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [user, version]);

  useEffect(() => {
    if (user) reloadDepartments();
  }, [user, reloadDepartments]);

  // Live stream from the server.
  useEffect(() => {
    if (!user) return;
    const close = openLiveStream((event, data) => {
      if (event === 'notification') {
        const n = data as { title: string; body: string };
        showSystemNotification(n.title, n.body || '');
        toast(n.title);
      }
      bump();
    });
    return close;
  }, [user, bump, toast]);

  const value = useMemo<Store>(
    () => ({ user, setUser, logout, tab, detail, go, back, dashboard, departments, companies, reloadDepartments, version, bump, toast, toastMsg }),
    [user, setUser, logout, tab, detail, go, back, dashboard, departments, companies, reloadDepartments, version, bump, toast, toastMsg]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

/**
 * A clock that re-renders the screen every so often, so anything that depends on the time —
 * the attendance check-in window above all — opens and closes by itself without a reload.
 * It also catches up the moment the app comes back to the foreground on a phone.
 */
export function useNow(everyMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs]);
  return now;
}

/** Fetches data and re-fetches whenever the live "version" changes. */
export function useLoader<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const { version } = useStore();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick, ...deps]);
  return { data, error, loading, reload, setData };
}
