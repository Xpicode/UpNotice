// End-to-end smoke test. `npm test` starts a private server for it (see run-api.mjs); to run it against a server of your own: API_URL=http://localhost:4000 node test/api.test.js
const BASE = process.env.API_URL || 'http://localhost:4000';
let failures = 0;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

const health = await call('GET', '/api/health');
check('health endpoint', health.json.ok === true);
check('health does not leak mail configuration', health.json.mail === undefined);
const headers = await fetch(BASE + '/api/health');
check(
  'security headers present',
  !!headers.headers.get('content-security-policy') && headers.headers.get('x-content-type-options') === 'nosniff' && headers.headers.get('x-frame-options') !== null
);

const bad = await call('POST', '/api/auth/login', { email: 'admin@company.com', password: 'wrong' });
check('wrong password rejected', bad.status === 401);

const admin = await call('POST', '/api/auth/login', { email: 'admin@company.com', password: 'admin123' });
check('admin login', admin.status === 200 && admin.json.user.role === 'admin');
let at = admin.json.token;
check('login returns a refresh token and expiry', typeof admin.json.refresh_token === 'string' && admin.json.expires_in > 0);

// ---- sessions: refresh, rotation, logout ----
const refreshed = await call('POST', '/api/auth/refresh', { refresh_token: admin.json.refresh_token });
check('refresh token gives a new access token', refreshed.status === 200 && typeof refreshed.json.token === 'string' && refreshed.json.refresh_token !== admin.json.refresh_token);
const reuse = await call('POST', '/api/auth/refresh', { refresh_token: admin.json.refresh_token });
check('old refresh token is dead after rotation', reuse.status === 401);
const meOld = await call('GET', '/api/auth/me', null, at);
check('old access token still works until expiry', meOld.status === 200);
at = refreshed.json.token;
const throwaway = await call('POST', '/api/auth/login', { email: 'admin@company.com', password: 'admin123' });
const out = await call('POST', '/api/auth/logout', null, throwaway.json.token);
check('logout revokes the session', out.status === 200 && (await call('GET', '/api/auth/me', null, throwaway.json.token)).status === 401);
const noQueryToken = await fetch(BASE + '/api/auth/me?token=' + encodeURIComponent(at));
check('tokens in the URL are not accepted', noQueryToken.status === 401);
const sessions = await call('GET', '/api/auth/sessions', null, at);
check('sessions list shows the current session', sessions.status === 200 && sessions.json.sessions.some((x) => x.current));

const emp = await call('POST', '/api/auth/login', { email: 'maria@company.com', password: 'password' });
check('employee login', emp.status === 200 && emp.json.user.role === 'employee');
const et = emp.json.token;
check('employee has company', !!emp.json.user.company_name);

const ben = await call('POST', '/api/auth/login', { email: 'ben@company.com', password: 'password' });
const bt = ben.json.token;

// ---- companies & departments ----
const companies = await call('GET', '/api/companies', null, et);
check('companies listed', companies.json.companies.length >= 2);
const upright = companies.json.companies.find((c) => c.name === 'Upright Solutions');
const sixth = companies.json.companies.find((c) => c.name === 'SixthGear');

const newCo = await call('POST', '/api/companies', { name: 'Test Co' }, at);
check('admin creates company', newCo.status === 201, JSON.stringify(newCo.json));
const testCoId = newCo.json.company?.id;
const dupCo = await call('POST', '/api/companies', { name: 'Test Co' }, at);
check('duplicate company rejected', dupCo.status === 409);

const depts = await call('GET', '/api/departments', null, et);
check(
  'departments carry company',
  depts.json.departments.every((d) => d.company_id)
);
const opsId = depts.json.departments.find((d) => d.name === 'Operations').id;
const salesId = depts.json.departments.find((d) => d.name === 'Sales').id;

const newDept = await call('POST', '/api/departments', { name: 'Finance', company_id: testCoId }, at);
check('admin creates department in company', newDept.status === 201, JSON.stringify(newDept.json));
const noCoDept = await call('POST', '/api/departments', { name: 'Nowhere' }, at);
check('department without company rejected', noCoDept.status === 400);
const sameName = await call('POST', '/api/departments', { name: 'Operations', company_id: testCoId }, at);
check('same department name allowed in a different company', sameName.status === 201);

// ---- announcements ----
const forbidden = await call('POST', '/api/announcements', { title: 'x', body: 'y' }, et);
check('employee cannot post announcement', forbidden.status === 403);

const wrongDept = await call('POST', '/api/announcements', { title: 'x', body: 'y', company_id: sixth.id, department_ids: [opsId] }, at);
check('department from another company rejected', wrongDept.status === 400);

const created = await call(
  'POST',
  '/api/announcements',
  {
    title: 'Test announcement',
    body: 'Hello sales team',
    priority: 'important',
    company_id: upright.id,
    department_ids: [salesId],
  },
  at
);
check('admin posts department-targeted announcement', created.status === 201, JSON.stringify(created.json));
const annId = created.json.announcement?.id;

const empList = await call('GET', '/api/announcements', null, et);
check('ops employee does not see sales-only announcement', !empList.json.announcements.some((a) => a.id === annId));

const coOnly = await call('POST', '/api/announcements', { title: 'SixthGear only', body: 'Shop staff', company_id: sixth.id }, at);
const coId = coOnly.json.announcement.id;
const empList1 = await call('GET', '/api/announcements', null, et);
check('Upright employee does not see SixthGear announcement', !empList1.json.announcements.some((a) => a.id === coId));
const benList = await call('GET', '/api/announcements', null, bt);
check(
  'SixthGear employee sees SixthGear announcement',
  benList.json.announcements.some((a) => a.id === coId)
);
check('SixthGear-only audience count is 1', coOnly.json.announcement.audience_count === 1, String(coOnly.json.announcement.audience_count));

const everyone = await call('POST', '/api/announcements', { title: 'For everyone', body: 'All staff please read', priority: 'urgent' }, at);
const allId = everyone.json.announcement.id;
check('all-companies audience counts every employee', everyone.json.announcement.audience_count === 4, String(everyone.json.announcement.audience_count));
const empList2 = await call('GET', '/api/announcements', null, et);
const item = empList2.json.announcements.find((a) => a.id === allId);
check('employee sees all-companies announcement, unread', item && item.read_by_me === false);

const read = await call('POST', `/api/announcements/${allId}/read`, null, et);
check('employee marks as read', read.json.ok === true);
const detail = await call('GET', `/api/announcements/${allId}`, null, at);
check(
  'admin sees read receipt',
  detail.json.announcement.readers.some((r) => r.email === 'maria@company.com')
);

const notifs = await call('GET', '/api/notifications', null, et);
check(
  'employee received notification for new announcement',
  notifs.json.notifications.some((n) => n.ref_id === allId && n.type === 'announcement')
);

// ---- meetings ----
const start = new Date(Date.now() + 86400000).toISOString();
const end = new Date(Date.now() + 90000000).toISOString();
const badMeeting = await call('POST', '/api/meetings', { title: 'Bad', starts_at: end, ends_at: start }, at);
check('meeting with end before start rejected', badMeeting.status === 400);

const meeting = await call(
  'POST',
  '/api/meetings',
  {
    title: 'Ops sync',
    description: 'Weekly sync',
    starts_at: start,
    ends_at: end,
    location: 'Room 2',
    company_id: upright.id,
    department_ids: [opsId],
  },
  at
);
check('admin schedules meeting', meeting.status === 201, JSON.stringify(meeting.json));
const mId = meeting.json.meeting?.id;
const benMeet = await call('GET', `/api/meetings/${mId}`, null, bt);
check('other-company employee cannot open the meeting', benMeet.status === 404);

const noReason = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'declined' }, et);
check("can't-go without a reason is rejected", noReason.status === 400);
const withReason = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'maybe', note: 'Client visit may run late' }, et);
check('maybe with a reason accepted', withReason.json.ok === true && withReason.json.note === 'Client visit may run late');
const mDetail0 = await call('GET', `/api/meetings/${mId}`, null, at);
check(
  'admin sees the reason',
  mDetail0.json.meeting.attendees.some((a) => a.email === 'maria@company.com' && a.note === 'Client visit may run late')
);
const rsvp = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'going' }, et);
check('employee changes RSVP to going', rsvp.json.ok === true);
const mDetail = await call('GET', `/api/meetings/${mId}`, null, at);
check(
  'admin sees RSVP',
  mDetail.json.meeting.attendees.some((a) => a.email === 'maria@company.com' && a.status === 'going' && a.note === '')
);
check('going count is 1', mDetail.json.meeting.going_count === 1);

const cancel = await call('PATCH', `/api/meetings/${mId}`, { status: 'cancelled' }, at);
check('admin cancels meeting', cancel.json.ok === true);
const rsvpAfter = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'going' }, et);
check('cannot RSVP to cancelled meeting', rsvpAfter.status === 400);

const dash = await call('GET', '/api/dashboard', null, et);
check('dashboard works for employee', typeof dash.json.unreadAnnouncements === 'number');

// ---- users ----
const noCompany = await call('POST', '/api/users', { name: 'No Co', email: 'noco@company.com', password: 'Secret-123' }, at);
check('employee without company rejected', noCompany.status === 400);
const newUser = await call('POST', '/api/users', { name: 'Test User', email: 'test@company.com', password: 'Secret-123', company_id: upright.id, department_id: salesId }, at);
check('admin creates user', newUser.status === 201, JSON.stringify(newUser.json));
const mismatch = await call('POST', '/api/users', { name: 'Mismatch', email: 'mm@company.com', password: 'Secret-123', company_id: sixth.id, department_id: salesId }, at);
check('user with department from another company rejected', mismatch.status === 400);
const dup = await call('POST', '/api/users', { name: 'Dup', email: 'test@company.com', password: 'Secret-123', company_id: upright.id }, at);
check('duplicate email rejected', dup.status === 409);

// ---- v3 features ----
async function multipart(path, fields, files, token) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const f of files) fd.append(f.field, new Blob([f.content], { type: f.type }), f.name);
  const res = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// attachments + poll + acknowledgement in one announcement
const rich = await multipart(
  '/api/announcements',
  {
    title: 'Holiday schedule',
    body: 'See attached memo and vote for the party date.',
    priority: 'important',
    ack_required: 'true',
    poll_question: 'Which date for the party?',
    poll_options: ['Dec 15', 'Dec 22'],
  },
  [
    { field: 'files', name: 'memo.txt', type: 'text/plain', content: 'Memo contents' },
    { field: 'files', name: 'pic.png', type: 'image/png', content: PNG_BYTES },
  ],
  at
);
check(
  'announcement with attachments + poll + ack created',
  rich.status === 201 && rich.json.announcement.attachments.length === 2 && rich.json.announcement.poll.options.length === 2,
  JSON.stringify(rich.json)
);
const richId = rich.json.announcement.id;
const fileId = rich.json.announcement.attachments[0].id;
const fileRes = await fetch(`${BASE}/api/announcements/${richId}/files/${fileId}`, { headers: { Authorization: `Bearer ${et}` } });
check('employee downloads attachment', fileRes.status === 200 && (await fileRes.text()) === 'Memo contents');
const badType = await multipart('/api/announcements', { title: 'x', body: 'y' }, [{ field: 'files', name: 'a.exe', type: 'application/x-msdownload', content: 'x' }], at);
check('disallowed file type rejected', badType.status === 400);
const liar = await multipart('/api/announcements', { title: 'x', body: 'y' }, [{ field: 'files', name: 'evil.png', type: 'image/png', content: '<script>alert(1)</script>' }], at);
check('file whose bytes do not match its type is rejected', liar.status === 400, JSON.stringify(liar.json));
const ticket = await call('POST', '/api/auth/ticket', { path: `/api/announcements/${richId}/files/${fileId}` }, et);
check('download ticket issued', ticket.status === 200 && /ticket=/.test(ticket.json.url));
const viaTicket = await fetch(BASE + ticket.json.url);
check(
  'attachment opens with the ticket (no header)',
  viaTicket.status === 200 && (await viaTicket.text()) === 'Memo contents' && viaTicket.headers.get('x-content-type-options') === 'nosniff'
);
const wrongPath = await fetch(BASE + ticket.json.url.replace(`/files/${fileId}`, '/files/999999'));
check('ticket is bound to one path', wrongPath.status === 401);
const svg = await multipart('/api/auth/avatar', {}, [{ field: 'photo', name: 'me.svg', type: 'image/svg+xml', content: '<svg onload="alert(1)"/>' }], et);
check('SVG profile photo rejected', svg.status === 400);

const vote = await call('POST', `/api/announcements/${richId}/vote`, { option_id: rich.json.announcement.poll.options[1].id }, et);
check('employee votes in poll', vote.json.ok === true && vote.json.poll.my_vote === rich.json.announcement.poll.options[1].id);
const ack = await call('POST', `/api/announcements/${richId}/acknowledge`, null, et);
check('employee acknowledges', ack.json.ok === true);
const richDetail = await call('GET', `/api/announcements/${richId}`, null, at);
check(
  'admin sees ack + poll answer',
  richDetail.json.announcement.readers.some((r) => r.email === 'maria@company.com' && r.acknowledged_at && r.poll_answer === 'Dec 22')
);
check('poll totals', richDetail.json.announcement.poll.total === 1 && richDetail.json.announcement.ack_count === 1);

// scheduled + expiring
const future = new Date(Date.now() + 3600000).toISOString();
const sched = await call('POST', '/api/announcements', { title: 'Later', body: 'Scheduled', publish_at: future }, at);
check('scheduled announcement created with status scheduled', sched.status === 201 && sched.json.announcement.status === 'scheduled');
const schedId = sched.json.announcement.id;
const empSched = await call('GET', '/api/announcements', null, et);
check('employee does not see scheduled announcement yet', !empSched.json.announcements.some((a) => a.id === schedId));
const empSchedDetail = await call('GET', `/api/announcements/${schedId}`, null, et);
check('scheduled announcement detail hidden from employee', empSchedDetail.status === 404);
const notifBefore = (await call('GET', '/api/notifications', null, et)).json.notifications.some((n) => n.ref_id === schedId);
check('no notification before publish time', !notifBefore);
const publishNow = await call('PATCH', `/api/announcements/${schedId}`, { publish_at: new Date(Date.now() - 1000).toISOString() }, at);
check('admin moves publish time to now', publishNow.json.ok === true);
const notifAfter = (await call('GET', '/api/notifications', null, et)).json.notifications.some((n) => n.ref_id === schedId);
check('notification sent once published', notifAfter);
const expired = await call('POST', '/api/announcements', { title: 'Old', body: 'Expired', expires_at: new Date(Date.now() - 1000).toISOString() }, at);
const expEmp = await call('GET', '/api/announcements', null, et);
check('expired announcement hidden from employee', !expEmp.json.announcements.some((a) => a.id === expired.json.announcement.id));
check('admin sees it as expired', expired.json.announcement.status === 'expired');

// comments
const c1 = await call('POST', `/api/comments/announcement/${richId}`, { body: 'Can we do Dec 22?' }, et);
check('employee comments', c1.status === 201);
const adminNotif = (await call('GET', '/api/notifications', null, at)).json.notifications.some((n) => n.title.includes('commented'));
check('admin notified of comment', adminNotif);
const c2 = await call('POST', `/api/comments/announcement/${richId}`, { body: 'Yes, noted.' }, at);
check('admin replies', c2.status === 201);
const thread = await call('GET', `/api/comments/announcement/${richId}`, null, et);
check('thread has 2 comments in order', thread.json.comments.length === 2 && thread.json.comments[0].mine === true);
const benComment = await call('POST', `/api/comments/announcement/${annId}`, { body: 'hi' }, bt);
check('cannot comment on announcement you cannot see', benComment.status === 404);
const delOther = await call('DELETE', `/api/comments/${c2.json.id}`, null, et);
check("employee can't delete admin's comment", delOther.status === 403);

// recurring meetings
const rs = new Date(Date.now() + 2 * 86400000).toISOString();
const re = new Date(Date.now() + 2 * 86400000 + 3600000).toISOString();
const series = await call('POST', '/api/meetings', { title: 'Weekly standup', starts_at: rs, ends_at: re, recurrence: 'weekly', occurrences: 4, company_id: upright.id }, at);
check('recurring meeting creates 4 occurrences', series.status === 201 && series.json.created === 4, JSON.stringify(series.json));
const allMeet = await call('GET', '/api/meetings?scope=upcoming', null, at);
const occ = allMeet.json.meetings.filter((m) => m.title === 'Weekly standup');
check('4 standups listed with the same series', occ.length === 4 && new Set(occ.map((m) => m.series_id)).size === 1);
const delSeries = await call('DELETE', `/api/meetings/${occ[1].id}?series=future`, null, at);
check('delete this and future occurrences', delSeries.json.ok === true);
const afterDel = (await call('GET', '/api/meetings?scope=upcoming', null, at)).json.meetings.filter((m) => m.title === 'Weekly standup');
check('only the first occurrence remains', afterDel.length === 1);

// meeting reminder (starts in 30 min)
const soon = await call(
  'POST',
  '/api/meetings',
  { title: 'Soon', starts_at: new Date(Date.now() + 30 * 60000).toISOString(), ends_at: new Date(Date.now() + 60 * 60000).toISOString(), company_id: upright.id },
  at
);
// the scheduler runs every minute; poke it by waiting for the next tick is too slow, so call the endpoint that the scheduler uses indirectly:
await new Promise((r) => setTimeout(r, 200));
const remindersLater = await call('GET', '/api/notifications', null, et);
check(
  'meeting invite for "Soon" received',
  remindersLater.json.notifications.some((n) => n.ref_id === soon.json.meeting.id)
);

// ---- attendance check-in: the window, and the prompt the employee is shown ----
const nowMeet = await call(
  'POST',
  '/api/meetings',
  { title: 'Happening now', starts_at: new Date(Date.now() - 5 * 60000).toISOString(), ends_at: new Date(Date.now() + 55 * 60000).toISOString(), company_id: upright.id },
  at
);
check('meeting that is running now', nowMeet.status === 201, JSON.stringify(nowMeet.json));
const nowId = nowMeet.json.meeting.id;
const nowAdmin = await call('GET', `/api/meetings/${nowId}`, null, at);
const nowCode = nowAdmin.json.meeting.checkin_code;
check('organizer gets a check-in code', typeof nowCode === 'string' && nowCode.length >= 4);
const nowEmp = await call('GET', `/api/meetings/${nowId}`, null, et);
check(
  'the check-in window is sent to the employee',
  Date.parse(nowEmp.json.meeting.checkin_opens_at) === Date.parse(nowEmp.json.meeting.starts_at) - 5 * 60000 &&
    Date.parse(nowEmp.json.meeting.checkin_closes_at) === Date.parse(nowEmp.json.meeting.ends_at) + 120 * 60000
);
check('the window is open right now', Date.now() >= Date.parse(nowEmp.json.meeting.checkin_opens_at) && Date.now() <= Date.parse(nowEmp.json.meeting.checkin_closes_at));
const dashOpen = await call('GET', '/api/dashboard', null, et);
check('employee dashboard offers the check-in', dashOpen.json.openCheckIn?.id === nowId, JSON.stringify(dashOpen.json.openCheckIn));
const dashAdmin = await call('GET', '/api/dashboard', null, at);
check('the organizer is not asked to check in', dashAdmin.json.openCheckIn === undefined);
// ---- the joining link has to be a real web address ----
const badLink = await call('POST', '/api/meetings', { title: 'Bad link', starts_at: start, ends_at: end, link: 'javascript:alert(document.cookie)', company_id: upright.id }, at);
check('a javascript: link is rejected', badLink.status === 400 && /http/.test(badLink.json.error), JSON.stringify(badLink.json));
const notAUrl = await call('POST', '/api/meetings', { title: 'Bad link', starts_at: start, ends_at: end, link: 'meet.example.com/room', company_id: upright.id }, at);
check('a link without a scheme is rejected', notAUrl.status === 400);
const goodLink = await call(
  'POST',
  '/api/meetings',
  { title: 'Room link', starts_at: start, ends_at: end, link: 'https://meet.jit.si/UpNotice-Room-link-9f2a', company_id: upright.id },
  at
);
check('an https link is accepted', goodLink.status === 201, JSON.stringify(goodLink.json));
const patchBad = await call('PATCH', `/api/meetings/${goodLink.json.meeting.id}`, { link: 'data:text/html,<script>1</script>' }, at);
check('and it cannot be swapped for a bad one later', patchBad.status === 400);
await call('DELETE', `/api/meetings/${goodLink.json.meeting.id}`, null, at);

// ---- the joining link is only handed over once the check-in is approved ----
const linkMeet = await call(
  'POST',
  '/api/meetings',
  {
    title: 'Online catch-up',
    starts_at: new Date(Date.now() - 2 * 60000).toISOString(),
    ends_at: new Date(Date.now() + 58 * 60000).toISOString(),
    link: 'https://meet.example.com/secret-room',
    company_id: upright.id,
  },
  at
);
const linkId = linkMeet.json.meeting.id;
const linkOrganizer = await call('GET', `/api/meetings/${linkId}`, null, at);
check('the organizer always has the link', linkOrganizer.json.meeting.link === 'https://meet.example.com/secret-room');
const linkBefore = await call('GET', `/api/meetings/${linkId}`, null, et);
check('the link is withheld before the check-in is approved', linkBefore.json.meeting.link === '' && linkBefore.json.meeting.has_link === true);
const linkList = await call('GET', '/api/meetings?scope=upcoming', null, et);
check('and it is withheld in the list as well', linkList.json.meetings.find((m) => m.id === linkId)?.link === '');
const icsBefore = await (await fetch(`${BASE}/api/meetings/${linkId}/ics`, { headers: { Authorization: `Bearer ${et}` } })).text();
check('the calendar file does not leak it either', !icsBefore.includes('secret-room'), icsBefore.slice(0, 200));
await call('POST', `/api/meetings/${linkId}/checkin-request`, null, et);
const linkPending = await call('GET', `/api/meetings/${linkId}`, null, et);
check('waiting for approval is not enough', linkPending.json.meeting.link === '' && linkPending.json.meeting.my_checkin === 'pending');
await call('POST', `/api/meetings/${linkId}/attendance/decide`, { user_ids: [emp.json.user.id], approve: true }, at);
const linkAfter = await call('GET', `/api/meetings/${linkId}`, null, et);
check('approving hands over the link', linkAfter.json.meeting.link === 'https://meet.example.com/secret-room', JSON.stringify(linkAfter.json.meeting.link));
const icsAfter = await (await fetch(`${BASE}/api/meetings/${linkId}/ics`, { headers: { Authorization: `Bearer ${et}` } })).text();
check('and the calendar file carries it too', icsAfter.includes('secret-room'));
await call('DELETE', `/api/meetings/${linkId}`, null, at);

// ---- the button: the attendee asks, the organizer decides ----
const askedOwn = await call('POST', `/api/meetings/${nowId}/checkin-request`, null, at);
check('the organizer cannot check in to their own meeting', askedOwn.status === 400);
const asked = await call('POST', `/api/meetings/${nowId}/checkin-request`, null, et);
check('employee taps check in', asked.json.status === 'pending', JSON.stringify(asked.json));
const askedTwice = await call('POST', `/api/meetings/${nowId}/checkin-request`, null, et);
check('asking twice changes nothing', askedTwice.json.status === 'pending');
const pendingEmp = await call('GET', `/api/meetings/${nowId}`, null, et);
check('waiting is not the same as present', pendingEmp.json.meeting.my_checkin === 'pending' && pendingEmp.json.meeting.attended_by_me === false);
check('a waiting check-in is not counted as attendance', pendingEmp.json.meeting.attended_count === 0 && pendingEmp.json.meeting.pending_count === 1);
const dashPending = await call('GET', '/api/dashboard', null, et);
check('the strip turns into "waiting" for the employee', dashPending.json.openCheckIn?.id === nowId && dashPending.json.openCheckIn?.my_checkin === 'pending');
const dashOrganizer = await call('GET', '/api/dashboard', null, at);
check(
  'the organizer is told someone is waiting',
  dashOrganizer.json.pendingApprovals >= 1 && dashOrganizer.json.pendingApprovalsMeetingId === nowId,
  JSON.stringify(dashOrganizer.json)
);
const organizerView = await call('GET', `/api/meetings/${nowId}`, null, at);
check(
  'the organizer sees who is waiting',
  organizerView.json.meeting.attendees.some((a) => a.email === 'maria@company.com' && a.checkin_status === 'pending' && a.attended_at == null)
);
const empApprove = await call('POST', `/api/meetings/${nowId}/attendance/decide`, { user_ids: [emp.json.user.id], approve: true }, et);
check('an employee cannot approve check-ins', empApprove.status === 403);
const declined = await call('POST', `/api/meetings/${nowId}/attendance/decide`, { user_ids: [emp.json.user.id], approve: false }, at);
check('the organizer turns a check-in down', declined.json.decided === 1, JSON.stringify(declined.json));
const afterDecline = await call('GET', `/api/meetings/${nowId}`, null, et);
check('a refused check-in can be asked again', afterDecline.json.meeting.my_checkin === 'none');
await call('POST', `/api/meetings/${nowId}/checkin-request`, null, et);
const approved = await call('POST', `/api/meetings/${nowId}/attendance/decide`, { user_ids: [emp.json.user.id], approve: true }, at);
check('the organizer approves the check-in', approved.json.decided === 1, JSON.stringify(approved.json));
const afterApprove = await call('GET', `/api/meetings/${nowId}`, null, et);
check('approving marks the person present', afterApprove.json.meeting.my_checkin === 'approved' && afterApprove.json.meeting.attended_by_me === true);
check('and it counts once the organizer says so', afterApprove.json.meeting.attended_count === 1 && afterApprove.json.meeting.pending_count === 0);
const decideAgain = await call('POST', `/api/meetings/${nowId}/attendance/decide`, { user_ids: [emp.json.user.id], approve: false }, at);
check('an approved check-in cannot be undone by the queue', decideAgain.json.decided === 0);
const dashCleared = await call('GET', '/api/dashboard', null, at);
check('the organizer prompt clears once everyone is decided', !dashCleared.json.pendingApprovals);

const badCheckin = await call('POST', `/api/meetings/${nowId}/checkin`, { code: 'ZZZZZZ' }, et);
check('wrong check-in code refused', badCheckin.status === 400);
const goodCode = await call('POST', `/api/meetings/${nowId}/checkin`, { code: nowCode }, et);
check('employee checks in with the code', goodCode.json.ok === true, JSON.stringify(goodCode.json));
const dashDone = await call('GET', '/api/dashboard', null, et);
// It moves on to the next meeting whose window is open, if there is one — it just stops asking about this one.
check('the prompt stops asking about a meeting already checked in to', dashDone.json.openCheckIn?.id !== nowId);
const nowAfter = await call('GET', `/api/meetings/${nowId}`, null, et);
check('the employee is marked as attended', nowAfter.json.meeting.attended_by_me === true);
const earlyCheckin = await call('POST', `/api/meetings/${afterDel[0].id}/checkin`, { code: 'ABCDEF' }, et);
check('check-in is closed outside the meeting window', earlyCheckin.status === 400 && /around the meeting time|Wrong check-in/.test(earlyCheckin.json.error));

// The window opens 5 minutes before the start, not earlier: a meeting 20 minutes away is still shut.
const notYet = await call(
  'POST',
  '/api/meetings',
  { title: 'Twenty minutes away', starts_at: new Date(Date.now() + 20 * 60000).toISOString(), ends_at: new Date(Date.now() + 80 * 60000).toISOString(), company_id: upright.id },
  at
);
const notYetId = notYet.json.meeting.id;
const notYetCode = (await call('GET', `/api/meetings/${notYetId}`, null, at)).json.meeting.checkin_code;
const tooEarlyWindow = await call('POST', `/api/meetings/${notYetId}/checkin`, { code: notYetCode }, et);
check(
  'the right code is still refused 20 minutes before the start',
  tooEarlyWindow.status === 400 && /around the meeting time/.test(tooEarlyWindow.json.error),
  JSON.stringify(tooEarlyWindow.json)
);
const dashNotYet = await call('GET', '/api/dashboard', null, et);
check('a meeting 20 minutes away is not offered for check-in', dashNotYet.json.openCheckIn?.id !== notYetId);

// Three minutes away is inside the window.
const almost = await call(
  'POST',
  '/api/meetings',
  { title: 'Three minutes away', starts_at: new Date(Date.now() + 3 * 60000).toISOString(), ends_at: new Date(Date.now() + 63 * 60000).toISOString(), company_id: upright.id },
  at
);
const almostId = almost.json.meeting.id;
const almostCode = (await call('GET', `/api/meetings/${almostId}`, null, at)).json.meeting.checkin_code;
const dashAlmost = await call('GET', '/api/dashboard', null, et);
check('a meeting 3 minutes away is offered for check-in', dashAlmost.json.openCheckIn?.id === almostId, JSON.stringify(dashAlmost.json.openCheckIn));
const earlyOk = await call('POST', `/api/meetings/${almostId}/checkin`, { code: almostCode }, et);
check('you can check in 3 minutes before the start', earlyOk.json.ok === true, JSON.stringify(earlyOk.json));

await call('DELETE', `/api/meetings/${nowId}`, null, at);
await call('DELETE', `/api/meetings/${notYetId}`, null, at);
await call('DELETE', `/api/meetings/${almostId}`, null, at);

// my history + avatar
const hist = await call('GET', '/api/auth/my-history', null, et);
check('employee history works', typeof hist.json.stats.invited === 'number' && Array.isArray(hist.json.meetings));
const av = await multipart('/api/auth/avatar', {}, [{ field: 'photo', name: 'me.png', type: 'image/png', content: PNG_BYTES }], et);
check('avatar uploaded', av.status === 200 && av.json.user.avatar_url, JSON.stringify(av.json));
const avGet = await fetch(`${BASE}${av.json.user.avatar_url}`, { headers: { Authorization: `Bearer ${at}` } });
check('avatar readable by others', avGet.status === 200);
await call('DELETE', '/api/auth/avatar', null, et);

// bulk import
const csvText =
  'Name,Email,Password,Company,Department,Role\nImport One,imp1@company.com,Secret-123,Upright Solutions,Operations,employee\nImport Two,imp2@company.com,,New Co,Finance,employee\nBad Row,,x,Upright Solutions,,employee\n';
const imp = await multipart('/api/users/import', {}, [{ field: 'file', name: 'people.csv', type: 'text/csv', content: csvText }], at);
check('import creates 2 users and skips 1', imp.json.created?.length === 2 && imp.json.skipped?.length === 1, JSON.stringify(imp.json));
check('import generated a password for the blank one', imp.json.created?.[1]?.password?.length >= 6);
check('import created new company + department', !!(await call('GET', '/api/companies', null, at)).json.companies.find((c) => c.name === 'New Co'));
const tpl = await fetch(`${BASE}/api/users/import-template`, { headers: { Authorization: `Bearer ${at}` } });
check('import template downloads', tpl.status === 200 && (tpl.headers.get('content-type') || '').includes('spreadsheet'));

// reports
const rep = await call('GET', '/api/reports/summary', null, at);
check('report summary has totals + employees', rep.json.totals.employees > 0 && rep.json.employees.some((e) => e.email === 'maria@company.com' && e.read > 0));
const csvRes = await fetch(`${BASE}/api/reports/export/employees.csv`, { headers: { Authorization: `Bearer ${at}` } });
check('employees CSV exports', csvRes.status === 200 && (await csvRes.text()).includes('maria@company.com'));
const repForbidden = await call('GET', '/api/reports/summary', null, et);
check('employee cannot open reports', repForbidden.status === 403);

// device registration
const dev = await call('POST', '/api/devices/register', { token: 'test-token-123', platform: 'android' }, et);
check('device token registered (push disabled is fine)', dev.json.ok === true);

// cleanup v3
const impIds = [];
for (const u of (await call('GET', '/api/users', null, at)).json.users) if (u.email.startsWith('imp')) impIds.push(u.id);
for (const id of impIds) await call('DELETE', `/api/users/${id}`, null, at);
const importedCo = (await call('GET', '/api/companies', null, at)).json.companies.find((c) => c.name === 'New Co');
if (importedCo) await call('DELETE', `/api/companies/${importedCo.id}`, null, at);
await call('DELETE', `/api/announcements/${richId}`, null, at);
await call('DELETE', `/api/announcements/${schedId}`, null, at);
await call('DELETE', `/api/announcements/${expired.json.announcement.id}`, null, at);
await call('DELETE', `/api/meetings/${afterDel[0]?.id}`, null, at);
await call('DELETE', `/api/meetings/${soon.json.meeting.id}`, null, at);

const delBusy = await call('DELETE', `/api/companies/${upright.id}`, null, at);
check('cannot delete a company that still has employees', delBusy.status === 400);

// ---------- v4: manager role ----------
const mgrCreate = await call(
  'POST',
  '/api/users',
  { name: 'Mia Manager', email: 'mia@company.com', password: 'Secret-123', role: 'manager', company_id: upright.id, department_id: opsId },
  at
);
check('admin creates a manager', mgrCreate.status === 201 && mgrCreate.json.user.role === 'manager', JSON.stringify(mgrCreate.json));
const mgrLogin = await call('POST', '/api/auth/login', { email: 'mia@company.com', password: 'Secret-123' });
check('new account must change its temporary password', mgrLogin.json.user.must_change_password === true);
const blocked = await call('GET', '/api/announcements', null, mgrLogin.json.token);
check('other endpoints are blocked until the password is changed', blocked.status === 403 && blocked.json.code === 'PASSWORD_CHANGE_REQUIRED');
const weak = await call('POST', '/api/auth/change-password', { currentPassword: 'Secret-123', newPassword: 'password' }, mgrLogin.json.token);
check('too-common password rejected', weak.status === 400);
const changed = await call('POST', '/api/auth/change-password', { currentPassword: 'Secret-123', newPassword: 'Mia-Manager-2026' }, mgrLogin.json.token);
check('manager sets a real password', changed.status === 200 && changed.json.user.must_change_password === false);
const mt = mgrLogin.json.token;
const mgrOwn = await call('POST', '/api/announcements', { title: 'Manager notice', body: 'For Upright only', company_id: upright.id }, mt);
check('manager posts to own company', mgrOwn.status === 201, JSON.stringify(mgrOwn.json));
const mgrOtherCo = await call('POST', '/api/announcements', { title: 'x', body: 'y', company_id: sixth.id }, mt);
check('manager cannot post to another company', mgrOtherCo.status === 400);
const mgrAll = await call('POST', '/api/announcements', { title: 'x', body: 'y' }, mt);
check('manager cannot post to all companies', mgrAll.status === 400);
const mgrEditOther = await call('PATCH', `/api/announcements/${coId}`, { title: 'hacked' }, mt);
check("manager cannot edit another company's announcement", mgrEditOther.status === 403);
const mgrUsers = await call('GET', '/api/users', null, mt);
check('manager sees only own company users', mgrUsers.status === 200 && mgrUsers.json.users.every((u) => u.company_id === upright.id));
const mgrAdminAttempt = await call('POST', '/api/users', { name: 'X', email: 'x1@company.com', password: 'Secret-123', role: 'admin' }, mt);
check('manager cannot create admins', mgrAdminAttempt.status === 403);
const mgrCompany = await call('POST', '/api/companies', { name: 'Nope Co' }, mt);
check('manager cannot create companies', mgrCompany.status === 403);
const mgrReport = await call('GET', '/api/reports/summary', null, mt);
check('manager gets a company-scoped report', mgrReport.status === 200 && mgrReport.json.employees.every((e) => e.company === 'Upright Solutions'));
const mgrMeeting = await call('POST', '/api/meetings', { title: 'Ops huddle', starts_at: start, ends_at: end, company_id: upright.id }, mt);
check('manager schedules a meeting for own company', mgrMeeting.status === 201, JSON.stringify(mgrMeeting.json));
const mgrDetail = await call('GET', `/api/meetings/${mgrMeeting.json.meeting.id}`, null, mt);
check('manager sees attendees + check-in code', Array.isArray(mgrDetail.json.meeting.attendees) && typeof mgrDetail.json.meeting.checkin_code === 'string');
const empDetail = await call('GET', `/api/meetings/${mgrMeeting.json.meeting.id}`, null, et);
check('employee does not get the check-in code', empDetail.status === 200 && empDetail.json.meeting.checkin_code === undefined);
const mgrActivity = await call('GET', '/api/activity', null, mt);
check('manager cannot read the activity log', mgrActivity.status === 403);

// ---------- v4: search, categories, filters ----------
const catAnn = await call('POST', '/api/announcements', { title: 'Fire drill Friday', body: 'Assemble at the parking lot', category: 'Safety', company_id: upright.id }, at);
check('announcement with category', catAnn.status === 201 && catAnn.json.announcement.category === 'Safety');
const search = await call('GET', '/api/announcements?q=fire%20drill', null, at);
check(
  'search finds by title',
  search.json.announcements.some((a) => a.id === catAnn.json.announcement.id) && search.json.announcements.every((a) => /fire drill|parking/i.test(a.title + a.body))
);
const byCat = await call('GET', '/api/announcements?category=safety', null, et);
check('filter by category (case-insensitive)', byCat.json.announcements.length >= 1 && byCat.json.announcements.every((a) => a.category === 'Safety'));
const cats = await call('GET', '/api/announcements/categories', null, et);
check('categories list includes defaults and used ones', cats.json.categories.includes('HR') && cats.json.categories.includes('Safety'));
const unreadOnly = await call('GET', '/api/announcements?unread=1', null, et);
check(
  'unread filter',
  unreadOnly.json.announcements.every((a) => a.read_by_me === false)
);
const meetSearch = await call('GET', '/api/meetings?q=huddle', null, at);
check('meeting search', meetSearch.json.meetings.length === 1 && meetSearch.json.meetings[0].title === 'Ops huddle');

// ---------- v4: drafts & templates ----------
const draft = await call('POST', '/api/announcements', { title: 'Draft only', body: '', draft: true, company_id: upright.id }, at);
check('save draft (empty body allowed)', draft.status === 201 && draft.json.announcement.status === 'draft', JSON.stringify(draft.json));
const draftId = draft.json.announcement.id;
const empSeesDraft = await call('GET', `/api/announcements/${draftId}`, null, et);
check('employee cannot see a draft', empSeesDraft.status === 404);
const notifsBeforePublish = (await call('GET', '/api/notifications', null, et)).json.notifications.filter((n) => n.ref_id === draftId).length;
const publish = await call('PATCH', `/api/announcements/${draftId}`, { body: 'Now published', draft: false }, at);
check('publish draft', publish.status === 200);
const afterPublish = await call('GET', `/api/announcements/${draftId}`, null, et);
check('employee sees it after publishing', afterPublish.status === 200 && afterPublish.json.announcement.status === 'live');
const notifsAfterPublish = (await call('GET', '/api/notifications', null, et)).json.notifications.filter((n) => n.ref_id === draftId).length;
check('publishing a draft notifies employees', notifsAfterPublish === notifsBeforePublish + 1);
const tplNew = await call(
  'POST',
  '/api/templates',
  { name: 'Holiday notice', title: 'Office closed', body: 'Enjoy the holiday', priority: 'important', category: 'HR', ack_required: true, poll_question: '', poll_options: [] },
  at
);
check('create template', tplNew.status === 201 && tplNew.json.template.ack_required === true, JSON.stringify(tplNew.json));
const tplList = await call('GET', '/api/templates', null, mt);
check(
  'manager sees shared templates',
  tplList.json.templates.some((t) => t.id === tplNew.json.template.id)
);
const tplEmp = await call('GET', '/api/templates', null, et);
check('employee cannot list templates', tplEmp.status === 403);
await call('DELETE', `/api/templates/${tplNew.json.template.id}`, null, at);

// ---------- v4: attendance & minutes ----------
const hid = mgrMeeting.json.meeting.id;
const mark = await call('POST', `/api/meetings/${hid}/attendance`, { user_id: emp.json.user.id, present: true }, mt);
check('staff marks attendance', mark.status === 200 && mark.json.attended === true, JSON.stringify(mark.json));
const afterMark = await call('GET', `/api/meetings/${hid}`, null, mt);
check('attendee shows as attended', afterMark.json.meeting.attendees.find((p) => p.id === emp.json.user.id)?.attended_at);
const unmark = await call('POST', `/api/meetings/${hid}/attendance`, { user_id: emp.json.user.id, present: false }, mt);
check('staff clears attendance', unmark.status === 200 && unmark.json.attended === false);
const wrongCode = await call('POST', `/api/meetings/${hid}/checkin`, { code: 'NOPE' }, et);
check('wrong check-in code rejected', wrongCode.status === 400);
const tooEarly = await call('POST', `/api/meetings/${hid}/checkin`, { code: mgrDetail.json.meeting.checkin_code }, et);
check('check-in closed long before the meeting', tooEarly.status === 400 && /only open/.test(tooEarly.json.error));
const soonMeeting = await call(
  'POST',
  '/api/meetings',
  { title: 'Now-ish', starts_at: new Date(Date.now() + 3 * 60000).toISOString(), ends_at: new Date(Date.now() + 63 * 60000).toISOString(), company_id: upright.id },
  at
);
const soonCode = (await call('GET', `/api/meetings/${soonMeeting.json.meeting.id}`, null, at)).json.meeting.checkin_code;
const selfCheck = await call('POST', `/api/meetings/${soonMeeting.json.meeting.id}/checkin`, { code: soonCode.toLowerCase() }, et);
check('employee self check-in with code', selfCheck.status === 200, JSON.stringify(selfCheck.json));
const selfSeen = await call('GET', `/api/meetings/${soonMeeting.json.meeting.id}`, null, et);
check('employee sees attended_by_me', selfSeen.json.meeting.attended_by_me === true);
const minutes = await call('PATCH', `/api/meetings/${soonMeeting.json.meeting.id}/minutes`, { minutes: 'Decided: new schedule starts Monday.' }, at);
check('staff saves minutes', minutes.status === 200);
const withMinutes = await call('GET', `/api/meetings/${soonMeeting.json.meeting.id}`, null, et);
check('employee reads minutes', withMinutes.json.meeting.minutes === 'Decided: new schedule starts Monday.' && withMinutes.json.meeting.has_minutes === true);
const minutesNotif = (await call('GET', '/api/notifications', null, et)).json.notifications.some((n) => /Minutes posted/.test(n.title));
check('minutes notification sent', minutesNotif);
const empMinutes = await call('PATCH', `/api/meetings/${soonMeeting.json.meeting.id}/minutes`, { minutes: 'x' }, et);
check('employee cannot write minutes', empMinutes.status === 403);
const ics = await fetch(`${BASE}/api/meetings/${soonMeeting.json.meeting.id}/ics`, { headers: { Authorization: `Bearer ${et}` } });
const icsText = await ics.text();
check('ICS calendar file', ics.status === 200 && /text\/calendar/.test(ics.headers.get('content-type')) && /BEGIN:VEVENT/.test(icsText) && /SUMMARY:Now-ish/.test(icsText));
const repAtt = await call('GET', '/api/reports/summary', null, at);
check('report counts attendance', repAtt.json.meetings.find((m) => m.id === soonMeeting.json.meeting.id)?.attended === 1);
await call('DELETE', `/api/meetings/${soonMeeting.json.meeting.id}`, null, at);

// ---------- v4: activity log, email prefs, password reset ----------
const act = await call('GET', '/api/activity?limit=50', null, at);
check(
  'activity log lists recent actions',
  act.status === 200 && act.json.activity.some((a) => a.action === 'meeting.minutes') && act.json.activity.some((a) => a.action === 'auth.login')
);
const actFilter = await call('GET', '/api/activity?action=announcement.', null, at);
check('activity filter by action', actFilter.json.activity.length > 0 && actFilter.json.activity.every((a) => a.action.startsWith('announcement.')));

// ---- deleting activity entries (admin only, and the deletion is itself logged) ----
const actBefore = await call('GET', '/api/activity?limit=50', null, at);
const victim = actBefore.json.activity[0];
const mgrDelete = await call('DELETE', `/api/activity/${victim.id}`, null, mt);
check('manager cannot delete activity entries', mgrDelete.status === 403);
const empDelete = await call('POST', '/api/activity/delete', { ids: [victim.id] }, et);
check('employee cannot delete activity entries', empDelete.status === 403);
const actDelOne = await call('DELETE', `/api/activity/${victim.id}`, null, at);
check('admin deletes one activity entry', actDelOne.status === 200 && actDelOne.json.deleted === 1);
const actDelGone = await call('DELETE', `/api/activity/${victim.id}`, null, at);
check('deleting a missing activity entry is a 404', actDelGone.status === 404);
const pair = actBefore.json.activity.slice(1, 3).map((a) => a.id);
const actDelMany = await call('POST', '/api/activity/delete', { ids: pair }, at);
check('admin deletes several activity entries at once', actDelMany.status === 200 && actDelMany.json.deleted === pair.length);
const actDelEmpty = await call('POST', '/api/activity/delete', { ids: [] }, at);
check('deleting with nothing selected is rejected', actDelEmpty.status === 400);
const actAfter = await call('GET', '/api/activity?limit=100', null, at);
check('deleted entries are gone', !actAfter.json.activity.some((a) => a.id === victim.id || pair.includes(a.id)));
check(
  'the deletion itself is recorded in the log',
  actAfter.json.activity.some((a) => a.action === 'activity.delete' && a.details.count === pair.length)
);
const prefOff = await call('PATCH', '/api/auth/me', { email_notifications: false }, et);
check('turn email notifications off', prefOff.status === 200 && prefOff.json.user.email_notifications === 0);
await call('PATCH', '/api/auth/me', { email_notifications: true }, et);
const forgot = await call('POST', '/api/auth/forgot', { email: 'maria@company.com' });
check('forgot password explains when email is not set up', forgot.status === 400 && /not set up/.test(forgot.json.error));
const badReset = await call('POST', '/api/auth/reset', { token: 'nope', password: 'Secret-123' });
check('invalid reset token rejected', badReset.status === 400);
const me2 = await call('GET', '/api/auth/me', null, at);
check('signed-in users can see the mail status', typeof me2.json.mail === 'string');

await call('DELETE', `/api/announcements/${catAnn.json.announcement.id}`, null, at);
await call('DELETE', `/api/announcements/${draftId}`, null, at);
await call('DELETE', `/api/announcements/${mgrOwn.json.announcement.id}`, null, at);
await call('DELETE', `/api/meetings/${hid}`, null, at);
await call('DELETE', `/api/users/${mgrCreate.json.user.id}`, null, at);

// notification delete / select-to-delete
const myNotifs = (await call('GET', '/api/notifications', null, et)).json.notifications;
check('employee has notifications to delete', myNotifs.length >= 3);
const [n1, n2, n3] = myNotifs;
const delOne = await call('DELETE', `/api/notifications/${n1.id}`, null, et);
check('delete one notification', delOne.status === 200 && delOne.json.deleted === 1);
const delOtherUser = await call('DELETE', `/api/notifications/${n2.id}`, null, at);
check("cannot delete another user's notification", delOtherUser.status === 404);
const delMany = await call('POST', '/api/notifications/delete', { ids: [n2.id, n3.id] }, et);
check('delete selected notifications', delMany.status === 200 && delMany.json.deleted === 2);
const delEmpty = await call('POST', '/api/notifications/delete', { ids: [] }, et);
check('delete with nothing selected is rejected', delEmpty.status === 400);
const afterNotifDel = (await call('GET', '/api/notifications', null, et)).json.notifications;
check('deleted notifications are gone', !afterNotifDel.some((n) => [n1.id, n2.id, n3.id].includes(n.id)));
if (afterNotifDel[0]) await call('POST', `/api/notifications/${afterNotifDel[0].id}/read`, null, et);
const delRead = await call('POST', '/api/notifications/delete', { read: true }, et);
check('clear read notifications', delRead.status === 200 && (await call('GET', '/api/notifications', null, et)).json.notifications.every((n) => !n.read_at));
const delAll = await call('POST', '/api/notifications/delete', { all: true }, et);
check('clear all notifications', delAll.status === 200 && (await call('GET', '/api/notifications', null, et)).json.notifications.length === 0);

// cleanup
await call('DELETE', `/api/announcements/${annId}`, null, at);
await call('DELETE', `/api/announcements/${allId}`, null, at);
await call('DELETE', `/api/announcements/${coId}`, null, at);
await call('DELETE', `/api/meetings/${mId}`, null, at);
await call('DELETE', `/api/users/${newUser.json.user?.id}`, null, at);
await call('DELETE', `/api/companies/${testCoId}`, null, at);

// ---- brute-force lockout ----
let lockStatus = 0;
for (let i = 0; i < 11; i++) lockStatus = (await call('POST', '/api/auth/login', { email: 'nobody@company.com', password: 'wrong-' + i })).status;
check('account locks after repeated wrong passwords', lockStatus === 429, String(lockStatus));
const actLocked = await call('GET', '/api/activity?action=auth.login_failed', null, at);
check('failed sign-ins are recorded in the activity log', actLocked.json.activity?.length > 0);

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
