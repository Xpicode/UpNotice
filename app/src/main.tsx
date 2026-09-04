import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initTheme } from './theme';

initTheme();

// Installable web app (PWA): only on real http(s) pages — not inside Electron (file://) or the Capacitor apps.
if (typeof window !== 'undefined' && window.location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {});
}

/** Shows the error on screen instead of a blank page, with a reload button. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <CrashScreen message={this.state.error.message} stack={this.state.error.stack} />;
    return this.props.children;
  }
}

function CrashScreen({ message, stack }: { message: string; stack?: string }) {
  return (
    <div style={{ maxWidth: 640, margin: '60px auto', padding: 20, fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginBottom: 8 }}>UpNotice hit a problem</h2>
      <p style={{ marginBottom: 12 }}>Something went wrong while loading the app. Reloading usually fixes it.</p>
      <pre style={{ background: '#fee2e2', color: '#991b1b', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>{message}{stack ? '\n\n' + stack.split('\n').slice(0, 5).join('\n') : ''}</pre>
      <button onClick={() => location.reload()} style={{ padding: '10px 16px', borderRadius: 8, border: 0, background: '#1d4ed8', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Reload</button>
      <button onClick={() => { localStorage.clear(); location.reload(); }} style={{ marginLeft: 8, padding: '10px 16px', borderRadius: 8, border: '1px solid #ccc', background: 'transparent', cursor: 'pointer' }}>Reset & reload</button>
    </div>
  );
}

// Errors thrown outside React (e.g. a module that failed to load) also get shown.
window.addEventListener('error', (e) => {
  const root = document.getElementById('root');
  if (root && root.childElementCount === 0) {
    root.innerHTML = `<div style="max-width:640px;margin:60px auto;padding:20px;font-family:system-ui,sans-serif">
      <h2>UpNotice could not start</h2>
      <p>If you just updated the code: stop the dev server, delete <code>app/node_modules/.vite</code>, run <code>npm install</code> and <code>npm run dev</code> again, then hard-refresh (Ctrl+F5).</p>
      <pre style="background:#fee2e2;color:#991b1b;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:12px">${String(e.message || e.error || 'Unknown error')}</pre>
      <button onclick="location.reload()" style="padding:10px 16px;border-radius:8px;border:0;background:#1d4ed8;color:#fff;font-weight:600;cursor:pointer">Reload</button></div>`;
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
