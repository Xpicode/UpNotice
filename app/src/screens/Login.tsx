import { useState, type FormEvent } from 'react';
import { api, getServerUrl, setServerUrl, setToken, type User } from '../api';
import { MegaphoneIcon } from '../icons';

export function LoginScreen({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-logo">
          <div className="brand-mark">
            <MegaphoneIcon style={{ width: 28, height: 28 }} />
          </div>
          <h1 style={{ fontSize: 24 }}>TeamAnnounce</h1>
          <p className="muted small">Announcements & meetings for your team</p>
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
          <button type="button" className="btn ghost sm" onClick={() => setShowServer((s) => !s)}>
            {showServer ? 'Hide server settings' : `Server: ${server}`}
          </button>
        </div>
      </form>
    </div>
  );
}
