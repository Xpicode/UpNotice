import { useState, type FormEvent } from 'react';
import { api, getServerUrl, setServerUrl, setToken, type User } from '../api';
import { MegaphoneIcon } from '../icons';
import { ThemeToggle } from '../components/theme-toggle';

export function LoginScreen({ onLogin, resetToken }: { onLogin: (u: User) => void; resetToken?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login');
  const [info, setInfo] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

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
      setToken(r.token);
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch {
        /* ignore */
      }
      onLogin(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
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
      setToken(r.token);
      onLogin(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'reset') {
    return (
      <div className="login-wrap">
        <div style={{ position: 'fixed', top: 'calc(10px + var(--safe-top))', right: 10 }}><ThemeToggle /></div>
        <form className="card login-card" onSubmit={reset}>
          <div className="login-logo">
            <div className="brand-mark"><MegaphoneIcon style={{ width: 28, height: 28 }} /></div>
            <h1 style={{ fontSize: 24 }}>Choose a new password</h1>
          </div>
          <div className="stack">
            {error && <div className="error">{error}</div>}
            <div className="field">
              <label>New password</label>
              <input className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} autoFocus />
            </div>
            <button className="btn primary block" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and sign in'}</button>
            <button type="button" className="btn ghost sm" onClick={() => setMode('login')}>Back to sign in</button>
          </div>
        </form>
      </div>
    );
  }

  if (mode === 'forgot') {
    return (
      <div className="login-wrap">
        <div style={{ position: 'fixed', top: 'calc(10px + var(--safe-top))', right: 10 }}><ThemeToggle /></div>
        <form className="card login-card" onSubmit={forgot}>
          <div className="login-logo">
            <div className="brand-mark"><MegaphoneIcon style={{ width: 28, height: 28 }} /></div>
            <h1 style={{ fontSize: 24 }}>Forgot your password?</h1>
            <p className="muted small">Enter your email and we'll send you a link to choose a new one.</p>
          </div>
          <div className="stack">
            {error && <div className="error">{error}</div>}
            {info ? (
              <div className="success">{info}</div>
            ) : (
              <>
                <div className="field">
                  <label>Email</label>
                  <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
                </div>
                <button className="btn primary block" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
              </>
            )}
            <button type="button" className="btn ghost sm" onClick={() => { setMode('login'); setInfo(null); setError(null); }}>Back to sign in</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <div style={{ position: 'fixed', top: 'calc(10px + var(--safe-top))', right: 10 }}><ThemeToggle /></div>
      <form className="card login-card" onSubmit={submit}>
        <div className="login-logo">
          <div className="brand-mark">
            <MegaphoneIcon style={{ width: 28, height: 28 }} />
          </div>
          <h1 style={{ fontSize: 24 }}>UpNotice</h1>
          <p className="muted small">Announcements & meetings for your team, by Upright Solutions</p>
        </div>
        <div className="stack">
          {error && <div className="error">{error}</div>}
          <div className="field">
            <label>Email</label>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {showServer && (
            <div className="field">
              <label>Server address</label>
              <input className="input" type="url" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.10:4000" />
              <p className="tiny muted">On a phone, use your PC's LAN IP address (not localhost).</p>
            </div>
          )}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="row" style={{ justifyContent: 'center', gap: 4 }}>
            <button type="button" className="btn ghost sm" onClick={() => { setMode('forgot'); setError(null); }}>Forgot password?</button>
            <button type="button" className="btn ghost sm" onClick={() => setShowServer((s) => !s)}>
              {showServer ? 'Hide server settings' : `Server: ${server.replace(/^https?:\/\//, '')}`}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
