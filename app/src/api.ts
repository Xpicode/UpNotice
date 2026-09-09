// Small API client. Stores the server URL + the sign-in session so the same code works in the
// browser, in the Electron desktop app and in the Capacitor mobile app.
//
// A session is an access token (1 hour, sent as a Bearer header) plus a refresh token (30 days) that quietly
// fetches a new access token when the old one runs out. Tokens never go into URLs: files opened in a new tab
// use a short-lived "ticket" from the server, and images are fetched with the header and shown from memory.

export type Role = 'admin' | 'manager' | 'employee';

/** Admins and company managers can post, schedule and see receipts. */
export function isStaff(user: { role: Role } | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'manager';
}

export interface Company {
  id: number;
  name: string;
  member_count: number;
  department_count: number;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  company_id: number | null;
  company_name: string | null;
  department_id: number | null;
  department_name: string | null;
  active: number;
  created_at: string;
  avatar_url: string | null;
  email_notifications?: number;
  /** true until the person replaces the temporary password staff gave them */
  must_change_password?: boolean;
}

export interface Department {
  id: number;
  name: string;
  company_id: number | null;
  company_name: string | null;
  member_count: number;
}

export interface Announcement {
  id: number;
  title: string;
  body: string;
  priority: 'normal' | 'important' | 'urgent';
  pinned: boolean;
  company_id: number | null;
  company_name: string | null;
  author_id: number;
  author_name: string;
  created_at: string;
  read_count: number;
  read_by_me: boolean;
  audience_count?: number;
  targets: { id: number; name: string }[];
  readers?: Person[];
  unread?: Person[];
  /** Totals when the lists above were cut at 300 people. */
  readers_total?: number;
  unread_total?: number;
  // v3
  publish_at: string | null;
  expires_at: string | null;
  status: 'live' | 'scheduled' | 'expired' | 'draft';
  is_draft: boolean;
  category: string | null;
  /** true when the signed-in user may edit/delete this (admin, or manager of its company) */
  can_manage?: boolean;
  ack_required: boolean;
  acked_by_me: boolean;
  ack_count: number;
  comment_count: number;
  attachment_count: number;
  attachments: Attachment[];
  poll: Poll | null;
}

export interface Attachment {
  id: number;
  filename: string;
  mime: string;
  size: number;
}

export interface Poll {
  question: string;
  options: { id: number; label: string; votes: number }[];
  my_vote: number | null;
  total: number;
}

export interface Template {
  id: number;
  name: string;
  title: string;
  body: string;
  priority: Announcement['priority'];
  category: string | null;
  ack_required: boolean;
  poll_question: string | null;
  poll_options: string[];
  company_id: number | null;
  created_by_name?: string | null;
}

export interface ActivityEntry {
  id: number;
  user_id: number | null;
  user_name: string;
  avatar_url: string | null;
  action: string;
  label: string;
  target_type: string | null;
  target_id: number | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  user_id: number;
  user_name: string;
  user_role: Role;
  avatar_url: string | null;
  mine: boolean;
}

export interface ReportSummary {
  totals: { announcements: number; avg_read_pct: number; meetings: number; avg_going_pct: number; avg_attended_pct: number | null; employees: number };
  groups: {
    company: string;
    department: string;
    employees: number;
    sent: number;
    read: number;
    read_pct: number | null;
    invited: number;
    going: number;
    going_pct: number | null;
    attended: number;
    attended_pct: number | null;
  }[];
  employees: {
    id: number;
    name: string;
    email: string;
    company: string | null;
    department: string | null;
    sent: number;
    read: number;
    read_pct: number | null;
    ack_required: number;
    acked: number;
    invited: number;
    going: number;
    maybe: number;
    declined: number;
    no_reply: number;
    attendance_pct: number | null;
    attended: number;
    attended_pct: number | null;
  }[];
  announcements: {
    id: number;
    title: string;
    priority: string;
    category: string;
    company: string;
    date: string;
    audience: number;
    read: number;
    read_pct: number;
    ack_required: boolean;
    acked: number;
  }[];
  meetings: {
    id: number;
    title: string;
    company: string;
    date: string;
    past: boolean;
    audience: number;
    going: number;
    maybe: number;
    declined: number;
    noReply: number;
    going_pct: number;
    attended: number;
    attended_pct: number | null;
    has_minutes: boolean;
  }[];
}

export interface MyHistory {
  stats: { invited: number; going: number; maybe: number; declined: number; no_reply: number };
  meetings: {
    id: number;
    title: string;
    starts_at: string;
    ends_at: string;
    location: string;
    status: string;
    my_rsvp: RsvpStatus | null;
    my_note: string | null;
    responded_at: string | null;
  }[];
  reads: { id: number; title: string; priority: string; ack_required: number; read_at: string; acknowledged_at: string | null }[];
}

export interface ImportResult {
  job: string;
  total: number;
  done: number;
  finished: boolean;
  error: string | null;
  created_count: number;
  skipped_count: number;
  /** Present once the import has finished. */
  created?: { line: number; name: string; email: string; password: string; company: string; department: string }[];
  skipped?: { line: number; email: string; reason: string }[];
}
export type UserFilters = { q?: string; company_id?: number | null; role?: Role; limit?: number; offset?: number };

export interface Person {
  id: number;
  name: string;
  email: string;
  department_name: string | null;
  company_name?: string | null;
  read_at?: string | null;
  acknowledged_at?: string | null;
  poll_answer?: string | null;
  status?: RsvpStatus | null;
  note?: string | null;
  responded_at?: string | null;
  attended_at?: string | null;
  attended_method?: 'staff' | 'self' | 'request' | null;
  /** 'pending' = tapped "Check in" and waiting for the organizer; 'approved' = counted as present. */
  checkin_status?: CheckInStatus | null;
  checkin_requested_at?: string | null;
}

export type RsvpStatus = 'going' | 'maybe' | 'declined';

export interface Meeting {
  id: number;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  location: string;
  link: string;
  status: 'scheduled' | 'cancelled';
  /** There is a joining link, even if `link` is empty because the check-in has not been approved yet. */
  has_link: boolean;
  company_id: number | null;
  company_name: string | null;
  organizer_id: number;
  organizer_name: string;
  created_at: string;
  going_count: number;
  maybe_count: number;
  declined_count: number;
  my_rsvp: RsvpStatus | null;
  my_rsvp_note: string | null;
  comment_count: number;
  series_id: string | null;
  recurrence: 'weekly' | 'biweekly' | 'monthly' | null;
  audience_count?: number;
  targets: { id: number; name: string }[];
  attendees?: Person[];
  attendees_total?: number;
  attended_count: number;
  /** How many people have tapped "Check in" and are waiting for the organizer. */
  pending_count: number;
  attended_by_me: boolean;
  /** Where my own check-in stands. */
  my_checkin: CheckInStatus;
  has_minutes: boolean;
  /** The attendance window, decided by the server: the check-in box shows between these two times. */
  checkin_opens_at: string;
  checkin_closes_at: string;
  minutes?: string | null;
  minutes_updated_at?: string | null;
  /** only sent to staff who manage the meeting */
  checkin_code?: string;
  can_manage?: boolean;
}

export interface Notification {
  id: number;
  type: 'announcement' | 'meeting';
  title: string;
  body: string;
  ref_type: 'announcement' | 'meeting' | null;
  ref_id: number | null;
  read_at: string | null;
  created_at: string;
}

export interface Dashboard {
  unreadAnnouncements: number;
  upcomingMeetings: number;
  pendingRsvps: number;
  unreadNotifications: number;
  employees?: number;
  companies?: number;
  drafts?: number;
  /** admin only: announcements that still have employees who haven't read them */
  announcementsAwaitingReads?: number;
  /** The meeting I am expected at whose check-in is open right now (attendees only). */
  openCheckIn?: OpenCheckIn;
  /** staff only: check-ins waiting for me to approve, on meetings I run */
  pendingApprovals?: number;
  pendingApprovalsMeetingId?: number;
}

/** Where a person's check-in stands: not asked, waiting for the organizer, or counted as present. */
export type CheckInStatus = 'none' | 'pending' | 'approved';

/** A meeting that is starting, waiting for me to check in. */
export interface OpenCheckIn {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  location: string;
  checkin_closes_at: string;
  my_checkin: CheckInStatus;
}

export interface Session {
  id: number;
  created_at: string;
  last_used_at: string | null;
  user_agent: string;
  ip: string;
  current: boolean;
  /** The app is open on that device right now (it holds a live connection to the server). */
  active: boolean;
}

/** What the server hands out at sign-in. */
export interface Tokens {
  token: string;
  refresh_token: string;
  expires_in: number;
}

// ---------- storage ----------
const KEY_URL = 'ta.serverUrl';
const KEY_TOKEN = 'ta.token';
const KEY_REFRESH = 'ta.refresh';
const KEY_EXPIRES = 'ta.expires';

function defaultServerUrl(): string {
  // Baked in at build time — VITE_SERVER_URL=https://notice.yourcompany.com npm run build — so a packaged
  // phone or desktop app already knows where to go and nobody has to type an address on first launch.
  const baked = String(import.meta.env.VITE_SERVER_URL || '').replace(/\/+$/, '');
  if (baked) return baked;
  // Served over http(s) (Docker, production, or the Vite dev server): the API is on the same origin —
  // Vite forwards /api to the dev API server. Desktop (file://) and mobile fall back to localhost:4000.
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) return window.location.origin;
  return 'http://localhost:4000';
}

const storage = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export function getServerUrl(): string {
  return storage.get(KEY_URL) || defaultServerUrl();
}

export function setServerUrl(url: string) {
  storage.set(KEY_URL, url.replace(/\/+$/, ''));
}

export function getToken(): string | null {
  return storage.get(KEY_TOKEN);
}

/** Stores a fresh session (or clears it with null). */
export function setSession(t: Tokens | null) {
  if (!t) {
    storage.set(KEY_TOKEN, null);
    storage.set(KEY_REFRESH, null);
    storage.set(KEY_EXPIRES, null);
    return;
  }
  storage.set(KEY_TOKEN, t.token);
  storage.set(KEY_REFRESH, t.refresh_token);
  storage.set(KEY_EXPIRES, String(Date.now() + t.expires_in * 1000));
}

/** Kept for older call sites: clearing the token clears the whole session. */
export function setToken(token: string | null) {
  if (token === null) setSession(null);
  else storage.set(KEY_TOKEN, token);
}

function accessTokenExpiringSoon(): boolean {
  const exp = Number(storage.get(KEY_EXPIRES) || 0);
  return !!exp && Date.now() > exp - 45_000;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- refresh ----------
let refreshing: Promise<boolean> | null = null;

/** Gets a new access token with the refresh token. Resolves false (and signs the app out) when that is no longer possible. */
export function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = storage.get(KEY_REFRESH);
    if (!refresh) return false;
    try {
      const res = await fetch(getServerUrl() + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (res.status === 401 || res.status === 403) {
        signOutLocally();
        return false;
      }
      if (!res.ok) return false; // server hiccup: keep the old tokens and try again later
      const data = (await res.json()) as Tokens;
      setSession(data);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Forgets the session on this device and tells the app to show the sign-in screen. */
export function signOutLocally() {
  setSession(null);
  clearOfflineCache();
  try {
    window.dispatchEvent(new Event('ta-logout'));
  } catch {
    /* not in a browser */
  }
}

/** Removes the offline copies of API answers (kept by the PWA service worker) so nothing is left behind after sign-out. */
export async function clearOfflineCache() {
  try {
    if (typeof caches === 'undefined') return;
    for (const key of await caches.keys()) if (key.startsWith('upnotice-')) await caches.delete(key);
  } catch {
    /* ignore */
  }
}

/** A valid access token, refreshing first when the current one is about to expire. */
async function ensureToken(): Promise<string | null> {
  const token = getToken();
  if (token && accessTokenExpiringSoon() && storage.get(KEY_REFRESH)) await refreshTokens();
  return getToken();
}

async function send(method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit }, retry = true): Promise<Response> {
  const token = await ensureToken();
  let res: Response;
  try {
    res = await fetch(getServerUrl() + path, { method, headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: init.body });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the server address and your connection.');
  }
  // An access token that just expired (or was revoked elsewhere): try once with a refreshed one.
  if (res.status === 401 && token && retry && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/refresh')) {
    if (await refreshTokens()) return send(method, path, init, false);
    signOutLocally();
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, { headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code);
  return data as T;
}

/** Multipart request (for file uploads). Fields that are not strings are JSON-encoded. */
async function requestForm<T>(method: string, path: string, fields: Record<string, unknown>, files: { field: string; file: File }[] = []): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  for (const f of files) fd.append(f.field, f.file, f.file.name);
  const res = await send(method, path, { body: fd });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code);
  return data as T;
}

// ---------- protected files ----------
const blobCache = new Map<string, Promise<string>>();

/** Fetches a protected image/file with the auth header and returns an object URL that <img> can show. Cached per path. */
export function fetchBlobUrl(path: string): Promise<string> {
  let p = blobCache.get(path);
  if (!p) {
    p = (async () => {
      const res = await send('GET', path, {});
      if (!res.ok) throw new ApiError(res.status, 'Could not load file');
      return URL.createObjectURL(await res.blob());
    })();
    p.catch(() => blobCache.delete(path));
    blobCache.set(path, p);
  }
  return p;
}
/** Forgets a cached image (after the user changes their photo). */
export function forgetBlobUrl(path: string) {
  blobCache.delete(path);
}

/** A short-lived URL for one protected file, for opening in a new tab or downloading. Expires in 2 minutes. */
export async function fileLink(path: string): Promise<string> {
  const r = await request<{ url: string }>('POST', '/api/auth/ticket', { path });
  return getServerUrl() + r.url;
}

/**
 * Opens a protected file in a new tab (browser) or the system viewer (mobile). Opens the tab synchronously so
 * popup blockers accept it, then points it at the ticket URL.
 */
export async function openProtectedFile(path: string): Promise<void> {
  const native = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const win = native ? null : window.open('', '_blank');
  try {
    const url = await fileLink(path);
    if (native) window.open(url, '_system');
    else if (win) win.location.href = url;
    else window.location.href = url;
  } catch (err) {
    win?.close();
    throw err;
  }
}

export type AnnouncementInput = {
  title: string;
  body: string;
  priority: Announcement['priority'];
  pinned: boolean;
  company_id: number | null;
  department_ids: number[];
  publish_at: string | null;
  expires_at: string | null;
  ack_required: boolean;
  poll_question: string;
  poll_options: string[];
  category?: string | null;
  draft?: boolean;
  remove_attachment_ids?: number[];
};

export type AnnouncementFilters = {
  q?: string;
  category?: string;
  company_id?: number | null;
  department_id?: number | null;
  from?: string;
  to?: string;
  status?: string;
  unread?: boolean;
  limit?: number;
  offset?: number;
};
export type MeetingFilters = { q?: string; company_id?: number | null; department_id?: number | null; from?: string; to?: string };

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const api = {
  health: () => request<{ ok: boolean; name?: string; version?: string; database?: string }>('GET', '/api/health'),
  forgotPassword: (email: string) => request<{ ok: true; message: string }>('POST', '/api/auth/forgot', { email }),
  resetPassword: (token: string, password: string) => request<{ ok: true; user: User } & Tokens>('POST', '/api/auth/reset', { token, password }),
  updateMe: (data: { email_notifications?: boolean }) => request<{ user: User }>('PATCH', '/api/auth/me', data),
  login: (email: string, password: string) => request<{ user: User } & Tokens>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  logoutAll: () => request<{ ok: true }>('POST', '/api/auth/logout-all'),
  sessions: () => request<{ sessions: Session[] }>('GET', '/api/auth/sessions'),
  me: () => request<{ user: User; push?: string; mail?: string }>('GET', '/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) => request<{ ok: true; user: User }>('POST', '/api/auth/change-password', { currentPassword, newPassword }),

  dashboard: () => request<Dashboard>('GET', '/api/dashboard'),

  companies: () => request<{ companies: Company[] }>('GET', '/api/companies'),
  createCompany: (name: string) => request<{ company: Company }>('POST', '/api/companies', { name }),
  renameCompany: (id: number, name: string) => request<{ ok: true }>('PATCH', `/api/companies/${id}`, { name }),
  deleteCompany: (id: number) => request<{ ok: true }>('DELETE', `/api/companies/${id}`),

  departments: () => request<{ departments: Department[] }>('GET', '/api/departments'),
  createDepartment: (name: string, company_id: number) => request<{ department: Department }>('POST', '/api/departments', { name, company_id }),
  renameDepartment: (id: number, name: string) => request<{ ok: true }>('PATCH', `/api/departments/${id}`, { name }),
  deleteDepartment: (id: number) => request<{ ok: true }>('DELETE', `/api/departments/${id}`),

  users: (filters: UserFilters = {}) => request<{ users: User[]; total?: number }>('GET', `/api/users${qs(filters)}`),
  createUser: (data: { name: string; email: string; password: string; role: Role; company_id: number | null; department_id: number | null }) =>
    request<{ user: User }>('POST', '/api/users', data),
  updateUser: (
    id: number,
    data: Partial<{ name: string; email: string; role: Role; company_id: number | null; department_id: number | null; active: boolean; password: string }>
  ) => request<{ user: User }>('PATCH', `/api/users/${id}`, data),
  deleteUser: (id: number) => request<{ ok: true }>('DELETE', `/api/users/${id}`),

  announcements: (filters: AnnouncementFilters = {}) => request<{ announcements: Announcement[]; total?: number; has_more?: boolean }>('GET', `/api/announcements${qs(filters)}`),
  categories: () => request<{ categories: string[] }>('GET', '/api/announcements/categories'),
  templates: () => request<{ templates: Template[] }>('GET', '/api/templates'),
  createTemplate: (data: Omit<Template, 'id' | 'created_by_name'>) => request<{ template: Template }>('POST', '/api/templates', data),
  deleteTemplate: (id: number) => request<{ ok: true }>('DELETE', `/api/templates/${id}`),
  activity: (filters: { limit?: number; before?: number; action?: string; user_id?: number; q?: string; from?: string; to?: string } = {}) =>
    request<{ activity: ActivityEntry[]; more: boolean; actions: Record<string, string> }>('GET', `/api/activity${qs(filters)}`),
  deleteActivity: (id: number) => request<{ ok: true; deleted: number }>('DELETE', `/api/activity/${id}`),
  deleteActivityEntries: (ids: number[]) => request<{ ok: true; deleted: number }>('POST', '/api/activity/delete', { ids }),
  announcement: (id: number) => request<{ announcement: Announcement }>('GET', `/api/announcements/${id}`),
  createAnnouncement: (data: AnnouncementInput, files: File[] = []) =>
    requestForm<{ announcement: Announcement }>(
      'POST',
      '/api/announcements',
      {
        ...data,
        pinned: String(data.pinned),
        ack_required: String(data.ack_required),
        publish_at: data.publish_at || '',
        expires_at: data.expires_at || '',
        draft: String(!!data.draft),
        category: data.category || '',
      },
      files.map((file) => ({ field: 'files', file }))
    ),
  updateAnnouncement: (id: number, data: Partial<AnnouncementInput>, files: File[] = []) =>
    requestForm<{ ok: true }>(
      'PATCH',
      `/api/announcements/${id}`,
      {
        ...data,
        ...(data.pinned !== undefined ? { pinned: String(data.pinned) } : {}),
        ...(data.ack_required !== undefined ? { ack_required: String(data.ack_required) } : {}),
        ...(data.publish_at !== undefined ? { publish_at: data.publish_at || '' } : {}),
        ...(data.expires_at !== undefined ? { expires_at: data.expires_at || '' } : {}),
        ...(data.draft !== undefined ? { draft: String(data.draft) } : {}),
        ...(data.category !== undefined ? { category: data.category || '' } : {}),
      },
      files.map((file) => ({ field: 'files', file }))
    ),
  acknowledge: (id: number) => request<{ ok: true }>('POST', `/api/announcements/${id}/acknowledge`),
  vote: (id: number, option_id: number) => request<{ ok: true; poll: Poll }>('POST', `/api/announcements/${id}/vote`, { option_id }),
  /** API path of an attachment (use with fetchBlobUrl for previews or openProtectedFile for downloads). */
  attachmentPath: (announcementId: number, fileId: number, download = false) => `/api/announcements/${announcementId}/files/${fileId}${download ? '?download=1' : ''}`,

  comments: (refType: 'announcement' | 'meeting', refId: number) => request<{ comments: Comment[] }>('GET', `/api/comments/${refType}/${refId}`),
  addComment: (refType: 'announcement' | 'meeting', refId: number, body: string) => request<{ id: number }>('POST', `/api/comments/${refType}/${refId}`, { body }),
  deleteComment: (id: number) => request<{ ok: true }>('DELETE', `/api/comments/${id}`),

  reportSummary: (from?: string, to?: string) => request<ReportSummary>('GET', `/api/reports/summary${qs({ from, to })}`),
  reportCsvPath: (kind: 'employees' | 'announcements' | 'meetings' | 'departments', from?: string, to?: string) => `/api/reports/export/${kind}.csv${qs({ from, to })}`,

  myHistory: () => request<MyHistory>('GET', '/api/auth/my-history'),
  uploadAvatar: (file: File) => requestForm<{ user: User }>('POST', '/api/auth/avatar', {}, [{ field: 'photo', file }]),
  removeAvatar: () => request<{ user: User }>('DELETE', '/api/auth/avatar'),
  avatarPath: (userId: number) => `/api/auth/avatar/${userId}`,

  importUsers: (file: File, createMissing: boolean) => requestForm<ImportResult>('POST', '/api/users/import', { create_missing: String(createMissing) }, [{ field: 'file', file }]),
  importStatus: (job: string) => request<ImportResult>('GET', `/api/users/import/${job}`),
  importTemplatePath: () => '/api/users/import-template',

  registerDevice: (token: string, platform: string) => request<{ ok: true; push: string }>('POST', '/api/devices/register', { token, platform }),
  deleteAnnouncement: (id: number) => request<{ ok: true }>('DELETE', `/api/announcements/${id}`),
  markRead: (id: number) => request<{ ok: true }>('POST', `/api/announcements/${id}/read`),

  meetings: (scope: 'upcoming' | 'past' | 'all' = 'upcoming', filters: MeetingFilters = {}) => request<{ meetings: Meeting[] }>('GET', `/api/meetings${qs({ scope, ...filters })}`),
  setAttendance: (id: number, user_id: number, present: boolean) => request<{ ok: true; attended: boolean }>('POST', `/api/meetings/${id}/attendance`, { user_id, present }),
  checkIn: (id: number, code: string) => request<{ ok: true; status: CheckInStatus }>('POST', `/api/meetings/${id}/checkin`, { code }),
  /** One button, no code: asks the organizer to mark you present. */
  requestCheckIn: (id: number) => request<{ ok: true; status: CheckInStatus }>('POST', `/api/meetings/${id}/checkin-request`),
  /** Organizer: approve or turn down the people waiting. */
  decideCheckIns: (id: number, user_ids: number[], approve: boolean) =>
    request<{ ok: true; decided: number }>('POST', `/api/meetings/${id}/attendance/decide`, { user_ids, approve }),
  saveMinutes: (id: number, minutes: string) => request<{ ok: true }>('PATCH', `/api/meetings/${id}/minutes`, { minutes }),
  meeting: (id: number) => request<{ meeting: Meeting }>('GET', `/api/meetings/${id}`),
  createMeeting: (data: {
    title: string;
    description: string;
    starts_at: string;
    ends_at: string;
    location: string;
    link: string;
    company_id: number | null;
    department_ids: number[];
    recurrence?: Meeting['recurrence'];
    occurrences?: number;
  }) => request<{ meeting: Meeting; created: number }>('POST', '/api/meetings', data),
  updateMeeting: (
    id: number,
    data: Partial<{
      title: string;
      description: string;
      starts_at: string;
      ends_at: string;
      location: string;
      link: string;
      status: Meeting['status'];
      company_id: number | null;
      department_ids: number[];
    }>
  ) => request<{ ok: true }>('PATCH', `/api/meetings/${id}`, data),
  deleteMeeting: (id: number, series: 'one' | 'future' | 'all' = 'one') => request<{ ok: true }>('DELETE', `/api/meetings/${id}${series !== 'one' ? `?series=${series}` : ''}`),
  rsvp: (id: number, status: RsvpStatus, note = '') => request<{ ok: true; status: RsvpStatus; note: string }>('POST', `/api/meetings/${id}/rsvp`, { status, note }),

  notifications: () => request<{ notifications: Notification[]; unread: number }>('GET', '/api/notifications'),
  markAllNotificationsRead: () => request<{ ok: true }>('POST', '/api/notifications/read-all'),
  markNotificationRead: (id: number) => request<{ ok: true }>('POST', `/api/notifications/${id}/read`),
  deleteNotification: (id: number) => request<{ ok: true; deleted: number }>('DELETE', `/api/notifications/${id}`),
  deleteNotifications: (body: { ids?: number[]; all?: boolean; read?: boolean }) => request<{ ok: true; deleted: number }>('POST', '/api/notifications/delete', body),
};

// ---------- live updates ----------
/**
 * Opens the live-update stream (Server-Sent Events over fetch, so the token travels in a header, never in the URL).
 * Reconnects by itself with a growing delay. Returns a function that closes it.
 */
export function openLiveStream(onEvent: (event: string, data: unknown) => void): () => void {
  if (!getToken() || typeof fetch === 'undefined') return () => {};
  let stopped = false;
  let controller: AbortController | null = null;
  let delay = 1000;

  const dispatch = (chunk: string) => {
    let event = 'message';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event === 'hello' || event === 'message') return;
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(data || '{}');
    } catch {
      /* ignore */
    }
    onEvent(event, parsed);
  };

  const retry = (ms = delay) => {
    if (stopped) return;
    window.setTimeout(connect, ms);
    delay = Math.min(delay * 2, 30_000);
  };

  const connect = async () => {
    if (stopped) return;
    const token = await ensureToken();
    if (!token) return; // signed out meanwhile
    controller = new AbortController();
    try {
      const res = await fetch(`${getServerUrl()}/api/notifications/stream`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (res.status === 401) {
        if (await refreshTokens()) retry(200);
        return;
      }
      if (!res.ok || !res.body) return retry();
      delay = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (chunk.trim() && !chunk.startsWith(':')) dispatch(chunk);
        }
      }
      retry(); // server closed the connection (restart, proxy timeout)
    } catch {
      if (!stopped) retry();
    }
  };

  connect();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

// ---------- formatting helpers ----------
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** SQLite's datetime('now') has no timezone marker; treat it as UTC. */
export function sqlToIso(s: string): string {
  return /Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
}

export function timeAgo(sql: string): string {
  const diff = Date.now() - new Date(sqlToIso(sql)).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(sqlToIso(sql)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Converts an ISO string to the value format used by <input type="datetime-local">. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Link that opens Google Calendar with the meeting pre-filled. */
export function googleCalendarUrl(m: { title: string; description: string; location: string; link: string; starts_at: string; ends_at: string }): string {
  const fmt = (iso: string) =>
    new Date(iso)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const details = [m.description, m.link].filter(Boolean).join('\n\n');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: m.title, dates: `${fmt(m.starts_at)}/${fmt(m.ends_at)}`, details, location: m.location || '' });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The oldest server version this app can work with. Older servers lack routes/fields the app expects. */
export const REQUIRED_SERVER_VERSION = '4.0.0';
export function serverIsOutdated(version?: string): boolean {
  if (!version) return true;
  const a = version.split('.').map(Number),
    b = REQUIRED_SERVER_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return false;
    if ((a[i] || 0) < (b[i] || 0)) return true;
  }
  return false;
}

/** Password rules shown in forms (the server enforces the same). */
export const MIN_PASSWORD_LENGTH = 8;
