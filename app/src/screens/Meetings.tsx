import { useState, type FormEvent } from 'react';
import { api, isStaff, formatDate, formatTime, googleCalendarUrl, newMeetingRoomUrl, openProtectedFile, toLocalInput, timeAgo, type Meeting, type RsvpStatus } from '../api';
import { useLoader, useNow, useStore } from '../store';
import { AudiencePicker, Confirm, Empty, Sheet, Skeleton, SkeletonList, audienceLabel, type Audience } from '../components/ui';
import { Avatar, CommentThread } from '../components/social';
import { EMPTY_FILTERS, FilterBar, useDebounced, type ListFilters } from '../components/filters';
import { MonthCalendar, QrCode } from '../components/calendar';
import { ApprovalQueue, CheckInPanel, CheckInRowPrompt, checkInIsOpen } from '../components/checkin';
import { CheckIcon, CheckSquareIcon, CopyIcon, FileTextIcon, GridIcon, ListIcon, QrIcon, RefreshIcon, SaveIcon } from '../icons';
import { CalendarIcon, ClockIcon, EditIcon, LinkIcon, LockIcon, MapPinIcon, PlusIcon, TrashIcon } from '../icons';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function DateBox({ m }: { m: Meeting }) {
  const d = new Date(m.starts_at);
  const past = new Date(m.ends_at).getTime() < Date.now();
  return (
    <div className={`date-box ${m.status === 'cancelled' ? 'cancelled' : past ? 'past' : ''}`}>
      <div className="d">{d.getDate()}</div>
      <div className="m">{MONTHS[d.getMonth()]}</div>
    </div>
  );
}

/** Going / Maybe / Can't go. Maybe and Can't go ask for a short reason first. */
function RsvpButtons({ m, onChange }: { m: Meeting; onChange: (s: RsvpStatus, note: string) => Promise<void> | void }) {
  const [asking, setAsking] = useState<Exclude<RsvpStatus, 'going'> | null>(null);
  const opts: { s: RsvpStatus; label: string; cls: string }[] = [
    { s: 'going', label: 'Going', cls: 'ok' },
    { s: 'maybe', label: 'Maybe', cls: 'warn' },
    { s: 'declined', label: "Can't go", cls: 'danger' },
  ];
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="rsvp-row">
        {opts.map((o) => (
          <button key={o.s} className={`btn sm ${m.my_rsvp === o.s ? o.cls : ''}`} onClick={() => (o.s === 'going' ? onChange('going', '') : setAsking(o.s))}>
            {o.label}
          </button>
        ))}
      </div>
      {m.my_rsvp && m.my_rsvp !== 'going' && m.my_rsvp_note && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Your reason: <em>{m.my_rsvp_note}</em> — tap {m.my_rsvp === 'maybe' ? 'Maybe' : "Can't go"} again to change it.
        </p>
      )}
      {asking && (
        <RsvpReasonSheet
          status={asking}
          initial={m.my_rsvp === asking ? m.my_rsvp_note || '' : ''}
          onClose={() => setAsking(null)}
          onSubmit={async (note) => {
            await onChange(asking, note);
            setAsking(null);
          }}
        />
      )}
    </div>
  );
}

function RsvpReasonSheet({
  status,
  initial,
  onClose,
  onSubmit,
}: {
  status: 'maybe' | 'declined';
  initial: string;
  onClose: () => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMaybe = status === 'maybe';
  return (
    <Sheet title={isMaybe ? 'Maybe — what might get in the way?' : "Can't go — what's the reason?"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!note.trim()) return setError('Please add a short reason so the organizer knows.');
          setBusy(true);
          setError(null);
          try {
            await onSubmit(note.trim());
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Reason (the organizer will see this)</label>
          <textarea
            className="textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            autoFocus
            required
            style={{ minHeight: 90 }}
            placeholder={isMaybe ? 'e.g. I have a client call that may run over' : 'e.g. On leave that day / out on a site visit'}
          />
          <p className="tiny muted" style={{ textAlign: 'right' }}>
            {note.length}/300
          </p>
        </div>
        <button className={`btn block ${isMaybe ? 'warn' : 'danger'}`} type="submit" disabled={busy}>
          {busy ? 'Saving…' : isMaybe ? 'Save as Maybe' : "Save as Can't go"}
        </button>
      </form>
    </Sheet>
  );
}

export function MeetingsScreen() {
  const { user, go, toast, bump } = useStore();
  const isAdmin = isStaff(user);
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const [view, setView] = useState<'list' | 'calendar'>(() => {
    try {
      return (localStorage.getItem('upnotice.meetingsView') as 'list' | 'calendar') || 'list';
    } catch {
      return 'list';
    }
  });
  const pickView = (v: 'list' | 'calendar') => {
    setView(v);
    try {
      localStorage.setItem('upnotice.meetingsView', v);
    } catch {
      /* ignore */
    }
  };
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const q = useDebounced(filters.q);
  const listScope = view === 'calendar' ? 'all' : scope;
  const { data, error, loading, setData } = useLoader(
    () => api.meetings(listScope, { q, company_id: filters.company_id, department_id: filters.department_id, from: filters.from, to: filters.to }),
    [listScope, q, filters.company_id, filters.department_id, filters.from, filters.to]
  );
  const [compose, setCompose] = useState(false);
  const hasQuery = !!(filters.q || filters.company_id || filters.department_id || filters.from || filters.to);

  const rsvp = async (m: Meeting, s: RsvpStatus, note: string) => {
    try {
      await api.rsvp(m.id, s, note);
      setData({ meetings: (data?.meetings || []).map((x) => (x.id === m.id ? { ...x, my_rsvp: s, my_rsvp_note: note } : x)) });
      toast(s === 'going' ? "You're going" : s === 'maybe' ? 'Marked as maybe — reason sent' : 'Marked as not going — reason sent');
      bump();
    } catch (e) {
      toast((e as Error).message);
      throw e;
    }
  };

  const meetings = data?.meetings || [];
  // A ticking clock, so the "Check in" button on a row appears the moment that meeting starts.
  const now = useNow(30000);

  return (
    <>
      <FilterBar value={filters} onChange={setFilters} placeholder="Search meetings…">
        {isAdmin && (
          <button className="btn primary" onClick={() => setCompose(true)} title="Schedule a meeting">
            <PlusIcon /> <span className="desktop-only">Schedule</span>
          </button>
        )}
      </FilterBar>
      <div className="row between wrap" style={{ marginBottom: 14 }}>
        {view === 'list' ? (
          <div className="seg">
            <button className={scope === 'upcoming' ? 'active' : ''} onClick={() => setScope('upcoming')}>
              Upcoming
            </button>
            <button className={scope === 'past' ? 'active' : ''} onClick={() => setScope('past')}>
              Past
            </button>
          </div>
        ) : (
          <span className="small muted">Tap a day to see its meetings.</span>
        )}
        <div className="seg">
          <button className={view === 'list' ? 'active' : ''} onClick={() => pickView('list')} title="List">
            <ListIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> <span className="desktop-only">List</span>
          </button>
          <button className={view === 'calendar' ? 'active' : ''} onClick={() => pickView('calendar')} title="Calendar">
            <GridIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> <span className="desktop-only">Calendar</span>
          </button>
        </div>
      </div>

      {loading && <SkeletonList count={3} />}
      {error && <div className="error">{error}</div>}
      {view === 'calendar' && !loading && <MonthCalendar meetings={meetings} onOpen={(id) => go('meetings', { type: 'meeting', id })} />}
      {view === 'list' && !loading && meetings.length === 0 && (
        <Empty
          icon={<CalendarIcon />}
          title={hasQuery ? 'No meetings match' : scope === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'}
          hint={hasQuery ? 'Try other words or clear the filters.' : isAdmin && scope === 'upcoming' ? 'Schedule a meeting and the team will be invited.' : undefined}
        />
      )}

      {view === 'list' &&
        meetings.map((m) => (
          <div
            key={m.id}
            className={`card clickable ${!m.my_rsvp && !isAdmin && m.status === 'scheduled' && scope === 'upcoming' ? 'unread' : ''}`}
            onClick={() => go('meetings', { type: 'meeting', id: m.id })}
          >
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <DateBox m={m} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  {m.status === 'cancelled' && <span className="chip danger">Cancelled</span>}
                  <span className="chip">{audienceLabel(m)}</span>
                  {m.recurrence && (
                    <span className="chip">
                      <RefreshIcon style={{ width: 12, height: 12 }} /> {m.recurrence === 'biweekly' ? 'Every 2 weeks' : m.recurrence[0].toUpperCase() + m.recurrence.slice(1)}
                    </span>
                  )}
                  {m.has_minutes && (
                    <span className="chip primary">
                      <FileTextIcon style={{ width: 12, height: 12 }} /> Minutes
                    </span>
                  )}
                  {m.attended_by_me && (
                    <span className="chip ok">
                      <CheckIcon style={{ width: 12, height: 12 }} /> Attended
                    </span>
                  )}
                </div>
                <div className="title" style={{ textDecoration: m.status === 'cancelled' ? 'line-through' : undefined }}>
                  {m.title}
                </div>
                <div className="small muted row" style={{ gap: 6, marginTop: 3 }}>
                  <ClockIcon style={{ width: 14, height: 14 }} /> {formatTime(m.starts_at)} – {formatTime(m.ends_at)}
                </div>
                {(m.location || m.has_link) && (
                  <div className="small muted row" style={{ gap: 6, marginTop: 2 }}>
                    {m.location ? <MapPinIcon style={{ width: 14, height: 14 }} /> : <LinkIcon style={{ width: 14, height: 14 }} />} {m.location || 'Online'}
                  </div>
                )}
              </div>
            </div>
            {isAdmin ? (
              <div className="row wrap tiny" style={{ marginTop: 10, gap: 6 }}>
                <span className="chip ok">{m.going_count} going</span>
                <span className="chip warn">{m.maybe_count} maybe</span>
                <span className="chip danger">{m.declined_count} declined</span>
                <span className="chip">{(m.audience_count ?? 0) - m.going_count - m.maybe_count - m.declined_count} no reply</span>
                {(scope === 'past' || m.attended_count > 0) && (
                  <span className="chip primary">
                    <CheckSquareIcon style={{ width: 12, height: 12 }} /> {m.attended_count} attended
                  </span>
                )}
              </div>
            ) : (
              m.status === 'scheduled' &&
              scope === 'upcoming' && (
                <div style={{ marginTop: 12 }}>
                  {checkInIsOpen(m, now) && !m.attended_by_me ? (
                    // The meeting is happening now: taking attendance matters more than the RSVP.
                    <CheckInRowPrompt m={m} now={now} onChanged={bump} />
                  ) : (
                    <RsvpButtons m={m} onChange={(s, note) => rsvp(m, s, note)} />
                  )}
                </div>
              )
            )}
          </div>
        ))}

      {compose && <MeetingForm onClose={() => setCompose(false)} />}
    </>
  );
}

export function MeetingDetail({ id }: { id: number }) {
  const { back, toast, bump } = useStore();
  const { data, error, loading, setData, reload } = useLoader(() => api.meeting(id), [id]);
  const [edit, setEdit] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [minutesDraft, setMinutesDraft] = useState<string | null>(null);
  const [savingMinutes, setSavingMinutes] = useState(false);
  // A ticking clock: the attendance box opens and closes by itself while the page stays open.
  const now = useNow(30000);
  const m = data?.meeting;

  if (loading) return <Skeleton card lines={4} />;
  if (error || !m) return <div className="error">{error || 'Meeting not found'}</div>;

  const isAdmin = !!m.can_manage;
  const past = new Date(m.ends_at).getTime() < now;
  const checkInOpen = checkInIsOpen(m, now);
  const toggleAttendance = async (userId: number, present: boolean) => {
    try {
      await api.setAttendance(m.id, userId, present);
      setData({
        meeting: {
          ...m,
          attended_count: m.attended_count + (present ? 1 : -1),
          attendees: m.attendees?.map((p) => (p.id === userId ? { ...p, attended_at: present ? new Date().toISOString() : null, attended_method: present ? 'staff' : null } : p)),
        },
      });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const saveMinutes = async () => {
    if (minutesDraft === null) return;
    setSavingMinutes(true);
    try {
      await api.saveMinutes(m.id, minutesDraft);
      toast(minutesDraft.trim() ? 'Minutes saved' : 'Minutes cleared');
      setMinutesDraft(null);
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSavingMinutes(false);
    }
  };
  const attendedList = (m.attendees || []).filter((p) => p.attended_at);
  const rsvp = async (s: RsvpStatus, note: string) => {
    try {
      await api.rsvp(m.id, s, note);
      setData({ meeting: { ...m, my_rsvp: s, my_rsvp_note: note } });
      toast('Response saved');
      bump();
    } catch (e) {
      toast((e as Error).message);
      throw e;
    }
  };

  const groups: { key: RsvpStatus | 'none'; label: string; cls: string }[] = [
    { key: 'going', label: 'Going', cls: 'ok' },
    { key: 'maybe', label: 'Maybe', cls: 'warn' },
    { key: 'declined', label: 'Declined', cls: 'danger' },
    { key: 'none', label: 'No reply yet', cls: '' },
  ];

  return (
    <>
      <div className="card">
        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {m.status === 'cancelled' && <span className="chip danger">Cancelled</span>}
          {past && m.status !== 'cancelled' && <span className="chip">Ended</span>}
          <span className="chip">{audienceLabel(m)}</span>
          {m.recurrence && (
            <span className="chip">
              <RefreshIcon style={{ width: 12, height: 12 }} /> Repeats {m.recurrence === 'biweekly' ? 'every 2 weeks' : m.recurrence}
            </span>
          )}
        </div>
        <h2 style={{ fontSize: 22, marginBottom: 12 }}>{m.title}</h2>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <CalendarIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> {formatDate(m.starts_at)}
          </div>
          <div className="row">
            <ClockIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> {formatTime(m.starts_at)} – {formatTime(m.ends_at)}
          </div>
          {m.location && (
            <div className="row">
              <MapPinIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> {m.location}
            </div>
          )}
          {m.has_link &&
            (m.link ? (
              <div className="row">
                <LinkIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} />{' '}
                <a href={m.link} target="_blank" rel="noreferrer">
                  Join online meeting
                </a>
              </div>
            ) : (
              // The server withholds the link itself until the check-in is approved; this says why.
              <div className="row muted">
                <LockIcon style={{ width: 18, height: 18 }} />
                {m.my_checkin === 'pending'
                  ? 'The joining link appears once your check-in is approved.'
                  : checkInOpen
                    ? 'Check in below to get the joining link.'
                    : 'The joining link appears once you check in and the organizer approves it.'}
              </div>
            ))}
        </div>
        {m.description && (
          <p className="prose" style={{ marginTop: 16 }}>
            {m.description}
          </p>
        )}
        <p className="tiny muted" style={{ marginTop: 14 }}>
          Organized by {m.organizer_name}
        </p>

        {m.status === 'scheduled' && !past && (
          <div className="row wrap" style={{ marginTop: 14, gap: 6 }}>
            <a className="btn sm" href={googleCalendarUrl(m)} target="_blank" rel="noreferrer">
              <CalendarIcon /> Google Calendar
            </a>
            <button
              type="button"
              className="btn sm"
              onClick={() => openProtectedFile(api.icsPath(m.id)).catch((e) => toast((e as Error).message))}
              title="Outlook, Apple Calendar and others"
            >
              <CalendarIcon /> Download .ics
            </button>
          </div>
        )}

        {!isAdmin && m.status === 'scheduled' && !past && (
          <div style={{ marginTop: 18 }}>
            <div className="section-title">Are you attending?</div>
            <RsvpButtons m={m} onChange={rsvp} />
          </div>
        )}
        {!isAdmin && <CheckInPanel m={m} onChanged={reload} />}
        {isAdmin && (
          <div className="row wrap" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="btn sm" onClick={() => setEdit(true)}>
              <EditIcon /> Edit
            </button>
            <button className="btn sm" onClick={() => setDuplicate(true)} title="Schedule a new meeting with the same details">
              <CopyIcon /> Duplicate
            </button>
            {m.status === 'scheduled' && (
              <button className="btn sm warn" onClick={() => setConfirm('cancel')}>
                Cancel meeting
              </button>
            )}
            <button className="btn sm danger" onClick={() => setConfirm('delete')}>
              <TrashIcon /> Delete
            </button>
          </div>
        )}
      </div>

      {isAdmin && m.status === 'scheduled' && m.checkin_code && (
        <div className="card">
          <div className="row between wrap">
            <div>
              <div className="title">Attendance</div>
              <p className="small muted">
                {attendedList.length} of {m.audience_count ?? m.attendees?.length ?? 0} checked in
                {m.pending_count > 0 ? ` · ${m.pending_count} waiting for you` : ''}
                {checkInOpen ? ' · check-in is open' : past ? ' · check-in has closed' : ' · check-in opens 5 min before the start'}
              </p>
            </div>
            <button className="btn sm" onClick={() => setShowQr((v) => !v)}>
              <QrIcon /> {showQr ? 'Hide code' : 'Show check-in code'}
            </button>
          </div>
          <ApprovalQueue m={m} onDecided={reload} />
          {showQr && (
            <div className="qr-box">
              <QrCode text={m.checkin_code} size={180} />
              <div>
                <div className="code-big">{m.checkin_code}</div>
                <p className="small muted">
                  A shortcut for people already in the room: showing this on a screen lets them type the code and be marked present without waiting for your approval. Otherwise
                  they tap "Check in" and you approve them here.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {(isAdmin || m.has_minutes) && (
        <div className="card">
          <div className="row between wrap">
            <div className="title">
              <FileTextIcon style={{ width: 18, height: 18, verticalAlign: '-3px' }} /> Minutes
            </div>
            {m.minutes_updated_at && <span className="tiny muted">updated {timeAgo(m.minutes_updated_at)}</span>}
          </div>
          {isAdmin && minutesDraft !== null ? (
            <div className="stack" style={{ marginTop: 10 }}>
              <textarea
                className="textarea"
                value={minutesDraft}
                onChange={(e) => setMinutesDraft(e.target.value)}
                style={{ minHeight: 160 }}
                placeholder="What was discussed, decisions, action items…"
                autoFocus
              />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setMinutesDraft(null)} disabled={savingMinutes}>
                  Cancel
                </button>
                <button className="btn primary" onClick={saveMinutes} disabled={savingMinutes}>
                  <SaveIcon /> {savingMinutes ? 'Saving…' : 'Save minutes'}
                </button>
              </div>
              {!m.has_minutes && <p className="tiny muted">Everyone invited gets a notification the first time minutes are posted.</p>}
            </div>
          ) : m.has_minutes ? (
            <>
              <p className="prose" style={{ marginTop: 10 }}>
                {m.minutes}
              </p>
              {isAdmin && (
                <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setMinutesDraft(m.minutes || '')}>
                  <EditIcon /> Edit minutes
                </button>
              )}
            </>
          ) : (
            <div style={{ marginTop: 8 }}>
              <p className="small muted">No minutes yet. Write down decisions and action items after the meeting — everyone invited can read them.</p>
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setMinutesDraft('')}>
                <EditIcon /> Write minutes
              </button>
            </div>
          )}
        </div>
      )}

      {isAdmin && m.attendees && (
        <div className="card">
          <div className="row between">
            <div className="title">Responses</div>
            <span className="chip primary">
              {m.going_count} of {m.audience_count} going
            </span>
          </div>
          {(m.attendees_total ?? 0) > m.attendees.length && (
            <p className="tiny muted">
              Showing the first {m.attendees.length} of {(m.attendees_total ?? 0).toLocaleString()} invitees — the counts above are for everyone; use Reports for the full list.
            </p>
          )}
          {groups.map((g) => {
            const people = m.attendees!.filter((p) => (g.key === 'none' ? !p.status : p.status === g.key));
            if (people.length === 0) return null;
            return (
              <div key={g.key}>
                <div className="section-title">
                  {g.label} ({people.length})
                </div>
                <div className="list">
                  {people.map((p) => (
                    <div className="list-item" key={p.id}>
                      <Avatar userId={p.id} name={p.name} avatarUrl={null} grey={g.key === 'none'} />
                      <div style={{ flex: 1 }}>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <span style={{ fontWeight: 600 }}>{p.name}</span>
                          {p.attended_at && (
                            <span className="chip ok">
                              <CheckIcon style={{ width: 12, height: 12 }} /> Attended{p.attended_method === 'self' ? ' (checked in)' : ''}
                            </span>
                          )}
                        </div>
                        <div className="tiny muted">{[p.company_name, p.department_name].filter(Boolean).join(' · ') || 'No department'}</div>
                        {p.note && (
                          <div className="small" style={{ marginTop: 4, color: g.key === 'declined' ? 'var(--danger)' : 'var(--warn)' }}>
                            “{p.note}”
                          </div>
                        )}
                      </div>
                      {p.checkin_status === 'pending' && <span className="chip warn">Waiting</span>}
                      {m.status === 'scheduled' && (
                        <label className="check" style={{ padding: 0 }} title="Mark present">
                          <input type="checkbox" checked={!!p.attended_at} onChange={(e) => toggleAttendance(p.id, e.target.checked)} />
                          <span className="tiny muted desktop-only">Present</span>
                        </label>
                      )}
                      {!m.status.startsWith('sched') && p.responded_at && <span className="tiny muted">{timeAgo(p.responded_at)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CommentThread refType="meeting" refId={m.id} />

      {edit && <MeetingForm existing={m} onClose={() => setEdit(false)} />}
      {duplicate && <MeetingForm prefill={m} onClose={() => setDuplicate(false)} />}
      {confirm === 'cancel' && (
        <Confirm
          title="Cancel this meeting?"
          message="Everyone invited will be notified that it's cancelled."
          confirmLabel="Cancel meeting"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.updateMeeting(m.id, { status: 'cancelled' });
            toast('Meeting cancelled');
            bump();
          }}
        />
      )}
      {confirm === 'delete' && !m.series_id && (
        <Confirm
          title="Delete this meeting?"
          message="This removes it completely, including all responses."
          confirmLabel="Delete"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteMeeting(m.id);
            toast('Meeting deleted');
            back();
          }}
        />
      )}
      {confirm === 'delete' && m.series_id && (
        <Sheet title="Delete repeating meeting" onClose={() => setConfirm(null)}>
          <p className="muted small" style={{ marginBottom: 14 }}>
            This meeting is part of a repeating series. What do you want to delete?
          </p>
          <div className="stack">
            <button
              className="btn"
              onClick={async () => {
                await api.deleteMeeting(m.id, 'one');
                toast('This occurrence deleted');
                back();
              }}
            >
              Only this occurrence
            </button>
            <button
              className="btn"
              onClick={async () => {
                await api.deleteMeeting(m.id, 'future');
                toast('This and future occurrences deleted');
                back();
              }}
            >
              This and all future occurrences
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                await api.deleteMeeting(m.id, 'all');
                toast('Whole series deleted');
                back();
              }}
            >
              The whole series
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** A link this app made itself, as opposed to one pasted in from Zoom or Google Meet. */
function isGeneratedRoom(link: string): boolean {
  return link.startsWith('https://meet.jit.si/UpNotice-');
}

async function copyLink(link: string, toast: (m: string) => void) {
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied');
  } catch {
    toast('Could not copy — select the address and copy it by hand');
  }
}

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

function MeetingForm({ existing, prefill, onClose }: { existing?: Meeting; prefill?: Meeting; onClose: () => void }) {
  const { toast, bump, user } = useStore();
  const src = existing || prefill; // prefill = duplicate: same details, new date
  const [title, setTitle] = useState(src?.title || '');
  const [description, setDescription] = useState(src?.description || '');
  const [start, setStart] = useState(existing ? toLocalInput(existing.starts_at) : defaultStart());
  const [end, setEnd] = useState(
    existing
      ? toLocalInput(existing.ends_at)
      : toLocalInput(new Date(new Date(defaultStart()).getTime() + (src ? new Date(src.ends_at).getTime() - new Date(src.starts_at).getTime() : 3600000)).toISOString())
  );
  const [location, setLocation] = useState(src?.location || '');
  const [link, setLink] = useState(src?.link || '');
  // How the online link is being set: nothing, a room made here, or one from Zoom / Meet / Teams.
  const [linkMode, setLinkMode] = useState<'none' | 'room' | 'paste'>(!src?.link ? 'none' : isGeneratedRoom(src.link) ? 'room' : 'paste');
  const pickLinkMode = (mode: typeof linkMode) => {
    setLinkMode(mode);
    if (mode === 'none') setLink('');
    if (mode === 'room' && !isGeneratedRoom(link)) setLink(newMeetingRoomUrl(title));
    if (mode === 'paste' && isGeneratedRoom(link)) setLink('');
  };
  const [audience, setAudience] = useState<Audience>({
    company_id: src?.company_id ?? (user?.role === 'manager' ? user.company_id : null),
    department_ids: src?.targets.map((t) => t.id) || [],
  });
  const [recurrence, setRecurrence] = useState<'' | 'weekly' | 'biweekly' | 'monthly'>('');
  const [occurrences, setOccurrences] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onStart = (v: string) => {
    setStart(v);
    // Keep a 1-hour default duration when the start moves.
    if (v && (!end || new Date(end) <= new Date(v))) setEnd(toLocalInput(new Date(new Date(v).getTime() + 3600000).toISOString()));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { title, description, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), location, link, ...audience };
      if (existing) {
        await api.updateMeeting(existing.id, payload);
        toast('Meeting updated');
      } else {
        const r = await api.createMeeting({ ...payload, ...(recurrence ? { recurrence, occurrences } : {}) });
        toast(r.created > 1 ? `${r.created} meetings scheduled — invites sent` : 'Meeting scheduled — invites sent');
      }
      bump();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={existing ? 'Edit meeting' : prefill ? 'Duplicate meeting' : 'Schedule a meeting'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="e.g. Monthly all-hands" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Starts</label>
            <input className="input" type="datetime-local" value={start} onChange={(e) => onStart(e.target.value)} required />
          </div>
          <div className="field">
            <label>Ends</label>
            <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </div>
        </div>
        <div className="field">
          <label>Location</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Conference room A" />
        </div>
        <div className="field">
          <label>Online meeting (optional)</label>
          <div className="seg" role="group" aria-label="Online meeting">
            {(
              [
                ['none', 'No link'],
                ['room', 'Create a room'],
                ['paste', 'Paste a link'],
              ] as const
            ).map(([mode, label]) => (
              <button key={mode} type="button" className={linkMode === mode ? 'active' : ''} onClick={() => pickLinkMode(mode)}>
                {label}
              </button>
            ))}
          </div>
          {linkMode === 'room' && (
            <div className="room-box">
              <div className="row">
                <span className="room-url">{link}</span>
                <button type="button" className="btn ghost icon-btn" title="Copy" onClick={() => copyLink(link, toast)}>
                  <CopyIcon />
                </button>
                <button type="button" className="btn ghost icon-btn" title="Different room" onClick={() => setLink(newMeetingRoomUrl(title))}>
                  <RefreshIcon />
                </button>
              </div>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                A Jitsi Meet room, ready the moment someone opens it — no account or install for you or anyone joining. Everyone invited gets the address once you approve their
                check-in.
              </p>
            </div>
          )}
          {linkMode === 'paste' && (
            <>
              <input
                className="input"
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://zoom.us/j/… or https://meet.google.com/…"
                style={{ marginTop: 8 }}
              />
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Not made one yet? Open{' '}
                <a href="https://meet.google.com/new" target="_blank" rel="noreferrer">
                  Google Meet
                </a>
                ,{' '}
                <a href="https://zoom.us/meeting/schedule" target="_blank" rel="noreferrer">
                  Zoom
                </a>{' '}
                or{' '}
                <a href="https://teams.microsoft.com/" target="_blank" rel="noreferrer">
                  Teams
                </a>
                , set the meeting up there and paste the address back here.
              </p>
            </>
          )}
        </div>
        <div className="field">
          <label>Agenda / notes</label>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the meeting is about…" style={{ minHeight: 80 }} />
        </div>
        <AudiencePicker value={audience} onChange={setAudience} />
        {!existing && (
          <div className="grid-2">
            <div className="field">
              <label>Repeat</label>
              <select className="select" value={recurrence} onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}>
                <option value="">Does not repeat</option>
                <option value="weekly">Every week</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Every month</option>
              </select>
            </div>
            {recurrence && (
              <div className="field">
                <label>How many times</label>
                <input className="input" type="number" min={2} max={52} value={occurrences} onChange={(e) => setOccurrences(Number(e.target.value) || 2)} />
              </div>
            )}
          </div>
        )}
        {recurrence && !existing && (
          <p className="tiny muted">Each occurrence is its own meeting with its own RSVPs. Attendees get one invite now and a reminder 1 hour before each meeting.</p>
        )}
        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : recurrence ? `Schedule ${occurrences} meetings` : 'Schedule & send invites'}
        </button>
      </form>
    </Sheet>
  );
}
