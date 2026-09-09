import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, httpLogger, isProduction } from './log.js';
import { db, initDb, visibilitySql, nowIso } from './db.js';
import { ensureSeed } from './seed.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import announcementRoutes, { publishDueAnnouncements } from './routes/announcements.js';
import meetingRoutes, { sendMeetingReminders, sendCheckInNotices, CHECKIN_OPENS_BEFORE_MS, CHECKIN_CLOSES_AFTER_MS } from './routes/meetings.js';
import notificationRoutes from './routes/notifications.js';
import commentRoutes from './routes/comments.js';
import reportRoutes from './routes/reports.js';
import deviceRoutes from './routes/devices.js';
import templateRoutes from './routes/templates.js';
import activityRoutes from './routes/activity.js';
import { initPush } from './push.js';
import { initMail, appUrl } from './mail.js';
import { migrateFromSqlite } from './migrate-to-postgres.js';
import { requireAuth, isStaff, wrap, purgeExpired } from './auth.js';
import { purgeOldNotifications } from './notify.js';
import { apiLimiter } from './limits.js';
import { announcementsAwaitingReadsCount } from './audience-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
// Behind nginx / a load balancer set TRUST_PROXY=1 so rate limits and the activity log see the real client address.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

// ---------- security headers ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // React inline style attributes
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
// Browser features the app never uses are switched off, and API answers (which may carry tokens or personal data) are never cached.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---------- CORS ----------
// The web app is normally served by this same server (no CORS needed). The desktop and mobile apps, and the Vite dev
// server, come from other origins: those are allowed here. CORS_ORIGIN adds more (comma-separated) or "*" opens it up.
const allowedOrigins = new Set(['capacitor://localhost', 'ionic://localhost', 'https://localhost', 'http://localhost', 'null']);
try {
  allowedOrigins.add(new URL(appUrl()).origin);
} catch {
  /* APP_PUBLIC_URL not a URL */
}
if (!isProduction) for (const p of [4000, 4001, 5173]) allowedOrigins.add(`http://localhost:${p}`).add(`http://127.0.0.1:${p}`);
const corsSetting = String(process.env.CORS_ORIGIN || '').trim();
for (const o of corsSetting
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && s !== '*'))
  allowedOrigins.add(o.replace(/\/+$/, ''));
const corsAny = corsSetting === '*';
if (corsAny && isProduction) {
  log.error(
    'CORS_ORIGIN=* is not allowed in production: it would let any website call the API from a browser. Leave CORS_ORIGIN unset (the web app, desktop app and mobile apps are already allowed) or list the exact origins, comma-separated.'
  );
  process.exit(1);
}
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || corsAny || allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
    maxAge: 600,
  })
);

app.use(httpLogger);
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiLimiter);

export const SERVER_VERSION = '4.0.0';
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'UpNotice', version: SERVER_VERSION, database: db.dialect, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api', adminRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/activity', activityRoutes);

// Small summary for the home screen.
app.get(
  '/api/dashboard',
  requireAuth,
  wrap(async (req, res) => {
    const me = req.user.id;
    const dept = req.user.department_id ?? -1;
    const company = req.user.company_id ?? -1;
    const isAdmin = req.user.role === 'admin';
    const staff = isStaff(req.user);
    const visible = isAdmin ? 'a.is_draft = 0' : visibilitySql('a', 'announcement_targets', 'announcement_id');
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

    // The meeting I am expected at whose attendance check-in is open right now, so the app can put the
    // check-in box in front of the person instead of waiting for them to find it. Organizers and the
    // staff who take the attendance are not attendees, so they never get it.
    if (!isAdmin) {
      const nowMs = Date.now();
      const params = {
        me,
        dept,
        company,
        startsBy: new Date(nowMs + CHECKIN_OPENS_BEFORE_MS).toISOString(),
        endsAfter: new Date(nowMs - CHECKIN_CLOSES_AFTER_MS).toISOString(),
      };
      const row = await db.get(
        `SELECT m.id, m.title, m.starts_at, m.ends_at, m.location,
                (SELECT ma.status FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.user_id = @me) AS my_checkin
         FROM meetings m
         WHERE ${visibleM} AND m.status = 'scheduled' AND m.organizer_id <> @me
           AND m.starts_at <= @startsBy AND m.ends_at >= @endsAfter
           ${staff ? 'AND (m.company_id IS NULL OR m.company_id <> @company)' : ''}
           AND NOT EXISTS (SELECT 1 FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.user_id = @me AND ma.status = 'approved')
           AND NOT EXISTS (SELECT 1 FROM meeting_rsvps r WHERE r.meeting_id = m.id AND r.user_id = @me AND r.status = 'declined')
         ORDER BY m.starts_at ASC`,
        params
      );
      // Someone who has already tapped the button still gets the strip — it turns into "waiting for approval".
      if (row) out.openCheckIn = { ...row, my_checkin: row.my_checkin || 'none', checkin_closes_at: new Date(Date.parse(row.ends_at) + CHECKIN_CLOSES_AFTER_MS).toISOString() };
    }
    if (staff) {
      // Managers see the numbers for their own company only.
      const scope = isAdmin ? null : (req.user.company_id ?? -1);
      out.employees =
        scope === null
          ? (await db.get("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role IN ('employee', 'manager')")).n
          : (await db.get("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role IN ('employee', 'manager') AND company_id = ?", [scope])).n;
      out.companies = (await db.get('SELECT COUNT(*) AS n FROM companies')).n;
      out.drafts =
        scope === null
          ? (await db.get('SELECT COUNT(*) AS n FROM announcements WHERE is_draft = 1')).n
          : (await db.get('SELECT COUNT(*) AS n FROM announcements WHERE is_draft = 1 AND company_id = ?', [scope])).n;
      // Live announcements that still have employees who haven't read them (one query, see audience-sql.js).
      out.announcementsAwaitingReads = await announcementsAwaitingReadsCount(scope);
      // People who have tapped "Check in" and are waiting to be approved, on meetings this person runs.
      const waiting = await db.get(
        `SELECT COUNT(*) AS n, MIN(ma.meeting_id) AS meeting_id FROM meeting_attendance ma
         JOIN meetings m ON m.id = ma.meeting_id
         WHERE ma.status = 'pending' AND (m.organizer_id = @me ${scope === null ? '' : 'OR m.company_id = @scope'})`,
        scope === null ? { me } : { me, scope }
      );
      out.pendingApprovals = waiting.n;
      if (waiting.n > 0) out.pendingApprovalsMeetingId = waiting.meeting_id;
    }
    res.json(out);
  })
);

app.all(/^\/api(\/.*)?$/, (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built web app if it exists (lets one server host API + web version).
const webDir = path.resolve(__dirname, '../../app/dist');
if (fs.existsSync(webDir)) {
  const noStore = (res) => res.setHeader('Cache-Control', 'no-cache');
  app.use(
    express.static(webDir, {
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders: (res, file) => {
        // Hashed assets can be cached forever; the entry points must always be re-checked.
        if (/\.html$|\/sw\.js$|workbox-.*\.js$|\.webmanifest$|\/registerSW\.js$/.test(file)) noStore(res);
      },
    })
  );
  app.get(/^(?!\/api).*/, (req, res) => {
    noStore(res);
    res.sendFile(path.join(webDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>UpNotice API</title>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;line-height:1.5;color:#18181b;background:#fafafa">
<h1 style="font-weight:600;letter-spacing:-0.01em">UpNotice API is running</h1>
<p>The web app hasn't been built yet, so there is nothing to show at this address. Pick one:</p>
<h3>Development (live reload)</h3>
<p>Run <code>npm run dev</code> in the pro folder, then open <a href="http://localhost:4000">http://localhost:4000</a>.</p>
<h3>Production build served here</h3>
<pre style="background:#f4f4f5;padding:12px;border-radius:8px">cd app
npm install
npm run build</pre>
<p>then restart this server and refresh this page.</p>
<p style="color:#71717a;font-size:14px">API health check: <a href="/api/health">/api/health</a></p>
</body>`);
  });
}

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large'
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Too many files'
          : err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'Unexpected file field'
            : 'Upload failed';
    return res.status(400).json({ error: msg });
  }
  if (err?.status === 400 && (err.name === 'ValidationError' || err.name === 'UploadError')) return res.status(400).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err?.code === '22P02') return res.status(404).json({ error: 'Not found' }); // PostgreSQL: id was not a number
  log.error({ err, reqId: req.id, url: req.originalUrl }, 'Unhandled error');
  res.status(500).json({ error: 'Something went wrong on the server', request_id: req.id });
});

try {
  await initDb();
  try {
    await migrateFromSqlite(); // first start on PostgreSQL: bring over the data from the old SQLite file, if any
  } catch (err) {
    log.error(`Could not import the old SQLite data into PostgreSQL (${err.message}). Starting with a fresh database instead; the SQLite file is untouched.`);
  }
  await ensureSeed();
} catch (err) {
  log.error(`Could not open the database: ${err.message}`);
  if (process.env.DATABASE_URL) log.error('Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d db).');
  process.exit(1);
}
initPush();
initMail();

// Background scheduler: publishes scheduled announcements, sends meeting reminders and check-in notices, forgets expired sessions and old notifications.
let ticks = 0;
async function tick() {
  try {
    await publishDueAnnouncements();
    await sendMeetingReminders();
    await sendCheckInNotices();
    if (ticks++ % (24 * 60) === 0) {
      await purgeExpired();
      await purgeOldNotifications();
    }
  } catch (err) {
    log.error({ err }, 'Scheduler error');
  }
}
tick();
setInterval(tick, 60 * 1000).unref();

// `npm run dev` passes --dev: the API moves to 4001 so the Vite dev server can own http://localhost:4000
// (the same address Docker/production use). PORT in .env always wins.
const isDev = process.argv.includes('--dev');
const port = Number(process.env.PORT) || (isDev ? 4001 : 4000);
const server = app.listen(port, '0.0.0.0', () => {
  log.info(`UpNotice API ${SERVER_VERSION} running on http://localhost:${port}${isDev ? '  (dev mode — open the app at http://localhost:4000)' : ''}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') log.error(`Port ${port} is already in use. Stop the other program or set PORT=... in .env`);
  else log.error({ err }, 'Server error');
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
