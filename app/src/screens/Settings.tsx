import { useState, type FormEvent } from 'react';
import { api, formatDateTime, getServerUrl, timeAgo, type User } from '../api';
import { useLoader, useStore } from '../store';
import { Spinner } from '../components/ui';
import { Avatar } from '../components/social';
import { ThemePicker } from '../components/theme-toggle';
import { ActivityIcon, CalendarIcon, LogoutIcon, MailIcon, TrashIcon } from '../icons';
import { isNative, requestNotificationPermission, enablePush, getPushStatus } from '../notify';

export function SettingsScreen() {
  const { user, setUser, logout, toast, go } = useStore();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const isAdmin = user?.role === 'admin';
  const [emailBusy, setEmailBusy] = useState(false);
  const { data: meInfo } = useLoader(() => api.me());
  const mailEnabled = !!meInfo?.mail && meInfo.mail.startsWith('enabled');
  const toggleEmail = async (on: boolean) => {
    setEmailBusy(true);
    try {
      const r = await api.updateMe({ email_notifications: on });
      setUser(r.user);
      toast(on ? 'Email notifications on' : 'Email notifications off');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setEmailBusy(false);
    }
  };

  const change = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(cur, next);
      toast('Password changed');
      setCur('');
      setNext('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const r = await api.uploadAvatar(file);
      setUser({ ...r.user, avatar_url: r.user.avatar_url ? `${r.user.avatar_url}?v=${Date.now()}` : null } as User);
      toast('Profile photo updated');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Avatar userId={user!.id} name={user?.name || ''} avatarUrl={user?.avatar_url} size={64} />
          <div style={{ flex: 1 }}>
            <div className="title">{user?.name}</div>
            <div className="small muted">{user?.email}</div>
            <div className="tiny muted">{isAdmin ? 'Administrator' : `${user?.role === 'manager' ? 'Manager · ' : ''}${[user?.company_name, user?.department_name].filter(Boolean).join(' · ') || 'Employee'}`}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="btn sm" style={{ cursor: 'pointer' }}>
                {photoBusy ? 'Uploading…' : user?.avatar_url ? 'Change photo' : 'Add profile photo'}
                <input type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} disabled={photoBusy} />
              </label>
              {user?.avatar_url && (
                <button className="btn ghost sm" onClick={async () => { const r = await api.removeAvatar(); setUser(r.user); }}><TrashIcon /> Remove</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {user?.role === 'employee' && <MyHistoryCard />}

      <ThemePicker />

      <div className="card">
        <div className="title" style={{ marginBottom: 12 }}>Change password</div>
        <form className="stack" onSubmit={change}>
          {error && <div className="error">{error}</div>}
          <div className="field">
            <label>Current password</label>
            <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
          </div>
          <div className="field">
            <label>New password</label>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={6} autoComplete="new-password" />
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>
        </form>
      </div>

      <div className="card">
        <div className="title" style={{ marginBottom: 6 }}>Notifications</div>
        <p className="small muted" style={{ marginBottom: 12 }}>
          {isNative()
            ? 'Allow notifications so you get alerted about new announcements and meetings — including when the app is closed.'
            : 'Allow desktop notifications to be alerted even when this window is in the background.'}
        </p>
        <div className="row wrap">
          <button className="btn sm" onClick={async () => { await requestNotificationPermission(); await enablePush(); toast('Notifications enabled'); }}>Enable notifications</button>
          <span className="tiny muted">{getPushStatus()}</span>
        </div>
      </div>

      <div className="card">
        <div className="row between wrap">
          <div>
            <div className="title" style={{ marginBottom: 4 }}><MailIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Email notifications</div>
            <p className="small muted">{mailEnabled ? `Also send announcements, invites, reminders and minutes to ${user?.email}.` : 'Email is not set up on this server yet (see README → Email notifications). Your choice is saved for when it is.'}</p>
          </div>
          <label className="check" style={{ padding: 0 }}>
            <input type="checkbox" checked={(user?.email_notifications ?? 1) === 1} onChange={(e) => toggleEmail(e.target.checked)} disabled={emailBusy} /> On
          </label>
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <div className="row between wrap">
            <div>
              <div className="title" style={{ marginBottom: 4 }}><ActivityIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Activity log</div>
              <p className="small muted">Who posted, edited, deleted or signed in — and when.</p>
            </div>
            <button className="btn sm" onClick={() => go('activity')}>Open</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="title" style={{ marginBottom: 6 }}>Server</div>
        <p className="small muted">Connected to <code>{getServerUrl()}</code>. Sign out to change the server address.</p>
      </div>

      <button className="btn danger block" onClick={logout} style={{ marginTop: 12 }}>
        <LogoutIcon /> Sign out
      </button>
    </>
  );
}

function MyHistoryCard() {
  const { go } = useStore();
  const { data, loading } = useLoader(() => api.myHistory());
  const [show, setShow] = useState(false);
  if (loading) return <div className="card"><Spinner /></div>;
  if (!data) return null;
  const s = data.stats;
  const pct = s.invited ? Math.round((s.going / s.invited) * 100) : null;
  const label = (r: string | null) => (r === 'going' ? 'Going' : r === 'maybe' ? 'Maybe' : r === 'declined' ? "Couldn't go" : 'No reply');
  const cls = (r: string | null) => (r === 'going' ? 'ok' : r === 'maybe' ? 'warn' : r === 'declined' ? 'danger' : '');
  return (
    <div className="card">
      <div className="row between">
        <div className="title">My attendance</div>
        {pct !== null && <span className={`chip ${pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'danger'}`}>{pct}% attendance</span>}
      </div>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        {s.invited} past meeting{s.invited === 1 ? '' : 's'}: {s.going} going · {s.maybe} maybe · {s.declined} declined · {s.no_reply} no reply
      </p>
      <button className="btn sm" onClick={() => setShow((v) => !v)}><CalendarIcon /> {show ? 'Hide history' : 'Show history'}</button>
      {show && (
        <div className="list" style={{ marginTop: 10 }}>
          {data.meetings.length === 0 && <p className="small muted">No meetings yet.</p>}
          {data.meetings.map((m) => (
            <div className="list-item" key={m.id} style={{ cursor: 'pointer' }} onClick={() => go('meetings', { type: 'meeting', id: m.id })}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, textDecoration: m.status === 'cancelled' ? 'line-through' : undefined }}>{m.title}</div>
                <div className="tiny muted">{formatDateTime(m.starts_at)}{m.location ? ` · ${m.location}` : ''}{m.my_note ? ` · “${m.my_note}”` : ''}</div>
              </div>
              <span className={`chip ${cls(m.my_rsvp)}`}>{m.status === 'cancelled' ? 'Cancelled' : label(m.my_rsvp)}</span>
            </div>
          ))}
          {data.reads.length > 0 && (
            <>
              <div className="section-title">Announcements I've read</div>
              {data.reads.slice(0, 20).map((r) => (
                <div className="list-item" key={r.id} style={{ cursor: 'pointer' }} onClick={() => go('announcements', { type: 'announcement', id: r.id })}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    <div className="tiny muted">read {timeAgo(r.read_at)}{r.ack_required ? (r.acknowledged_at ? ' · acknowledged' : ' · acknowledgement pending') : ''}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
