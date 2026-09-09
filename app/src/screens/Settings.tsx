import { useEffect, useState, type FormEvent } from 'react';
import { api, forgetBlobUrl, formatDateTime, getServerUrl, timeAgo, MIN_PASSWORD_LENGTH, type Session, type User } from '../api';
import { useLoader, useStore } from '../store';
import { Confirm, Skeleton } from '../components/ui';
import { Avatar } from '../components/social';
import { ThemePicker } from '../components/theme-toggle';
import { ActivityIcon, CalendarIcon, CopyIcon, LockIcon, LogoutIcon, MailIcon, TrashIcon } from '../icons';
import { QrCode } from '../components/calendar';
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
  const [confirmAll, setConfirmAll] = useState(false);
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
      toast('Password changed — other devices were signed out');
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
      forgetBlobUrl(api.avatarPath(r.user.id));
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
            <div className="tiny muted">
              {isAdmin
                ? 'Administrator'
                : `${user?.role === 'manager' ? 'Manager · ' : ''}${[user?.company_name, user?.department_name].filter(Boolean).join(' · ') || 'Employee'}`}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="btn sm" style={{ cursor: 'pointer' }}>
                {photoBusy ? 'Uploading…' : user?.avatar_url ? 'Change photo' : 'Add profile photo'}
                <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} disabled={photoBusy} />
              </label>
              {user?.avatar_url && (
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    const r = await api.removeAvatar();
                    forgetBlobUrl(api.avatarPath(r.user.id));
                    setUser(r.user);
                  }}
                >
                  <TrashIcon /> Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {user?.role === 'employee' && <MyHistoryCard />}

      <ThemePicker />

      <div className="card">
        <div className="title" style={{ marginBottom: 4 }}>
          <LockIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Change password
        </div>
        <p className="small muted" style={{ marginBottom: 12 }}>
          At least {MIN_PASSWORD_LENGTH} characters. Changing it signs you out everywhere else.
        </p>
        <form className="stack" onSubmit={change}>
          {error && <div className="error">{error}</div>}
          <div className="field">
            <label>Current password</label>
            <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
          </div>
          <div className="field">
            <label>New password</label>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>

      <TwoFactorCard />
      <SessionsCard onSignOutAll={() => setConfirmAll(true)} />

      <div className="card">
        <div className="title" style={{ marginBottom: 6 }}>
          Notifications
        </div>
        <p className="small muted" style={{ marginBottom: 12 }}>
          {isNative()
            ? 'Allow notifications so you get alerted about new announcements and meetings — including when the app is closed.'
            : 'Allow desktop notifications to be alerted even when this window is in the background.'}
        </p>
        <div className="row wrap">
          <button
            className="btn sm"
            onClick={async () => {
              await requestNotificationPermission();
              await enablePush();
              toast('Notifications enabled');
            }}
          >
            Enable notifications
          </button>
          <span className="tiny muted">{getPushStatus()}</span>
        </div>
      </div>

      <div className="card">
        <div className="row between wrap">
          <div>
            <div className="title" style={{ marginBottom: 4 }}>
              <MailIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Email notifications
            </div>
            <p className="small muted">
              {mailEnabled
                ? `Also send announcements, invites, reminders and minutes to ${user?.email}.`
                : 'Email is not set up on this server yet (see README → Email notifications). Your choice is saved for when it is.'}
            </p>
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
              <div className="title" style={{ marginBottom: 4 }}>
                <ActivityIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Activity log
              </div>
              <p className="small muted">Who posted, edited, deleted or signed in — and when.</p>
            </div>
            <button className="btn sm" onClick={() => go('activity')}>
              Open
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="title" style={{ marginBottom: 6 }}>
          Server
        </div>
        <p className="small muted">
          Connected to <code>{getServerUrl()}</code>. Sign out to change the server address.
        </p>
      </div>

      <button className="btn danger block" onClick={logout} style={{ marginTop: 12 }}>
        <LogoutIcon /> Sign out
      </button>

      {confirmAll && (
        <Confirm
          title="Sign out everywhere?"
          message="Every phone, tablet and computer signed in to your account will be signed out, including this one. Use this if you lost a device."
          confirmLabel="Sign out everywhere"
          danger
          onClose={() => setConfirmAll(false)}
          onConfirm={async () => {
            await api.logoutAll();
            logout();
          }}
        />
      )}
    </>
  );
}

function describeDevice(ua: string): string {
  if (/UpNotice|Capacitor/i.test(ua) && /Android/i.test(ua)) return 'Android app';
  if (/iPhone|iPad/i.test(ua)) return /Capacitor/i.test(ua) ? 'iPhone app' : 'iPhone / iPad browser';
  if (/Electron/i.test(ua)) return 'Windows desktop app';
  if (/Android/i.test(ua)) return 'Android browser';
  if (/Windows/i.test(ua)) return 'Windows browser';
  if (/Macintosh/i.test(ua)) return 'Mac browser';
  if (/Linux/i.test(ua)) return 'Linux browser';
  return ua ? 'Other device' : 'Unknown device';
}

/**
 * Two-factor authentication. Four states: off, mid-setup (scan the QR and confirm), showing the recovery
 * codes once, and on. Nothing is switched on until a code from the app has been typed back, so a
 * half-finished setup can never lock anybody out.
 */
function TwoFactorCard() {
  const { user, setUser, toast } = useStore();
  const [step, setStep] = useState<'idle' | 'setup' | 'codes'>('idle');
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const on = !!user?.totp_enabled;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const begin = () =>
    run(async () => {
      setSetup(await api.twofaSetup());
      setCode('');
      setStep('setup');
    });

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api.twofaEnable(code.trim());
      setCodes(r.recovery_codes);
      setStep('codes');
      setCode('');
      setUser({ ...(user as User), totp_enabled: true });
      toast('Two-factor authentication is on');
    });
  };

  const turnOff = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api.twofaDisable(password, code.trim());
      setUser({ ...(user as User), totp_enabled: false });
      setPassword('');
      setCode('');
      setTurningOff(false);
      setStep('idle');
      toast('Two-factor authentication is off');
    });
  };

  const newCodes = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api.twofaNewRecoveryCodes(code.trim());
      setCodes(r.recovery_codes);
      setStep('codes');
      setCode('');
      toast('New recovery codes — the old ones no longer work');
    });
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast('Recovery codes copied');
    } catch {
      toast('Could not copy — select them and copy by hand');
    }
  };

  return (
    <div className="card">
      <div className="row between wrap" style={{ marginBottom: 6 }}>
        <div className="title">
          <LockIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Two-factor authentication
          {on && (
            <span className="chip ok" style={{ marginLeft: 8 }}>
              <i className="dot" />
              On
            </span>
          )}
        </div>
      </div>
      {error && (
        <div className="error" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {/* Showing the recovery codes — this happens once, so it takes over the card. */}
      {step === 'codes' ? (
        <>
          <p className="small">
            <strong>Save these now.</strong> Each one signs you in once if you lose your phone. They are not shown again.
          </p>
          <div className="recovery-codes">
            {codes.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={copyCodes}>
              <CopyIcon /> Copy all
            </button>
            <button className="btn sm primary" onClick={() => setStep('idle')}>
              I have saved them
            </button>
          </div>
        </>
      ) : step === 'setup' && setup ? (
        <>
          <p className="small muted" style={{ marginBottom: 10 }}>
            Scan this with Google Authenticator, Microsoft Authenticator, 1Password or any similar app, then type the six digits it shows.
          </p>
          <div className="qr-box">
            <QrCode text={setup.otpauth_url} size={168} />
            <div style={{ minWidth: 0 }}>
              <p className="tiny muted" style={{ marginBottom: 4 }}>
                Cannot scan? Type this into the app instead:
              </p>
              <code className="setup-secret">{setup.secret}</code>
            </div>
          </div>
          <form className="row" style={{ marginTop: 12 }} onSubmit={confirm}>
            <input
              className="input code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6 digits"
              inputMode="numeric"
              maxLength={6}
              required
              autoFocus
              aria-label="Code from your authenticator app"
            />
            <button className="btn primary" type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? '…' : 'Turn it on'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setStep('idle')}>
              Cancel
            </button>
          </form>
        </>
      ) : on ? (
        <>
          <p className="small muted" style={{ marginBottom: 10 }}>
            Signing in asks for a code from your authenticator app as well as your password. Someone who learns your password still cannot get in.
          </p>
          {turningOff ? (
            <form className="stack" style={{ gap: 8 }} onSubmit={turnOff}>
              <div className="field">
                <label>Your password</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </div>
              <div className="field">
                <label>Code from the app (or a recovery code)</label>
                <input className="input code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} required />
              </div>
              <div className="row wrap">
                <button className="btn danger" type="submit" disabled={busy || !password || !code}>
                  {busy ? 'Turning off…' : 'Turn two-factor off'}
                </button>
                <button className="btn ghost" type="button" onClick={() => setTurningOff(false)}>
                  Keep it on
                </button>
              </div>
            </form>
          ) : (
            <form className="row wrap" onSubmit={newCodes}>
              <input
                className="input code"
                style={{ maxWidth: 160 }}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="Code"
                maxLength={20}
                aria-label="Code from your authenticator app"
              />
              <button className="btn sm" type="submit" disabled={busy || code.trim().length < 6}>
                New recovery codes
              </button>
              <button className="btn sm ghost" type="button" onClick={() => setTurningOff(true)}>
                Turn off
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          <p className="small muted" style={{ marginBottom: 10 }}>
            Add a second step to signing in: your password, then a six-digit code from an app on your phone. Worth it for anyone who can post to everybody or see the employee list.
          </p>
          <button className="btn primary" onClick={begin} disabled={busy}>
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        </>
      )}
    </div>
  );
}

function SessionsCard({ onSignOutAll }: { onSignOutAll: () => void }) {
  const { data, loading, reload } = useLoader(() => api.sessions());
  // "Active now" goes stale the moment someone closes the app somewhere else, so re-ask every half minute.
  useEffect(() => {
    const t = window.setInterval(reload, 30000);
    return () => window.clearInterval(t);
  }, [reload]);
  const sessions: Session[] = data?.sessions || [];
  return (
    <div className="card">
      <div className="row between wrap" style={{ marginBottom: 6 }}>
        <div className="title">Signed-in devices</div>
        <button className="btn sm" onClick={onSignOutAll}>
          Sign out everywhere
        </button>
      </div>
      <p className="small muted" style={{ marginBottom: 8 }}>
        Where your account is signed in. <strong>Active now</strong> means the app is open on that device at this moment.
      </p>
      {loading && <Skeleton lines={2} />}
      <div className="list">
        {sessions.map((s) => (
          <div className="list-item" key={s.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6, fontWeight: 600 }}>
                {describeDevice(s.user_agent)}
                {s.current ? (
                  <span className="chip ok">
                    <i className="dot" />
                    This device
                  </span>
                ) : (
                  s.active && (
                    <span className="chip ok">
                      <i className="dot" />
                      Active now
                    </span>
                  )
                )}
              </div>
              <div className="tiny muted">
                Signed in {formatDateTime(s.created_at)} · {s.active && !s.current ? 'in use now' : `last used ${s.last_used_at ? timeAgo(s.last_used_at) : '–'}`}
                {s.ip ? ` · ${s.ip}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MyHistoryCard() {
  const { go } = useStore();
  const { data, loading } = useLoader(() => api.myHistory());
  const [show, setShow] = useState(false);
  if (loading)
    return (
      <div className="card">
        <Skeleton lines={2} />
      </div>
    );
  if (!data) return null;
  const s = data.stats;
  const pct = s.invited ? Math.round((s.going / s.invited) * 100) : null;
  const label = (r: string | null) => (r === 'going' ? 'Going' : r === 'maybe' ? 'Maybe' : r === 'declined' ? "Couldn't go" : 'No reply');
  const cls = (r: string | null) => (r === 'going' ? 'ok' : r === 'maybe' ? 'warn' : r === 'declined' ? 'danger' : '');
  return (
    <div className="card">
      <div className="row between">
        <div className="title">My attendance</div>
        {pct !== null && (
          <span className={`chip ${pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'danger'}`}>
            <i className="dot" />
            {pct}% attendance
          </span>
        )}
      </div>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        {s.invited} past meeting{s.invited === 1 ? '' : 's'}: {s.going} going · {s.maybe} maybe · {s.declined} declined · {s.no_reply} no reply
      </p>
      <button className="btn sm" onClick={() => setShow((v) => !v)}>
        <CalendarIcon /> {show ? 'Hide history' : 'Show history'}
      </button>
      {show && (
        <div className="list" style={{ marginTop: 10 }}>
          {data.meetings.length === 0 && <p className="small muted">No meetings yet.</p>}
          {data.meetings.map((m) => (
            <div className="list-item" key={m.id} style={{ cursor: 'pointer' }} onClick={() => go('meetings', { type: 'meeting', id: m.id })}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, textDecoration: m.status === 'cancelled' ? 'line-through' : undefined }}>{m.title}</div>
                <div className="tiny muted">
                  {formatDateTime(m.starts_at)}
                  {m.location ? ` · ${m.location}` : ''}
                  {m.my_note ? ` · “${m.my_note}”` : ''}
                </div>
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
                    <div className="tiny muted">
                      read {timeAgo(r.read_at)}
                      {r.ack_required ? (r.acknowledged_at ? ' · acknowledged' : ' · acknowledgement pending') : ''}
                    </div>
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
