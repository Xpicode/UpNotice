import { api, isStaff, formatDateTime, timeAgo, type Announcement, type Meeting } from '../api';
import { useLoader, useStore } from '../store';
import { PriorityChip, Spinner } from '../components/ui';
import { CalendarIcon, MegaphoneIcon } from '../icons';

export function HomeScreen() {
  const { user, dashboard, go } = useStore();
  const isAdmin = isStaff(user);
  const { data, loading } = useLoader(async () => {
    const [a, m] = await Promise.all([api.announcements(), api.meetings('upcoming')]);
    return { announcements: a.announcements.slice(0, 3), meetings: m.meetings.filter((x) => x.status === 'scheduled').slice(0, 3) };
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <h2 style={{ fontSize: 24, marginBottom: 2 }}>
        {greeting}, {user?.name.split(' ')[0]}
      </h2>
      <p className="muted" style={{ marginBottom: 18 }}>
        {isAdmin ? `Here's what's happening ${user?.role === 'manager' ? `at ${user.company_name}` : 'with your team'}.` : "Here's what you need to know today."}
      </p>

      <div className="grid-3">
        <div className={`stat ${(isAdmin ? dashboard?.announcementsAwaitingReads : dashboard?.unreadAnnouncements) ? 'hot' : ''}`} onClick={() => go('announcements')}>
          <div className="num">{(isAdmin ? dashboard?.announcementsAwaitingReads : dashboard?.unreadAnnouncements) ?? '–'}</div>
          <div className="lbl">Unread announcements</div>
        </div>
        <div className={`stat ${dashboard?.upcomingMeetings ? 'hot' : ''}`} onClick={() => go('meetings')}>
          <div className="num">{dashboard?.upcomingMeetings ?? '–'}</div>
          <div className="lbl">Upcoming meetings</div>
        </div>
        {isAdmin ? (
          <div className="stat" onClick={() => go('people')}>
            <div className="num">{dashboard?.employees ?? '–'}</div>
            <div className="lbl">{user?.role === 'manager' ? `People at ${user.company_name}` : `Employees in ${dashboard?.companies ?? '–'} ${dashboard?.companies === 1 ? 'company' : 'companies'}`}</div>
          </div>
        ) : (
          <div className={`stat ${dashboard?.pendingRsvps ? 'hot' : ''}`} onClick={() => go('meetings')}>
            <div className="num">{dashboard?.pendingRsvps ?? '–'}</div>
            <div className="lbl">Meetings awaiting reply</div>
          </div>
        )}
      </div>

      {isAdmin && !!dashboard?.drafts && (
        <p className="small muted" style={{ marginTop: 10 }}>You have {dashboard.drafts} unpublished draft{dashboard.drafts === 1 ? '' : 's'} — open Announcements → Drafts.</p>
      )}

      {loading && <Spinner />}

      {data && (
        <>
          <div className="row between" style={{ marginTop: 24, marginBottom: 10 }}>
            <div className="section-title" style={{ margin: 0 }}>Latest announcements</div>
            <button className="btn ghost sm" onClick={() => go('announcements')}>See all</button>
          </div>
          {data.announcements.length === 0 && <p className="muted small">No announcements yet.</p>}
          {data.announcements.map((a: Announcement) => (
            <div key={a.id} className={`card clickable ${!a.read_by_me && !isAdmin ? 'unread' : ''}`} onClick={() => go('announcements', { type: 'announcement', id: a.id })}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="avatar"><MegaphoneIcon style={{ width: 18, height: 18 }} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="title">{a.title}</span>
                    <PriorityChip priority={a.priority} />
                  </div>
                  <div className="tiny muted">{a.author_name} · {timeAgo(a.created_at)}{isAdmin && ` · ${a.read_count}/${a.audience_count} read`}</div>
                </div>
              </div>
            </div>
          ))}

          <div className="row between" style={{ marginTop: 24, marginBottom: 10 }}>
            <div className="section-title" style={{ margin: 0 }}>Next meetings</div>
            <button className="btn ghost sm" onClick={() => go('meetings')}>See all</button>
          </div>
          {data.meetings.length === 0 && <p className="muted small">No upcoming meetings.</p>}
          {data.meetings.map((m: Meeting) => (
            <div key={m.id} className="card clickable" onClick={() => go('meetings', { type: 'meeting', id: m.id })}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="avatar"><CalendarIcon style={{ width: 18, height: 18 }} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="title">{m.title}</div>
                  <div className="tiny muted">{formatDateTime(m.starts_at)}{m.location ? ` · ${m.location}` : ''}</div>
                </div>
                {!isAdmin && (
                  <span className={`chip ${m.my_rsvp === 'going' ? 'ok' : m.my_rsvp === 'maybe' ? 'warn' : m.my_rsvp === 'declined' ? 'danger' : 'primary'}`}>
                    {m.my_rsvp ? m.my_rsvp[0].toUpperCase() + m.my_rsvp.slice(1) : 'Reply'}
                  </span>
                )}
                {isAdmin && <span className="chip ok">{m.going_count} going</span>}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
