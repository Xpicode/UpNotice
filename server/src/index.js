import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, visibilitySql, audienceUserIds, nowIso } from './db.js';
import { ensureSeed } from './seed.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import announcementRoutes, { publishDueAnnouncements } from './routes/announcements.js';
import meetingRoutes, { sendMeetingReminders } from './routes/meetings.js';
import notificationRoutes from './routes/notifications.js';
import commentRoutes from './routes/comments.js';
import reportRoutes from './routes/reports.js';
import deviceRoutes from './routes/devices.js';
import { initPush } from './push.js';
import { requireAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const origin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*' ? process.env.CORS_ORIGIN.split(',') : true;
app.use(cors({ origin }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api', adminRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/devices', deviceRoutes);

// Small summary for the home screen.
app.get('/api/dashboard', requireAuth, (req, res) => {
  const me = req.user.id;
  const dept = req.user.department_id ?? -1;
  const company = req.user.company_id ?? -1;
  const isAdmin = req.user.role === 'admin';
  const visible = isAdmin ? '1=1' : visibilitySql('a', 'announcement_targets', 'announcement_id');
  const unreadAnnouncements = db
    .prepare(
      `SELECT COUNT(*) AS n FROM announcements a WHERE ${visible}
       AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = @me)`
    )
    .get({ me, dept, company, nowTs: nowIso() }).n;
  const visibleM = isAdmin ? '1=1' : visibilitySql('m', 'meeting_targets', 'meeting_id');
  const now = new Date().toISOString();
  const upcomingMeetings = db
    .prepare(`SELECT COUNT(*) AS n FROM meetings m WHERE ${visibleM} AND m.status = 'scheduled' AND m.ends_at >= @now`)
    .get({ dept, company, now }).n;
  const pendingRsvps = db
    .prepare(
      `SELECT COUNT(*) AS n FROM meetings m WHERE ${visibleM} AND m.status = 'scheduled' AND m.ends_at >= @now
       AND NOT EXISTS (SELECT 1 FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.user_id = @me)`
    )
    .get({ me, dept, company, now }).n;
  const unreadNotifications = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(me).n;
  const out = { unreadAnnouncements, upcomingMeetings, pendingRsvps, unreadNotifications };
  if (isAdmin) {
    out.employees = db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role = 'employee'").get().n;
    out.departments = db.prepare('SELECT COUNT(*) AS n FROM departments').get().n;
    out.companies = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;

    // Admin-only: how much of what was sent is still waiting on employees.
    const annTargets = db.prepare('SELECT department_id FROM announcement_targets WHERE announcement_id = ?');
    const readsIn = (annId, ids) =>
      ids.length === 0 ? 0 : db.prepare(`SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`).get(annId, ...ids).n;
    let announcementsAwaitingReads = 0;
    let unreadPeople = 0;
    for (const a of db.prepare('SELECT id, company_id FROM announcements').all()) {
      const audience = audienceUserIds(a.company_id, annTargets.all(a.id).map((t) => t.department_id));
      const missing = audience.length - readsIn(a.id, audience);
      if (missing > 0) {
        announcementsAwaitingReads++;
        unreadPeople += missing;
      }
    }
    const meetTargets = db.prepare('SELECT department_id FROM meeting_targets WHERE meeting_id = ?');
    const rsvpsIn = (mId, ids) =>
      ids.length === 0 ? 0 : db.prepare(`SELECT COUNT(*) AS n FROM meeting_rsvps WHERE meeting_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`).get(mId, ...ids).n;
    let repliesPending = 0;
    for (const m of db.prepare("SELECT id, company_id FROM meetings WHERE status = 'scheduled' AND ends_at >= ?").all(now)) {
      const audience = audienceUserIds(m.company_id, meetTargets.all(m.id).map((t) => t.department_id));
      repliesPending += audience.length - rsvpsIn(m.id, audience);
    }
    out.announcementsAwaitingReads = announcementsAwaitingReads;
    out.unreadPeople = unreadPeople;
    out.repliesPending = repliesPending;
    out.totalAnnouncements = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
  }
  res.json(out);
});

// Serve the built web app if it exists (lets one server host API + web version).
const webDir = path.resolve(__dirname, '../../app/dist');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>TeamAnnounce API</title>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;line-height:1.5;color:#0f172a">
<h1 style="color:#1d4ed8">TeamAnnounce API is running ✅</h1>
<p>The web app hasn't been built yet, so there is nothing to show at this address. Pick one:</p>
<h3>Development (live reload)</h3>
<pre style="background:#f1f5f9;padding:12px;border-radius:8px">cd app
npm install
npm run dev</pre>
<p>then open <a href="http://localhost:5173">http://localhost:5173</a></p>
<h3>Production build served here</h3>
<pre style="background:#f1f5f9;padding:12px;border-radius:8px">cd app
npm install
npm run build</pre>
<p>then restart this server and refresh this page.</p>
<p style="color:#64748b;font-size:14px">API health check: <a href="/api/health">/api/health</a></p>
</body>`);
  });
}

app.use((err, req, res, next) => {
  if (err && (err.name === 'MulterError' || /not allowed|must be an image/i.test(err.message))) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

ensureSeed();
initPush();

// Background scheduler: publishes scheduled announcements and sends meeting reminders.
function tick() {
  try {
    publishDueAnnouncements();
    sendMeetingReminders();
  } catch (err) {
    console.error('Scheduler error:', err);
  }
}
tick();
setInterval(tick, 60 * 1000).unref();

const port = Number(process.env.PORT) || 4000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`TeamAnnounce API running on http://localhost:${port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other program or set PORT=... in .env`);
  } else {
    console.error(err);
  }
  db.close();
  process.exit(1);
});

// Close the database cleanly on Ctrl+C / restart (keeps the SQLite native module happy on Windows).
function shutdown() {
  server.close();
  try {
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
