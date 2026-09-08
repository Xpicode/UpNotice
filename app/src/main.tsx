import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@fontsource-variable/plus-jakarta-sans';
import './styles.css';
import { initTheme } from './theme';

initTheme();

// Installable web app (PWA): only on real http(s) pages — not inside Electron (file://) or the Capacitor apps.
if (typeof window !== 'undefined' && window.location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
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
    <div className="crash">
      <h2>UpNotice hit a problem</h2>
      <p>Something went wrong while loading the app. Reloading usually fixes it.</p>
      <pre>
        {message}
        {stack ? '\n\n' + stack.split('\n').slice(0, 5).join('\n') : ''}
      </pre>
      <div className="row">
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
        <button
          className="btn"
          onClick={() => {
            localStorage.clear();
            location.reload();
          }}
        >
          Reset & reload
        </button>
      </div>
    </div>
  );
}

// Errors thrown outside React (e.g. a module that failed to load) also get shown.
window.addEventListener('error', (e) => {
  const root = document.getElementById('root');
  if (root && root.childElementCount === 0) {
    root.innerHTML = `<div class="crash">
      <h2>UpNotice could not start</h2>
      <p>If you just updated the code: stop the dev server, delete <code>app/node_modules/.vite</code>, run <code>npm install</code> and <code>npm run dev</code> again, then hard-refresh (Ctrl+F5).</p>
      <pre></pre>
      <button class="btn primary" onclick="location.reload()">Reload</button></div>`;
    const pre = root.querySelector('pre');
    if (pre) pre.textContent = String(e.message || e.error || 'Unknown error');
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
