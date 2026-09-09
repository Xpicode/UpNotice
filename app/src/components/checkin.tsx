import { useState, type FormEvent } from 'react';
import { api, formatTime, type Meeting, type OpenCheckIn } from '../api';
import { useNow, useStore } from '../store';
import { Sheet } from './ui';
import { CheckIcon, CheckSquareIcon, ClockIcon, MapPinIcon } from '../icons';

/**
 * Attendance check-in.
 *
 * The window (5 minutes before the start until 2 hours after the end) is decided by the server and sent with
 * every meeting, so what the screen offers and what the server accepts can never drift apart. Everything here
 * reads the clock through `useNow`, so the box appears the moment a meeting starts and disappears when the
 * window closes — the person never has to reload the page or go looking for it.
 */

/** Is check-in open for this meeting at `now`? */
export function checkInIsOpen(m: Pick<Meeting, 'status' | 'checkin_opens_at' | 'checkin_closes_at'>, now: number): boolean {
  return m.status === 'scheduled' && now >= Date.parse(m.checkin_opens_at) && now <= Date.parse(m.checkin_closes_at);
}

/** "in 25 minutes" / "5 minutes ago" — short and plain. */
function relative(iso: string, now: number): string {
  const mins = Math.round((Date.parse(iso) - now) / 60000);
  const n = Math.abs(mins);
  const amount = n < 1 ? 'less than a minute' : n < 60 ? `${n} minute${n === 1 ? '' : 's'}` : `${Math.round(n / 60)} hour${Math.round(n / 60) === 1 ? '' : 's'}`;
  return mins >= 0 ? `in ${amount}` : `${amount} ago`;
}

/** The line under the heading: has it started, and how long is there left to check in. */
export function checkInStatusLine(startsAt: string, closesAt: string, now: number): string {
  const started = now >= Date.parse(startsAt);
  return started ? `Started ${relative(startsAt, now)} · check-in closes ${relative(closesAt, now)}` : `Starts ${relative(startsAt, now)} · you can check in now`;
}

/** The code box itself. Used on the meeting page and inside the "check in now" banner. */
export function CheckInForm({ meetingId, onDone, autoFocus = false }: { meetingId: number; onDone?: () => void; autoFocus?: boolean }) {
  const { toast, bump } = useStore();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.checkIn(meetingId, code.trim());
      toast("You're checked in");
      bump();
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 8 }} onSubmit={submit}>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <input
          className="input code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Check-in code"
          maxLength={8}
          autoCapitalize="characters"
          autoComplete="off"
          autoFocus={autoFocus}
          aria-label="Check-in code"
        />
        <button className="btn primary" type="submit" disabled={busy || code.trim().length < 4}>
          {busy ? '…' : 'Check in'}
        </button>
      </div>
      <p className="tiny muted">The organizer shows the code, or a QR code with the same letters, at the meeting.</p>
    </form>
  );
}

/**
 * The strip across the top of every screen while a meeting the person is expected at is starting.
 * It comes from the dashboard, which the app refreshes every minute and after every live update, so it
 * appears on its own and goes away as soon as they are marked present.
 */
export function CheckInBanner() {
  const { dashboard, go } = useStore();
  const now = useNow(30000);
  const [open, setOpen] = useState(false);
  const meeting: OpenCheckIn | undefined = dashboard?.openCheckIn;
  if (!meeting) return null;
  // The dashboard is a minute old at most; hide the strip the second the window really closes.
  if (now > Date.parse(meeting.checkin_closes_at)) return null;

  return (
    <>
      <div className="checkin-bar">
        <span className="checkin-dot" aria-hidden="true" />
        <div className="checkin-bar-text">
          <strong>Check in to {meeting.title}</strong>
          <span className="tiny">{checkInStatusLine(meeting.starts_at, meeting.checkin_closes_at, now)}</span>
        </div>
        <button className="btn sm ghost desktop-only" onClick={() => go('meetings', { type: 'meeting', id: meeting.id })}>
          Details
        </button>
        <button className="btn sm" onClick={() => setOpen(true)}>
          <CheckSquareIcon style={{ width: 15, height: 15 }} /> Check in
        </button>
      </div>
      {open && (
        <Sheet title="Check in to the meeting" onClose={() => setOpen(false)}>
          <div className="stack">
            <div>
              <div className="title">{meeting.title}</div>
              <div className="small muted row" style={{ gap: 6, marginTop: 4 }}>
                <ClockIcon style={{ width: 14, height: 14 }} /> {formatTime(meeting.starts_at)} – {formatTime(meeting.ends_at)}
              </div>
              {meeting.location && (
                <div className="small muted row" style={{ gap: 6, marginTop: 2 }}>
                  <MapPinIcon style={{ width: 14, height: 14 }} /> {meeting.location}
                </div>
              )}
            </div>
            <CheckInForm meetingId={meeting.id} autoFocus onDone={() => setOpen(false)} />
          </div>
        </Sheet>
      )}
    </>
  );
}

/** "Attendance" section on the meeting page: the tick when done, the code box while the window is open. */
export function CheckInPanel({ m, onCheckedIn }: { m: Meeting; onCheckedIn: () => void }) {
  const now = useNow(30000);
  const open = checkInIsOpen(m, now);
  if (!m.attended_by_me && !open) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title">Attendance</div>
      {m.attended_by_me ? (
        <div className="success">
          <CheckIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> You're checked in to this meeting.
        </div>
      ) : (
        <>
          <p className="small muted" style={{ marginBottom: 8 }}>
            {checkInStatusLine(m.starts_at, m.checkin_closes_at, now)}
          </p>
          <CheckInForm meetingId={m.id} onDone={onCheckedIn} />
        </>
      )}
    </div>
  );
}
