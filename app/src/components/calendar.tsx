// Month calendar of meetings + QR code for check-in.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatTime, type Meeting } from '../api';
import { BackIcon } from '../icons';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function MonthCalendar({ meetings, onOpen }: { meetings: Meeting[]; onOpen: (id: number) => void }) {
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<string>(key(today));

  const byDay = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const k = key(new Date(m.starts_at));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(m);
  }

  // Grid: Monday-first, 6 rows max.
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
  while (cells.length % 7) cells.push(null);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const selectedList = byDay.get(selected) || [];
  const selectedDate = (() => {
    const [y, m, d] = selected.split('-').map(Number);
    return new Date(y, m, d);
  })();

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="btn ghost icon-btn" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Previous month"><BackIcon /></button>
        <div className="title" style={{ textTransform: 'capitalize' }}>{monthLabel}</div>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" onClick={() => { setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); setSelected(key(today)); }}>Today</button>
          <button className="btn ghost icon-btn" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Next month"><BackIcon style={{ transform: 'rotate(180deg)' }} /></button>
        </div>
      </div>
      <div className="cal-grid">
        {DAYS.map((d) => <div key={d} className="cal-head">{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} className="cal-cell empty" />;
          const k = key(d);
          const items = byDay.get(k) || [];
          const isToday = k === key(today);
          return (
            <button key={k} type="button" className={`cal-cell ${k === selected ? 'selected' : ''} ${isToday ? 'today' : ''} ${items.length ? 'has' : ''}`} onClick={() => setSelected(k)}>
              <span className="cal-num">{d.getDate()}</span>
              {items.length > 0 && (
                <span className="cal-dots">
                  {items.slice(0, 3).map((m) => <i key={m.id} className={m.status === 'cancelled' ? 'cancelled' : ''} />)}
                  {items.length > 3 && <em>+{items.length - 3}</em>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="section-title" style={{ marginTop: 14 }}>{selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      {selectedList.length === 0 && <p className="muted small">No meetings this day.</p>}
      <div className="list">
        {selectedList.map((m) => (
          <div key={m.id} className="list-item" style={{ cursor: 'pointer' }} onClick={() => onOpen(m.id)}>
            <div className="cal-time">{formatTime(m.starts_at)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, textDecoration: m.status === 'cancelled' ? 'line-through' : undefined }}>{m.title}</div>
              <div className="tiny muted">{formatTime(m.starts_at)} – {formatTime(m.ends_at)}{m.location ? ` · ${m.location}` : m.link ? ' · Online' : ''}</div>
            </div>
            {m.status === 'cancelled' && <span className="chip danger">Cancelled</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** QR code rendered as inline SVG (used for the meeting check-in code). */
export function QrCode({ text, size = 160 }: { text: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((s) => alive && setSvg(s)).catch(() => setSvg(''));
    return () => {
      alive = false;
    };
  }, [text]);
  if (!svg) return null;
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
