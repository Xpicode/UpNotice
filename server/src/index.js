import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, initDb, visibilitySql, audienceUserIds, nowIso } from './db.js';
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
import { migrateFromSqlite } from './migrate-to-postgres.js';
import { requireAuth, wrap } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const origin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*' ? process.env.CORS_ORIGIN.split(',') : true;
app.use(cors({ origin }));
app.use(express.json({ limit: '1mb' }));

export const SERVER_VERSION = '3.4.0';
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'UpNotice', version: SERVER_VERSION, database: db.dialect, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api', adminRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/devices', deviceRoutes);

// Small summary for the home screen.
app.get('/api/dashboard', requireAuth, wrap(async (req, res) => {
  const me = req.user.id;
  const dept = req.user.department_id ?? -1;
  const company = req.user.company_id ?? -1;
  const isAdmin = req.user.role === 'admin';
  const visible = isAdmin ? '1=1' : visibilitySql('a', 'announcement_targets', 'announcement_id');
  const unreadAnnouncements = (
    await db.get(
      `SELECT COUNT(*) AS n FROM announcements a WHERE ${visible}
       AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = @me)`,
      { me, dept, company, nowTs: nowIso() }
    )
  ).n;
  const visibleM = isAdmin ? '1=1' : visibilitySql('m', 'meeting_targets', 'meeting_id');
  const now = new Date().toISOString();
  const upcomingMeetings = (await db.get(`SELECT COUNT(*) AS n FROM meetings m WHERE ${visibleM} AND m.status = 'scheduled' AND m.ends_at >= @now`, { dept, company, now })).n;
  const pendingRsvps = (
    await db.get(
      `SELECT COUNT(*) AS n FROM meetings m WHERE ${visibleM} AND m.status = 'scheduled' AND m.ends_at >= @now
       AND NOT EXISTS (SELECT 1 FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.user_id = @me)`,
      { me, dept, company, now }
    )
  ).n;
  const unreadNotifications = (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [me])).n;
  const out = { unreadAnnouncements, upcomingMeetings, pendingRsvps, unreadNotifications };
  if (isAdmin) {
    out.employees = (await db.get("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role = 'employee'")).n;
    out.companies = (await db.get('SELECT COUNT(*) AS n FROM companies')).n;

    // Admin-only: live announcements that still have employees who haven't read them.
    const readsIn = async (annId, ids) =>
      ids.length === 0 ? 0 : (await db.get(`SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`, [annId, ...ids])).n;
    let announcementsAwaitingReads = 0;
    const live = await db.all('SELECT id, company_id FROM announcements WHERE (publish_at IS NULL OR publish_at <= ?) AND (expires_at IS NULL OR expires_at > ?)', [now, now]);
    for (const a of live) {
      const targets = await db.all('SELECT department_id FROM announcement_targets WHERE announcement_id = ?', [a.id]);
      const audience = await audienceUserIds(a.company_id, targets.map((t) => t.department_id));
      if (audience.length - (await readsIn(a.id, audience)) > 0) announcementsAwaitingReads++;
    }
    out.announcementsAwaitingReads = announcementsAwaitingReads;
  }
  res.json(out);
}));

// Serve the built web app if it exists (lets one server host API + web version).
const webDir = path.resolve(__dirname, '../../app/dist');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>UpNotice API</title>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;line-height:1.5;color:#0f172a">
<h1 style="color:#1d4ed8">UpNotice API is running ✅</h1>
<p>The web app hasn't been built yet, so there is nothing to show at this address. Pick one:</p>
<h3>Development (live reload)</h3>
<p>Run <code>start.bat</code> from the pro folder (or <code>npm run dev</code> in both <code>server</code> and <code>app</code>), then open <a href="http://localhost:4000">http://localhost:4000</a>.</p>
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
  if (err && err.code === '22P02') return res.status(404).json({ error: 'Not found' }); // PostgreSQL: id was not a number
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

try {
  await initDb();
  await migrateFromSqlite(); // first start on PostgreSQL: bring over the data from the old SQLite file, if any
  await ensureSeed();
} catch (err) {
  console.error('Could not open the database:', err.message);
  if (process.env.DATABASE_URL) console.error('Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d db).');
  process.exit(1);
}
initPush();

// Background scheduler: publishes scheduled announcements and sends meeting reminders.
async function tick() {
  try {
    await publishDueAnnouncements();
    await sendMeetingReminders();
  } catch (err) {
    console.error('Scheduler error:', err);
  }
}
tick();
setInterval(tick, 60 * 1000).unref();

// `npm run dev` passes --dev: the API moves to 4001 so the Vite dev server can own http://localhost:4000
// (the same address Docker/production use). PORT in .env always wins.
const isDev = process.argv.includes('--dev');
const port = Number(process.env.PORT) || (isDev ? 4001 : 4000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`UpNotice API running on http://localhost:${port}${isDev ? '  (dev mode — open the app at http://localhost:4000)' : ''}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Stop the other program or set PORT=... in .env`);
  } else {
    console.error(err);
  }
  db.close().finally(() => process.exit(1));
});

// Close the database cleanly on Ctrl+C / restart (keeps the SQLite native module happy on Windows).
async function shutdown() {
  server.close();
  try {
    await db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
