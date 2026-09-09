// Sign-in screen: a quiet brand panel (desktop) / header (phone) plus the form card.
// All motion is CSS (see "login" section in styles.css) and switches off with prefers-reduced-motion.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, getServerUrl, needsSecondFactor, setServerUrl, setSession, MIN_PASSWORD_LENGTH, type Tokens, type User } from '../api';
import { BellIcon, CalendarIcon, CheckIcon, EyeIcon, EyeOffIcon, LockIcon, MegaphoneIcon, QrIcon } from '../icons';
import { ThemeToggle } from '../components/theme-toggle';

/** Layout shared by the sign-in, forgot-password, reset and first-password forms. */
function LoginShell({
  title,
  subtitle,
  children,
  onSubmit,
  shake,
  error,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onSubmit: (e: FormEvent) => void;
  shake: boolean;
  error: string | null;
}) {
  return (
    <div className="login-wrap">
      <div className="login-theme">
        <ThemeToggle />
      </div>

      {/* Brand side: blurred gradient orbs behind the headline and an isometric stack of preview cards */}
      <aside className="login-hero" aria-hidden="true">
        <div className="login-orb o1" />
        <div className="login-orb o2" />
        <div className="login-orb o3" />
        <div className="login-hero-inner">
          <div className="login-hero-brand">
            <span className="login-hero-mark">
              <MegaphoneIcon style={{ width: 20, height: 20 }} />
            </span>
            UpNotice
          </div>
          <div className="login-pill">
            <b>NEW</b> Read receipts and meeting check-in
          </div>
          <h2 className="login-hero-title">
            Every announcement, <br />
            every meeting, <br />
            <span className="grad">one place.</span>
          </h2>
          <p className="login-hero-sub">Post once. Your whole team knows, and you can see who has read it.</p>

          <div className="login-scene">
            <div className="login-float-stack">
              <div className="login-float f1">
                <span className="login-float-icon">
                  <MegaphoneIcon />
                </span>
                <div>
                  <strong>Office closed on Monday</strong>
                  <span>Read by 42 of 48</span>
                </div>
                <i className="login-float-bar">
                  <b style={{ width: '87%' }} />
                </i>
              </div>
              <div className="login-float f2">
                <span className="login-float-icon">
                  <CalendarIcon />
                </span>
                <div>
                  <strong>Monthly all-hands</strong>
                  <span>Tomorrow · 9:00 AM · 31 going</span>
                </div>
              </div>
              <div className="login-float f3">
                <span className="login-float-icon">
                  <QrIcon />
                </span>
                <div>
                  <strong>Safety briefing</strong>
                  <span>Checked in · code B52PT6</span>
                </div>
                <em className="login-float-check">
                  <CheckIcon />
                </em>
              </div>
              <div className="login-float f4">
                <span className="login-float-icon">
                  <BellIcon />
                </span>
                <div>
                  <strong>New notification</strong>
                  <span>Maria commented on your post</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Form side */}
      <div className="login-side">
        <form className={`card login-card ${shake ? 'shake' : ''}`} onSubmit={onSubmit}>
          <div className="login-logo">
            <div className="brand-mark login-mark">
              <MegaphoneIcon style={{ width: 24, height: 24 }} />
            </div>
            <h1 className="login-title">{title}</h1>
            {subtitle && <p className="muted small login-subtitle">{subtitle}</p>}
          </div>
          {error && (
            <div className="error login-error" role="alert">
              {error}
            </div>
          )}
          <div className="stack login-fields">{children}</div>
        </form>
        <p className="tiny muted login-foot">UpNotice by Upright Solutions</p>
      </div>
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  autoFocus,
  minLength,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  placeholder?: string;
  autoFocus?: boolean;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-with-btn">
      <input
        className="input"
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={minLength}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      <button type="button" className="input-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function useShake(error: string | null) {
  const [shake, setShake] = useState(false);
  useEffect(() => {
    if (!error) return;
    setShake(true);
    const t = setTimeout(() => setShake(false), 500);
    return () => clearTimeout(t);
  }, [error]);
  return shake;
}

export function LoginScreen({ onLogin, resetToken }: { onLogin: (u: User) => void; resetToken?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false); // tick on the button for a moment before the app opens
  const shake = useShake(error);
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset' | 'twofa'>(resetToken ? 'reset' : 'login');
  // Set once the password was right and the account asks for a second factor. Good for five minutes.
  const [twofaToken, setTwofaToken] = useState('');
  const [twofaCode, setTwofaCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const finish = (user: User, tokens: Tokens) => {
    setSession(tokens);
    setDone(true);
    setTimeout(() => onLogin(user), 450);
  };

  const forgot = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setServerUrl(server.trim());
      const r = await api.forgotPassword(email.trim());
      setInfo(r.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.resetPassword(resetToken || '', newPassword);
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch {
        /* ignore */
      }
      finish(r.user, r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setServerUrl(server.trim());
      const r = await api.login(email.trim(), password);
      if (needsSecondFactor(r)) {
        setTwofaToken(r.twofa_token);
        setTwofaCode('');
        setMode('twofa');
        setBusy(false);
        return;
      }
      finish(r.user, r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submitTwofa = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.loginTwofa(twofaToken, twofaCode.trim());
      finish(r.user, r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submitButton = (label: string, busyLabel: string) => (
    <button className={`btn primary block login-submit ${done ? 'done' : ''}`} type="submit" disabled={busy || done}>
      {done ? (
        <>
          <CheckIcon style={{ width: 18, height: 18 }} /> Welcome
        </>
      ) : busy ? (
        <>
          <span className="btn-spinner" /> {busyLabel}
        </>
      ) : (
        label
      )}
    </button>
  );

  if (mode === 'reset') {
    return (
      <LoginShell
        title="Choose a new password"
        subtitle={`At least ${MIN_PASSWORD_LENGTH} characters. Not your email, not something common.`}
        onSubmit={reset}
        shake={shake}
        error={error}
      >
        <div className="field">
          <label>New password</label>
          <PasswordInput value={newPassword} onChange={setNewPassword} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} autoFocus />
        </div>
        {submitButton('Save and sign in', 'Saving…')}
        <button type="button" className="btn ghost sm" onClick={() => setMode('login')}>
          Back to sign in
        </button>
      </LoginShell>
    );
  }

  if (mode === 'twofa') {
    return (
      <LoginShell title="One more step" subtitle="Open your authenticator app and type the six digits it shows for UpNotice." onSubmit={submitTwofa} shake={shake} error={error}>
        <div className="field">
          <label>Code</label>
          <input
            className="input code"
            value={twofaCode}
            onChange={(e) => setTwofaCode(e.target.value.toUpperCase())}
            inputMode="text"
            autoComplete="one-time-code"
            maxLength={20}
            required
            autoFocus
            aria-label="Two-factor code"
          />
          <p className="tiny muted" style={{ marginTop: 6 }}>
            Lost your phone? Type one of the recovery codes you saved instead — each one works once.
          </p>
        </div>
        {submitButton('Sign in', 'Checking…')}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setMode('login');
            setTwofaToken('');
            setError(null);
          }}
        >
          Back to sign in
        </button>
      </LoginShell>
    );
  }

  if (mode === 'forgot') {
    return (
      <LoginShell title="Forgot your password?" subtitle="Enter your email and we'll send you a link to choose a new one." onSubmit={forgot} shake={shake} error={error}>
        {info ? (
          <div className="success">{info}</div>
        ) : (
          <>
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            {submitButton('Send reset link', 'Sending…')}
          </>
        )}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setMode('login');
            setInfo(null);
            setError(null);
          }}
        >
          Back to sign in
        </button>
      </LoginShell>
    );
  }

  return (
    <LoginShell title="Welcome back" subtitle="Sign in to see your announcements and meetings." onSubmit={submit} shake={shake} error={error}>
      <div className="field">
        <label>Email</label>
        <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="you@company.com" />
      </div>
      <div className="field">
        <label>Password</label>
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" placeholder="••••••••" />
      </div>
      {showServer && (
        <div className="field">
          <label>Server address</label>
          <input className="input" type="url" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.10:4000" />
          <p className="tiny muted">On a phone, use your PC's LAN IP address (not localhost).</p>
        </div>
      )}
      {submitButton('Sign in', 'Signing in…')}
      <div className="row" style={{ justifyContent: 'center', gap: 4, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setMode('forgot');
            setError(null);
          }}
        >
          Forgot password?
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setShowServer((s) => !s)}>
          {showServer ? 'Hide server settings' : `Server: ${server.replace(/^https?:\/\//, '')}`}
        </button>
      </div>
      <p className="tiny muted login-secure">
        <LockIcon style={{ width: 12, height: 12 }} /> Your password is never stored in plain text.
      </p>
    </LoginShell>
  );
}

/** Shown after signing in with a temporary password: the person picks their own before the app opens. */
export function ChangePasswordScreen({ user, onDone, onSignOut }: { user: User; onDone: (u: User) => void; onSignOut: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const shake = useShake(error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError('The two passwords do not match');
    setBusy(true);
    try {
      const r = await api.changePassword(current, next);
      setDone(true);
      setTimeout(() => onDone({ ...r.user, must_change_password: false }), 450);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <LoginShell
      title={`Hi ${user.name.split(' ')[0]}, choose your password`}
      subtitle={`The password you were given is temporary. Pick your own: at least ${MIN_PASSWORD_LENGTH} characters, not your email, not something common.`}
      onSubmit={submit}
      shake={shake}
      error={error}
    >
      <div className="field">
        <label>Temporary password</label>
        <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      </div>
      <div className="field">
        <label>New password</label>
        <PasswordInput value={next} onChange={setNext} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} />
      </div>
      <div className="field">
        <label>New password again</label>
        <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} />
      </div>
      <button className={`btn primary block login-submit ${done ? 'done' : ''}`} type="submit" disabled={busy || done}>
        {done ? (
          <>
            <CheckIcon style={{ width: 18, height: 18 }} /> Saved
          </>
        ) : busy ? (
          <>
            <span className="btn-spinner" /> Saving…
          </>
        ) : (
          'Save and continue'
        )}
      </button>
      <button type="button" className="btn ghost sm" onClick={onSignOut}>
        Sign out
      </button>
    </LoginShell>
  );
}
