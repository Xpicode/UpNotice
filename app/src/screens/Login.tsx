// Sign-in screen: an animated brand panel (desktop) / header (phone) plus the form card.
// All motion is CSS (see "login" section in styles.css) and switches off with prefers-reduced-motion.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, getServerUrl, setServerUrl, setToken, type User } from '../api';
import { BellIcon, CalendarIcon, CheckIcon, EyeIcon, EyeOffIcon, LockIcon, MegaphoneIcon, QrIcon } from '../icons';
import { ThemeToggle } from '../components/theme-toggle';

/** Layout shared by the sign-in, forgot-password and reset forms. */
function LoginShell({ title, subtitle, children, onSubmit, shake, error }: { title: string; subtitle?: string; children: ReactNode; onSubmit: (e: FormEvent) => void; shake: boolean; error: string | null }) {
  return (
    <div className="login-wrap">
      <div className="login-theme"><ThemeToggle /></div>

      {/* Brand side: animated gradient, floating preview cards */}
      <aside className="login-hero" aria-hidden="true">
        <div className="login-blob b1" /><div className="login-blob b2" /><div className="login-blob b3" />
        <div className="login-hero-inner">
          <div className="login-hero-brand">
            <span className="login-hero-mark"><MegaphoneIcon style={{ width: 22, height: 22 }} /></span>
            UpNotice
          </div>
          <h2 className="login-hero-title">Every announcement, <br />every meeting, <br />one place.</h2>
          <p className="login-hero-sub">Post once — your whole team knows, and you can see who has read it.</p>
          <div className="login-float-stack">
            <div className="login-float f1">
              <span className="login-float-icon"><MegaphoneIcon /></span>
              <div><strong>Office closed on Monday</strong><span>Read by 42 of 48</span></div>
              <i className="login-float-bar"><b style={{ width: '87%' }} /></i>
            </div>
            <div className="login-float f2">
              <span className="login-float-icon cal"><CalendarIcon /></span>
              <div><strong>Monthly all-hands</strong><span>Tomorrow · 9:00 AM · 31 going</span></div>
            </div>
            <div className="login-float f3">
              <span className="login-float-icon ok"><QrIcon /></span>
              <div><strong>Safety briefing</strong><span>Checked in · code B52PT6</span></div>
              <em className="login-float-check"><CheckIcon /></em>
            </div>
            <div className="login-float f4">
              <span className="login-float-icon bell"><BellIcon /></span>
              <div><strong>New alert</strong><span>Maria commented on your post</span></div>
            </div>
          </div>
        </div>
      </aside>

      {/* Form side */}
      <div className="login-side">
        <form className={`card login-card ${shake ? 'shake' : ''}`} onSubmit={onSubmit}>
          <div className="login-logo">
            <div className="brand-mark login-mark">
              <MegaphoneIcon style={{ width: 28, height: 28 }} />
              <span className="login-ring" />
            </div>
            <h1 className="login-title">{title}</h1>
            {subtitle && <p className="muted small login-subtitle">{subtitle}</p>}
          </div>
          {error && <div className="error login-error" role="alert">{error}</div>}
          <div className="stack login-fields">{children}</div>
        </form>
        <p className="tiny muted login-foot">UpNotice by Upright Solutions</p>
      </div>
    </div>
  );
}

export function LoginScreen({ onLogin, resetToken }: { onLogin: (u: User) => void; resetToken?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [server, setServer] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false); // green tick on the button for a moment before the app opens
  const [shake, setShake] = useState(false);
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login');
  const [info, setInfo] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  // Re-trigger the shake animation on every new error.
  useEffect(() => {
    if (!error) return;
    setShake(true);
    const t = setTimeout(() => setShake(false), 500);
    return () => clearTimeout(t);
  }, [error]);

  const finish = (user: User, token: string) => {
    setToken(token);
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
      finish(r.user, r.token);
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
      finish(r.user, r.token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submitButton = (label: string, busyLabel: string) => (
    <button className={`btn primary block login-submit ${done ? 'done' : ''}`} type="submit" disabled={busy || done}>
      {done ? <><CheckIcon style={{ width: 18, height: 18 }} /> Welcome!</> : busy ? <><span className="btn-spinner" /> {busyLabel}</> : label}
    </button>
  );

  if (mode === 'reset') {
    return (
      <LoginShell title="Choose a new password" subtitle="Pick something at least 6 characters long." onSubmit={reset} shake={shake} error={error}>
        <div className="field">
          <label>New password</label>
          <div className="input-with-btn">
            <input className="input" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} autoFocus />
            <button type="button" className="input-btn" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOffIcon /> : <EyeIcon />}</button>
          </div>
        </div>
        {submitButton('Save and sign in', 'Saving…')}
        <button type="button" className="btn ghost sm" onClick={() => setMode('login')}>Back to sign in</button>
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
        <button type="button" className="btn ghost sm" onClick={() => { setMode('login'); setInfo(null); setError(null); }}>Back to sign in</button>
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
        <div className="input-with-btn">
          <input className="input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" />
          <button type="button" className="input-btn" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOffIcon /> : <EyeIcon />}</button>
        </div>
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
        <button type="button" className="btn ghost sm" onClick={() => { setMode('forgot'); setError(null); }}>Forgot password?</button>
        <button type="button" className="btn ghost sm" onClick={() => setShowServer((s) => !s)}>
          {showServer ? 'Hide server settings' : `Server: ${server.replace(/^https?:\/\//, '')}`}
        </button>
      </div>
      <p className="tiny muted login-secure"><LockIcon style={{ width: 12, height: 12 }} /> Your password is never stored in plain text.</p>
    </LoginShell>
  );
}
