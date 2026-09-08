import { useEffect, useState } from 'react';
import { getTheme, isDarkNow, setTheme, type Theme } from '../theme';
import { MoonIcon, SunIcon } from '../icons';

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [dark, setDark] = useState(isDarkNow());
  useEffect(() => {
    const sync = () => {
      setThemeState(getTheme());
      setDark(isDarkNow());
    };
    window.addEventListener('ta-theme', sync);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', sync);
    return () => {
      window.removeEventListener('ta-theme', sync);
      mq?.removeEventListener?.('change', sync);
    };
  }, []);
  return { theme, dark, set: setTheme };
}

/** Top-bar button: flips between light and dark. */
export function ThemeToggle() {
  const { dark, set } = useTheme();
  return (
    <button
      className="btn ghost icon-btn"
      onClick={() => set(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/** Settings card: Light / Dark / System. */
export function ThemePicker() {
  const { theme, set } = useTheme();
  const opts: { v: Theme; label: string }[] = [
    { v: 'light', label: 'Light' },
    { v: 'dark', label: 'Dark' },
    { v: 'system', label: 'Match device' },
  ];
  return (
    <div className="card">
      <div className="title" style={{ marginBottom: 6 }}>
        Appearance
      </div>
      <p className="small muted" style={{ marginBottom: 12 }}>
        Choose how UpNotice looks on this device.
      </p>
      <div className="seg">
        {opts.map((o) => (
          <button key={o.v} className={theme === o.v ? 'active' : ''} onClick={() => set(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
