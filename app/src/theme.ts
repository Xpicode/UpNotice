// Light / dark / system theme, remembered per device.
export type Theme = 'light' | 'dark' | 'system';
const KEY = 'ta.theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function isDarkNow(): boolean {
  const t = getTheme();
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(t: Theme = getTheme()) {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  root.classList.toggle('system-dark', t === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDarkNow() ? '#0b1120' : '#f8fafc');
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  applyTheme(t);
  window.dispatchEvent(new Event('ta-theme'));
}

/** Call once at startup: applies the saved theme and follows the OS setting when on "System". */
export function initTheme() {
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());
}
