import { useState, type FormEvent } from 'react';
import { api, formatDate, formatTime, toLocalInput, timeAgo, type Meeting, type RsvpStatus } from '../api';
import { useLoader, useStore } from '../store';
import { AudiencePicker, Confirm, Empty, Sheet, Spinner, audienceLabel, type Audience } from '../components/ui';
import { Avatar, CommentThread } from '../components/social';
import { RefreshIcon } from '../icons';
import { CalendarIcon, ClockIcon, EditIcon, LinkIcon, MapPinIcon, PlusIcon, TrashIcon } from '../icons';

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

function RsvpReasonSheet({ status, initial, onClose, onSubmit }: { status: 'maybe' | 'declined'; initial: string; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
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
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus required style={{ minHeight: 90 }}
            placeholder={isMaybe ? 'e.g. I have a client call that may run over' : 'e.g. On leave that day / out on a site visit'} />
          <p className="tiny muted" style={{ textAlign: 'right' }}>{note.length}/300</p>
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
  const isAdmin = user?.role === 'admin';
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming');
  const { data, error, loading, setData } = useLoader(() => api.meetings(scope), [scope]);
  const [compose, setCompose] = useState(false);

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

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div className="seg">
          <button className={scope === 'upcoming' ? 'active' : ''} onClick={() => setScope('upcoming')}>Upcoming</button>
          <button className={scope === 'past' ? 'active' : ''} onClick={() => setScope('past')}>Past</button>
        </div>
        {isAdmin && (
          <button className="btn primary sm" onClick={() => setCompose(true)}>
            <PlusIcon /> Schedule
          </button>
        )}
      </div>

      {loading && <Spinner />}
      {error && <div className="error">{error}</div>}
      {!loading && meetings.length === 0 && (
        <Empty icon={<CalendarIcon />} title={scope === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'} hint={isAdmin && scope === 'upcoming' ? 'Schedule a meeting and the team will be invited.' : undefined} />
      )}

      {meetings.map((m) => (
        <div key={m.id} className={`card clickable ${!m.my_rsvp && !isAdmin && m.status === 'scheduled' && scope === 'upcoming' ? 'unread' : ''}`} onClick={() => go('meetings', { type: 'meeting', id: m.id })}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <DateBox m={m} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                {m.status === 'cancelled' && <span className="chip danger">Cancelled</span>}
                <span className="chip">{audienceLabel(m)}</span>
                {m.recurrence && <span className="chip"><RefreshIcon style={{ width: 12, height: 12 }} /> {m.recurrence === 'biweekly' ? 'Every 2 weeks' : m.recurrence[0].toUpperCase() + m.recurrence.slice(1)}</span>}
              </div>
              <div className="title" style={{ textDecoration: m.status === 'cancelled' ? 'line-through' : undefined }}>{m.title}</div>
              <div className="small muted row" style={{ gap: 6, marginTop: 3 }}>
                <ClockIcon style={{ width: 14, height: 14 }} /> {formatTime(m.starts_at)} – {formatTime(m.ends_at)}
              </div>
              {(m.location || m.link) && (
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
            </div>
          ) : (
            m.status === 'scheduled' && scope === 'upcoming' && (
              <div style={{ marginTop: 12 }}>
                <RsvpButtons m={m} onChange={(s, note) => rsvp(m, s, note)} />
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
  const { user, back, toast, bump } = useStore();
  const isAdmin = user?.role === 'admin';
  const { data, error, loading, setData } = useLoader(() => api.meeting(id), [id]);
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const m = data?.meeting;

  if (loading) return <Spinner />;
  if (error || !m) return <div className="error">{error || 'Meeting not found'}</div>;

  const past = new Date(m.ends_at).getTime() < Date.now();
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
          {m.recurrence && <span className="chip"><RefreshIcon style={{ width: 12, height: 12 }} /> Repeats {m.recurrence === 'biweekly' ? 'every 2 weeks' : m.recurrence}</span>}
        </div>
        <h2 style={{ fontSize: 22, marginBottom: 12 }}>{m.title}</h2>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><CalendarIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> {formatDate(m.starts_at)}</div>
          <div className="row"><ClockIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> {formatTime(m.starts_at)} – {formatTime(m.ends_at)}</div>
          {m.location && <div className="row"><MapPinIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> {m.location}</div>}
          {m.link && (
            <div className="row"><LinkIcon style={{ width: 18, height: 18, color: 'var(--primary)' }} /> <a href={m.link} target="_blank" rel="noreferrer">Join online meeting</a></div>
          )}
        </div>
        {m.description && <p className="prose" style={{ marginTop: 16 }}>{m.description}</p>}
        <p className="tiny muted" style={{ marginTop: 14 }}>Organized by {m.organizer_name}</p>

        {!isAdmin && m.status === 'scheduled' && !past && (
          <div style={{ marginTop: 18 }}>
            <div className="section-title">Are you attending?</div>
            <RsvpButtons m={m} onChange={rsvp} />
          </div>
        )}
        {isAdmin && (
          <div className="row wrap" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="btn sm" onClick={() => setEdit(true)}><EditIcon /> Edit</button>
            {m.status === 'scheduled' && <button className="btn sm warn" onClick={() => setConfirm('cancel')}>Cancel meeting</button>}
            <button className="btn sm danger" onClick={() => setConfirm('delete')}><TrashIcon /> Delete</button>
          </div>
        )}
      </div>

      {isAdmin && m.attendees && (
        <div className="card">
          <div className="row between">
            <div className="title">Responses</div>
            <span className="chip primary">{m.going_count} of {m.audience_count} going</span>
          </div>
          {groups.map((g) => {
            const people = m.attendees!.filter((p) => (g.key === 'none' ? !p.status : p.status === g.key));
            if (people.length === 0) return null;
            return (
              <div key={g.key}>
                <div className="section-title">{g.label} ({people.length})</div>
                <div className="list">
                  {people.map((p) => (
                    <div className="list-item" key={p.id}>
                      <Avatar userId={p.id} name={p.name} avatarUrl={null} grey={g.key === 'none'} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="tiny muted">{[p.company_name, p.department_name].filter(Boolean).join(' · ') || 'No department'}</div>
                        {p.note && <div className="small" style={{ marginTop: 4, color: g.key === 'declined' ? 'var(--danger)' : 'var(--warn)' }}>“{p.note}”</div>}
                      </div>
                      {p.responded_at && <span className="tiny muted">{timeAgo(p.responded_at)}</span>}
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
      {confirm === 'cancel' && (
        <Confirm title="Cancel this meeting?" message="Everyone invited will be notified that it's cancelled." confirmLabel="Cancel meeting" danger onClose={() => setConfirm(null)} onConfirm={async () => { await api.updateMeeting(m.id, { status: 'cancelled' }); toast('Meeting cancelled'); bump(); }} />
      )}
      {confirm === 'delete' && !m.series_id && (
        <Confirm title="Delete this meeting?" message="This removes it completely, including all responses." confirmLabel="Delete" danger onClose={() => setConfirm(null)} onConfirm={async () => { await api.deleteMeeting(m.id); toast('Meeting deleted'); back(); }} />
      )}
      {confirm === 'delete' && m.series_id && (
        <Sheet title="Delete repeating meeting" onClose={() => setConfirm(null)}>
          <p className="muted small" style={{ marginBottom: 14 }}>This meeting is part of a repeating series. What do you want to delete?</p>
          <div className="stack">
            <button className="btn" onClick={async () => { await api.deleteMeeting(m.id, 'one'); toast('This occurrence deleted'); back(); }}>Only this occurrence</button>
            <button className="btn" onClick={async () => { await api.deleteMeeting(m.id, 'future'); toast('This and future occurrences deleted'); back(); }}>This and all future occurrences</button>
            <button className="btn danger" onClick={async () => { await api.deleteMeeting(m.id, 'all'); toast('Whole series deleted'); back(); }}>The whole series</button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

function MeetingForm({ existing, onClose }: { existing?: Meeting; onClose: () => void }) {
  const { toast, bump } = useStore();
  const [title, setTitle] = useState(existing?.title || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [start, setStart] = useState(existing ? toLocalInput(existing.starts_at) : defaultStart());
  const [end, setEnd] = useState(existing ? toLocalInput(existing.ends_at) : toLocalInput(new Date(new Date(defaultStart()).getTime() + 3600000).toISOString()));
  const [location, setLocation] = useState(existing?.location || '');
  const [link, setLink] = useState(existing?.link || '');
  const [audience, setAudience] = useState<Audience>({ company_id: existing?.company_id ?? null, department_ids: existing?.targets.map((t) => t.id) || [] });
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
    <Sheet title={existing ? 'Edit meeting' : 'Schedule a meeting'} onClose={onClose}>
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
          <label>Online meeting link (optional)</label>
          <input className="input" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://meet.google.com/…" />
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
        {recurrence && !existing && <p className="tiny muted">Each occurrence is its own meeting with its own RSVPs. Attendees get one invite now and a reminder 1 hour before each meeting.</p>}
        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : recurrence ? `Schedule ${occurrences} meetings` : 'Schedule & send invites'}
        </button>
      </form>
    </Sheet>
  );
}
