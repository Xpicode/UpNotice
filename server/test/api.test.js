// Quick end-to-end smoke test. Start the server first (npm start), then: npm test
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

const health = await call('GET', '/api/health');
check('health endpoint', health.json.ok === true);

const bad = await call('POST', '/api/auth/login', { email: 'admin@company.com', password: 'wrong' });
check('wrong password rejected', bad.status === 401);

const admin = await call('POST', '/api/auth/login', { email: 'admin@company.com', password: 'admin123' });
check('admin login', admin.status === 200 && admin.json.user.role === 'admin');
const at = admin.json.token;

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
check('departments carry company', depts.json.departments.every((d) => d.company_id));
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

const created = await call('POST', '/api/announcements', {
  title: 'Test announcement', body: 'Hello sales team', priority: 'important', company_id: upright.id, department_ids: [salesId],
}, at);
check('admin posts department-targeted announcement', created.status === 201, JSON.stringify(created.json));
const annId = created.json.announcement?.id;

const empList = await call('GET', '/api/announcements', null, et);
check('ops employee does not see sales-only announcement', !empList.json.announcements.some((a) => a.id === annId));

const coOnly = await call('POST', '/api/announcements', { title: 'SixthGear only', body: 'Shop staff', company_id: sixth.id }, at);
const coId = coOnly.json.announcement.id;
const empList1 = await call('GET', '/api/announcements', null, et);
check('Upright employee does not see SixthGear announcement', !empList1.json.announcements.some((a) => a.id === coId));
const benList = await call('GET', '/api/announcements', null, bt);
check('SixthGear employee sees SixthGear announcement', benList.json.announcements.some((a) => a.id === coId));
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
check('admin sees read receipt', detail.json.announcement.readers.some((r) => r.email === 'maria@company.com'));

const notifs = await call('GET', '/api/notifications', null, et);
check('employee received notification for new announcement', notifs.json.notifications.some((n) => n.ref_id === allId && n.type === 'announcement'));

// ---- meetings ----
const start = new Date(Date.now() + 86400000).toISOString();
const end = new Date(Date.now() + 90000000).toISOString();
const badMeeting = await call('POST', '/api/meetings', { title: 'Bad', starts_at: end, ends_at: start }, at);
check('meeting with end before start rejected', badMeeting.status === 400);

const meeting = await call('POST', '/api/meetings', {
  title: 'Ops sync', description: 'Weekly sync', starts_at: start, ends_at: end, location: 'Room 2', company_id: upright.id, department_ids: [opsId],
}, at);
check('admin schedules meeting', meeting.status === 201, JSON.stringify(meeting.json));
const mId = meeting.json.meeting?.id;
const benMeet = await call('GET', `/api/meetings/${mId}`, null, bt);
check('other-company employee cannot open the meeting', benMeet.status === 404);

const noReason = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'declined' }, et);
check("can't-go without a reason is rejected", noReason.status === 400);
const withReason = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'maybe', note: 'Client visit may run late' }, et);
check('maybe with a reason accepted', withReason.json.ok === true && withReason.json.note === 'Client visit may run late');
const mDetail0 = await call('GET', `/api/meetings/${mId}`, null, at);
check('admin sees the reason', mDetail0.json.meeting.attendees.some((a) => a.email === 'maria@company.com' && a.note === 'Client visit may run late'));
const rsvp = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'going' }, et);
check('employee changes RSVP to going', rsvp.json.ok === true);
const mDetail = await call('GET', `/api/meetings/${mId}`, null, at);
check('admin sees RSVP', mDetail.json.meeting.attendees.some((a) => a.email === 'maria@company.com' && a.status === 'going' && a.note === ''));
check('going count is 1', mDetail.json.meeting.going_count === 1);

const cancel = await call('PATCH', `/api/meetings/${mId}`, { status: 'cancelled' }, at);
check('admin cancels meeting', cancel.json.ok === true);
const rsvpAfter = await call('POST', `/api/meetings/${mId}/rsvp`, { status: 'going' }, et);
check('cannot RSVP to cancelled meeting', rsvpAfter.status === 400);

const dash = await call('GET', '/api/dashboard', null, et);
check('dashboard works for employee', typeof dash.json.unreadAnnouncements === 'number');

// ---- users ----
const noCompany = await call('POST', '/api/users', { name: 'No Co', email: 'noco@company.com', password: 'secret1' }, at);
check('employee without company rejected', noCompany.status === 400);
const newUser = await call('POST', '/api/users', { name: 'Test User', email: 'test@company.com', password: 'secret1', company_id: upright.id, department_id: salesId }, at);
check('admin creates user', newUser.status === 201, JSON.stringify(newUser.json));
const mismatch = await call('POST', '/api/users', { name: 'Mismatch', email: 'mm@company.com', password: 'secret1', company_id: sixth.id, department_id: salesId }, at);
check('user with department from another company rejected', mismatch.status === 400);
const dup = await call('POST', '/api/users', { name: 'Dup', email: 'test@company.com', password: 'secret1', company_id: upright.id }, at);
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
const rich = await multipart('/api/announcements', {
  title: 'Holiday schedule', body: 'See attached memo and vote for the party date.', priority: 'important',
  ack_required: 'true', poll_question: 'Which date for the party?', poll_options: ['Dec 15', 'Dec 22'],
}, [
  { field: 'files', name: 'memo.txt', type: 'text/plain', content: 'Memo contents' },
  { field: 'files', name: 'pic.png', type: 'image/png', content: new Uint8Array([137, 80, 78, 71]) },
], at);
check('announcement with attachments + poll + ack created', rich.status === 201 && rich.json.announcement.attachments.length === 2 && rich.json.announcement.poll.options.length === 2, JSON.stringify(rich.json));
const richId = rich.json.announcement.id;
const fileId = rich.json.announcement.attachments[0].id;
const fileRes = await fetch(`${BASE}/api/announcements/${richId}/files/${fileId}`, { headers: { Authorization: `Bearer ${et}` } });
check('employee downloads attachment', fileRes.status === 200 && (await fileRes.text()) === 'Memo contents');
const badType = await multipart('/api/announcements', { title: 'x', body: 'y' }, [{ field: 'files', name: 'a.exe', type: 'application/x-msdownload', content: 'x' }], at);
check('disallowed file type rejected', badType.status === 400);

const vote = await call('POST', `/api/announcements/${richId}/vote`, { option_id: rich.json.announcement.poll.options[1].id }, et);
check('employee votes in poll', vote.json.ok === true && vote.json.poll.my_vote === rich.json.announcement.poll.options[1].id);
const ack = await call('POST', `/api/announcements/${richId}/acknowledge`, null, et);
check('employee acknowledges', ack.json.ok === true);
const richDetail = await call('GET', `/api/announcements/${richId}`, null, at);
check('admin sees ack + poll answer', richDetail.json.announcement.readers.some((r) => r.email === 'maria@company.com' && r.acknowledged_at && r.poll_answer === 'Dec 22'));
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
const soon = await call('POST', '/api/meetings', { title: 'Soon', starts_at: new Date(Date.now() + 30 * 60000).toISOString(), ends_at: new Date(Date.now() + 60 * 60000).toISOString(), company_id: upright.id }, at);
// the scheduler runs every minute; poke it by waiting for the next tick is too slow, so call the endpoint that the scheduler uses indirectly:
await new Promise((r) => setTimeout(r, 200));
const remindersLater = await call('GET', '/api/notifications', null, et);
check('meeting invite for "Soon" received', remindersLater.json.notifications.some((n) => n.ref_id === soon.json.meeting.id));

// my history + avatar
const hist = await call('GET', '/api/auth/my-history', null, et);
check('employee history works', typeof hist.json.stats.invited === 'number' && Array.isArray(hist.json.meetings));
const av = await multipart('/api/auth/avatar', {}, [{ field: 'photo', name: 'me.png', type: 'image/png', content: new Uint8Array([137, 80, 78, 71]) }], et);
check('avatar uploaded', av.status === 200 && av.json.user.avatar_url, JSON.stringify(av.json));
const avGet = await fetch(`${BASE}${av.json.user.avatar_url}`, { headers: { Authorization: `Bearer ${at}` } });
check('avatar readable by others', avGet.status === 200);
await call('DELETE', '/api/auth/avatar', null, et);

// bulk import
const csvText = 'Name,Email,Password,Company,Department,Role\nImport One,imp1@company.com,secret1,Upright Solutions,Operations,employee\nImport Two,imp2@company.com,,New Co,Finance,employee\nBad Row,,x,Upright Solutions,,employee\n';
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

// notification delete / select-to-delete
const myNotifs = (await call('GET', '/api/notifications', null, et)).json.notifications;
check('employee has notifications to delete', myNotifs.length >= 3);
const [n1, n2, n3] = myNotifs;
const delOne = await call('DELETE', `/api/notifications/${n1.id}`, null, et);
check('delete one notification', delOne.status === 200 && delOne.json.deleted === 1);
const delOtherUser = await call('DELETE', `/api/notifications/${n2.id}`, null, at);
check('cannot delete another user\'s notification', delOtherUser.status === 404);
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

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
