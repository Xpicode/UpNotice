// Small API client. Stores the server URL + token so the same code works in the
// browser, in the Electron desktop app and in the Capacitor mobile app.

export type Role = 'admin' | 'employee';

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
  // v3
  publish_at: string | null;
  expires_at: string | null;
  status: 'live' | 'scheduled' | 'expired';
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
  totals: { announcements: number; avg_read_pct: number; meetings: number; avg_going_pct: number; employees: number };
  groups: { company: string; department: string; employees: number; sent: number; read: number; read_pct: number | null; invited: number; going: number; going_pct: number | null }[];
  employees: { id: number; name: string; email: string; company: string | null; department: string | null; sent: number; read: number; read_pct: number | null; ack_required: number; acked: number; invited: number; going: number; maybe: number; declined: number; no_reply: number; attendance_pct: number | null }[];
  announcements: { id: number; title: string; priority: string; company: string; date: string; audience: number; read: number; read_pct: number; ack_required: boolean; acked: number }[];
  meetings: { id: number; title: string; company: string; date: string; past: boolean; audience: number; going: number; maybe: number; declined: number; noReply: number; going_pct: number }[];
}

export interface MyHistory {
  stats: { invited: number; going: number; maybe: number; declined: number; no_reply: number };
  meetings: { id: number; title: string; starts_at: string; ends_at: string; location: string; status: string; my_rsvp: RsvpStatus | null; my_note: string | null; responded_at: string | null }[];
  reads: { id: number; title: string; priority: string; ack_required: number; read_at: string; acknowledged_at: string | null }[];
}

export interface ImportResult {
  created: { line: number; name: string; email: string; password: string; company: string; department: string }[];
  skipped: { line: number; email: string; reason: string }[];
}

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
  /** admin only: announcements that still have employees who haven't read them */
  announcementsAwaitingReads?: number;
}

const KEY_URL = 'ta.serverUrl';
const KEY_TOKEN = 'ta.token';

function defaultServerUrl(): string {
  // Served over http(s) (Docker, production, or the Vite dev server): the API is on the same origin —
  // Vite forwards /api to the dev API server. Desktop (file://) and mobile default to localhost:4000.
  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) return window.location.origin;
  return 'http://localhost:4000';
}

export function getServerUrl(): string {
  try {
    return localStorage.getItem(KEY_URL) || defaultServerUrl();
  } catch {
    return defaultServerUrl();
  }
}

export function setServerUrl(url: string) {
  try {
    localStorage.setItem(KEY_URL, url.replace(/\/+$/, ''));
  } catch {
    /* ignore */
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY_TOKEN);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY_TOKEN, token);
    else localStorage.removeItem(KEY_TOKEN);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(getServerUrl() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the server address and your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

/** Multipart request (for file uploads). Fields that are not strings are JSON-encoded. */
async function requestForm<T>(method: string, path: string, fields: Record<string, unknown>, files: { field: string; file: File }[] = []): Promise<T> {
  const token = getToken();
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  for (const f of files) fd.append(f.field, f.file, f.file.name);
  let res: Response;
  try {
    res = await fetch(getServerUrl() + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the server address and your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

/** URL for a protected file (attachment / avatar / CSV) that can be opened in a new tab or <img>. */
export function fileUrl(path: string, download = false): string {
  const token = getToken() || '';
  return `${getServerUrl()}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}${download ? '&download=1' : ''}`;
}

export type AnnouncementInput = {
  title: string; body: string; priority: Announcement['priority']; pinned: boolean;
  company_id: number | null; department_ids: number[];
  publish_at: string | null; expires_at: string | null; ack_required: boolean;
  poll_question: string; poll_options: string[];
  remove_attachment_ids?: number[];
};

export const api = {
  health: () => request<{ ok: boolean; name?: string; version?: string }>('GET', '/api/health'),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/login', { email, password }),
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/change-password', { currentPassword, newPassword }),

  dashboard: () => request<Dashboard>('GET', '/api/dashboard'),

  companies: () => request<{ companies: Company[] }>('GET', '/api/companies'),
  createCompany: (name: string) => request<{ company: Company }>('POST', '/api/companies', { name }),
  renameCompany: (id: number, name: string) => request<{ ok: true }>('PATCH', `/api/companies/${id}`, { name }),
  deleteCompany: (id: number) => request<{ ok: true }>('DELETE', `/api/companies/${id}`),

  departments: () => request<{ departments: Department[] }>('GET', '/api/departments'),
  createDepartment: (name: string, company_id: number) => request<{ department: Department }>('POST', '/api/departments', { name, company_id }),
  renameDepartment: (id: number, name: string) => request<{ ok: true }>('PATCH', `/api/departments/${id}`, { name }),
  deleteDepartment: (id: number) => request<{ ok: true }>('DELETE', `/api/departments/${id}`),

  users: () => request<{ users: User[] }>('GET', '/api/users'),
  createUser: (data: { name: string; email: string; password: string; role: Role; company_id: number | null; department_id: number | null }) =>
    request<{ user: User }>('POST', '/api/users', data),
  updateUser: (id: number, data: Partial<{ name: string; email: string; role: Role; company_id: number | null; department_id: number | null; active: boolean; password: string }>) =>
    request<{ user: User }>('PATCH', `/api/users/${id}`, data),
  deleteUser: (id: number) => request<{ ok: true }>('DELETE', `/api/users/${id}`),

  announcements: () => request<{ announcements: Announcement[] }>('GET', '/api/announcements'),
  announcement: (id: number) => request<{ announcement: Announcement }>('GET', `/api/announcements/${id}`),
  createAnnouncement: (data: AnnouncementInput, files: File[] = []) =>
    requestForm<{ announcement: Announcement }>('POST', '/api/announcements', { ...data, pinned: String(data.pinned), ack_required: String(data.ack_required), publish_at: data.publish_at || '', expires_at: data.expires_at || '' }, files.map((file) => ({ field: 'files', file }))),
  updateAnnouncement: (id: number, data: Partial<AnnouncementInput>, files: File[] = []) =>
    requestForm<{ ok: true }>('PATCH', `/api/announcements/${id}`, { ...data, ...(data.pinned !== undefined ? { pinned: String(data.pinned) } : {}), ...(data.ack_required !== undefined ? { ack_required: String(data.ack_required) } : {}), ...(data.publish_at !== undefined ? { publish_at: data.publish_at || '' } : {}), ...(data.expires_at !== undefined ? { expires_at: data.expires_at || '' } : {}) }, files.map((file) => ({ field: 'files', file }))),
  acknowledge: (id: number) => request<{ ok: true }>('POST', `/api/announcements/${id}/acknowledge`),
  vote: (id: number, option_id: number) => request<{ ok: true; poll: Poll }>('POST', `/api/announcements/${id}/vote`, { option_id }),
  attachmentUrl: (announcementId: number, fileId: number, download = false) => fileUrl(`/api/announcements/${announcementId}/files/${fileId}`, download),

  comments: (refType: 'announcement' | 'meeting', refId: number) => request<{ comments: Comment[] }>('GET', `/api/comments/${refType}/${refId}`),
  addComment: (refType: 'announcement' | 'meeting', refId: number, body: string) => request<{ id: number }>('POST', `/api/comments/${refType}/${refId}`, { body }),
  deleteComment: (id: number) => request<{ ok: true }>('DELETE', `/api/comments/${id}`),

  reportSummary: (from?: string, to?: string) => request<ReportSummary>('GET', `/api/reports/summary?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`),
  reportCsvUrl: (kind: 'employees' | 'announcements' | 'meetings' | 'departments', from?: string, to?: string) => fileUrl(`/api/reports/export/${kind}.csv?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`),

  myHistory: () => request<MyHistory>('GET', '/api/auth/my-history'),
  uploadAvatar: (file: File) => requestForm<{ user: User }>('POST', '/api/auth/avatar', {}, [{ field: 'photo', file }]),
  removeAvatar: () => request<{ user: User }>('DELETE', '/api/auth/avatar'),
  avatarUrl: (userId: number) => fileUrl(`/api/auth/avatar/${userId}`),

  importUsers: (file: File, createMissing: boolean) => requestForm<ImportResult>('POST', '/api/users/import', { create_missing: String(createMissing) }, [{ field: 'file', file }]),
  importTemplateUrl: () => fileUrl('/api/users/import-template'),

  registerDevice: (token: string, platform: string) => request<{ ok: true; push: string }>('POST', '/api/devices/register', { token, platform }),
  deleteAnnouncement: (id: number) => request<{ ok: true }>('DELETE', `/api/announcements/${id}`),
  markRead: (id: number) => request<{ ok: true }>('POST', `/api/announcements/${id}/read`),

  meetings: (scope: 'upcoming' | 'past' | 'all' = 'upcoming') => request<{ meetings: Meeting[] }>('GET', `/api/meetings?scope=${scope}`),
  meeting: (id: number) => request<{ meeting: Meeting }>('GET', `/api/meetings/${id}`),
  createMeeting: (data: { title: string; description: string; starts_at: string; ends_at: string; location: string; link: string; company_id: number | null; department_ids: number[]; recurrence?: Meeting['recurrence']; occurrences?: number }) =>
    request<{ meeting: Meeting; created: number }>('POST', '/api/meetings', data),
  updateMeeting: (id: number, data: Partial<{ title: string; description: string; starts_at: string; ends_at: string; location: string; link: string; status: Meeting['status']; company_id: number | null; department_ids: number[] }>) =>
    request<{ ok: true }>('PATCH', `/api/meetings/${id}`, data),
  deleteMeeting: (id: number, series: 'one' | 'future' | 'all' = 'one') => request<{ ok: true }>('DELETE', `/api/meetings/${id}${series !== 'one' ? `?series=${series}` : ''}`),
  rsvp: (id: number, status: RsvpStatus, note = '') => request<{ ok: true; status: RsvpStatus; note: string }>('POST', `/api/meetings/${id}/rsvp`, { status, note }),

  notifications: () => request<{ notifications: Notification[]; unread: number }>('GET', '/api/notifications'),
  markAllNotificationsRead: () => request<{ ok: true }>('POST', '/api/notifications/read-all'),
  markNotificationRead: (id: number) => request<{ ok: true }>('POST', `/api/notifications/${id}/read`),
};

/** Opens the live-update stream. Returns a function that closes it. */
export function openLiveStream(onEvent: (event: string, data: unknown) => void): () => void {
  const token = getToken();
  if (!token || typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(`${getServerUrl()}/api/notifications/stream?token=${encodeURIComponent(token)}`);
  const handler = (name: string) => (e: MessageEvent) => {
    let data: unknown = {};
    try {
      data = JSON.parse(e.data);
    } catch {
      /* ignore */
    }
    onEvent(name, data);
  };
  for (const name of ['notification', 'announcements', 'meetings', 'comments']) es.addEventListener(name, handler(name));
  return () => es.close();
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The oldest server version this app can work with. Older servers lack routes/fields the app expects. */
export const REQUIRED_SERVER_VERSION = '3.2.0';
export function serverIsOutdated(version?: string): boolean {
  if (!version) return true;
  const a = version.split('.').map(Number), b = REQUIRED_SERVER_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return false; if ((a[i] || 0) < (b[i] || 0)) return true; }
  return false;
}
