import { useState, type FormEvent } from 'react';
import { api, formatTime, type Meeting, type OpenCheckIn } from '../api';
import { useNow, useStore } from '../store';
import { CheckIcon, CheckSquareIcon, ClockIcon } from '../icons';

/**
 * Attendance check-in.
 *
 * The attendee taps one button — no code to read off a screen — and the person who scheduled the meeting
 * approves it. Only an approved check-in counts as present, so nobody can mark themselves down for a meeting
 * they were not at. The code / QR is still there as a shortcut that skips the queue.
 *
 * The window (5 minutes before the start until 2 hours after the end) is decided by the server and sent with
 * every meeting, so what the screen offers and what the server accepts can never drift apart. Everything here
 * reads the clock through `useNow`, so the button appears the moment a meeting starts and goes when the
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

/** Sends the request and reports back. Shared by the button on the meeting page and the one in the strip. */
function useRequestCheckIn(meetingId: number, onDone?: () => void) {
  const { toast, bump } = useStore();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.requestCheckIn(meetingId);
      toast(r.status === 'approved' ? "You're checked in" : 'Sent — waiting for the organizer to approve');
      bump();
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { send, busy };
}

/** The code box, kept as a shortcut for anyone the organizer has shown the code or QR to. */
function CodeShortcut({ meetingId, onDone }: { meetingId: number; onDone?: () => void }) {
  const { toast, bump } = useStore();
  const [shown, setShown] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!shown)
    return (
      <button className="btn ghost sm" onClick={() => setShown(true)} style={{ marginTop: 10 }}>
        I have a code from the organizer
      </button>
    );

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
    <form className="stack" style={{ gap: 8, marginTop: 10 }} onSubmit={submit}>
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
          autoFocus
          aria-label="Check-in code"
        />
        <button className="btn" type="submit" disabled={busy || code.trim().length < 4}>
          {busy ? '…' : 'Use code'}
        </button>
      </div>
      <p className="tiny muted">The code the organizer is showing marks you present at once, with no approval needed.</p>
    </form>
  );
}

/**
 * The strip across the top of every screen: for an attendee while a meeting they are expected at is starting,
 * and for staff while people are waiting to be approved. Both come from the dashboard, which the app refreshes
 * every minute and after every live update, so they appear and go on their own.
 */
export function CheckInBanner() {
  const { dashboard, go } = useStore();
  const now = useNow(30000);
  const meeting = dashboard?.openCheckIn;
  const waiting = dashboard?.pendingApprovals || 0;
  const waitingMeetingId = dashboard?.pendingApprovalsMeetingId;

  // Staff first: approving the people standing in front of you beats checking yourself in somewhere else.
  if (waiting > 0 && waitingMeetingId) {
    return (
      <div className="checkin-bar">
        <span className="checkin-dot" aria-hidden="true" />
        <div className="checkin-bar-text">
          <strong>
            {waiting} {waiting === 1 ? 'person is' : 'people are'} checking in
          </strong>
          <span className="tiny">Approve them and they are marked present.</span>
        </div>
        <button className="btn sm" onClick={() => go('meetings', { type: 'meeting', id: waitingMeetingId })}>
          Review
        </button>
      </div>
    );
  }

  if (!meeting) return null;
  // The dashboard is a minute old at most; hide the strip the second the window really closes.
  if (now > Date.parse(meeting.checkin_closes_at)) return null;
  return <AttendeeBar meeting={meeting} now={now} />;
}

function AttendeeBar({ meeting, now }: { meeting: OpenCheckIn; now: number }) {
  const { go } = useStore();
  const { send, busy } = useRequestCheckIn(meeting.id);
  const pending = meeting.my_checkin === 'pending';
  return (
    <div className={`checkin-bar${pending ? ' waiting' : ''}`}>
      <span className="checkin-dot" aria-hidden="true" />
      <div className="checkin-bar-text">
        <strong>{pending ? `Waiting for approval · ${meeting.title}` : `Check in to ${meeting.title}`}</strong>
        <span className="tiny">{pending ? 'The organizer has your check-in and will approve it.' : checkInStatusLine(meeting.starts_at, meeting.checkin_closes_at, now)}</span>
      </div>
      <button className="btn sm ghost desktop-only" onClick={() => go('meetings', { type: 'meeting', id: meeting.id })}>
        Details
      </button>
      {!pending && (
        <button className="btn sm" onClick={send} disabled={busy}>
          <CheckSquareIcon style={{ width: 15, height: 15 }} /> {busy ? 'Sending…' : 'Check in'}
        </button>
      )}
    </div>
  );
}

/** "Attendance" section on the meeting page: the button, the waiting note, or the tick when it is done. */
export function CheckInPanel({ m, onChanged }: { m: Meeting; onChanged: () => void }) {
  const now = useNow(30000);
  const { send, busy } = useRequestCheckIn(m.id, onChanged);
  const open = checkInIsOpen(m, now);
  if (m.my_checkin === 'none' && !open) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title">Attendance</div>
      {m.my_checkin === 'approved' ? (
        <div className="success">
          <CheckIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> You're checked in to this meeting.
        </div>
      ) : m.my_checkin === 'pending' ? (
        <>
          <div className="waiting-note">
            <ClockIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> Waiting for {m.organizer_name} to approve your check-in.
          </div>
          {open && <CodeShortcut meetingId={m.id} onDone={onChanged} />}
        </>
      ) : (
        <>
          <p className="small muted" style={{ marginBottom: 10 }}>
            {checkInStatusLine(m.starts_at, m.checkin_closes_at, now)}
          </p>
          <button className="btn primary block" onClick={send} disabled={busy}>
            <CheckSquareIcon style={{ width: 18, height: 18 }} /> {busy ? 'Sending…' : "Check in — I'm here"}
          </button>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            {m.organizer_name} approves it and you are marked present.
          </p>
          <CodeShortcut meetingId={m.id} onDone={onChanged} />
        </>
      )}
    </div>
  );
}

/** The prompt inside a meeting row on the list, while that meeting is the one happening now. */
export function CheckInRowPrompt({ m, now, onChanged }: { m: Meeting; now: number; onChanged: () => void }) {
  const { send, busy } = useRequestCheckIn(m.id, onChanged);
  const pending = m.my_checkin === 'pending';
  return (
    <div className="checkin-row" onClick={(e) => e.stopPropagation()}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong className="small">{pending ? 'Waiting for approval' : 'Attendance is open'}</strong>
        <div className="tiny muted">{pending ? `${m.organizer_name} will approve your check-in.` : checkInStatusLine(m.starts_at, m.checkin_closes_at, now)}</div>
      </div>
      {!pending && (
        <button className="btn sm primary" onClick={send} disabled={busy}>
          <CheckSquareIcon style={{ width: 14, height: 14 }} /> {busy ? 'Sending…' : 'Check in'}
        </button>
      )}
    </div>
  );
}

/** The organizer's queue: everyone who has tapped the button and is waiting for a decision. */
export function ApprovalQueue({ m, onDecided }: { m: Meeting; onDecided: () => void }) {
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  const waiting = (m.attendees || []).filter((p) => p.checkin_status === 'pending');
  if (waiting.length === 0) return null;

  const decide = async (ids: number[], approve: boolean) => {
    setBusy(true);
    try {
      const r = await api.decideCheckIns(m.id, ids, approve);
      toast(approve ? `${r.decided} marked present` : `${r.decided} turned down`);
      onDecided();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approve-box">
      <div className="row between wrap" style={{ marginBottom: 10 }}>
        <div>
          <strong>{waiting.length} waiting to be approved</strong>
          <p className="tiny muted" style={{ marginTop: 2 }}>
            They tapped "Check in". Approve the ones who are really here.
          </p>
        </div>
        <button
          className="btn sm primary"
          disabled={busy}
          onClick={() =>
            decide(
              waiting.map((p) => p.id),
              true
            )
          }
        >
          <CheckIcon style={{ width: 14, height: 14 }} /> Approve all
        </button>
      </div>
      {waiting.map((p) => (
        <div key={p.id} className="approve-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong className="small">{p.name}</strong>
            <div className="tiny muted">
              {p.department_name || p.email}
              {p.checkin_requested_at ? ` · asked ${formatTime(p.checkin_requested_at)}` : ''}
            </div>
          </div>
          <button className="btn sm ghost" disabled={busy} onClick={() => decide([p.id], false)}>
            Decline
          </button>
          <button className="btn sm ok" disabled={busy} onClick={() => decide([p.id], true)}>
            <CheckIcon style={{ width: 14, height: 14 }} /> Approve
          </button>
        </div>
      ))}
    </div>
  );
}
