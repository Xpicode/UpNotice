# UpNotice — how the code works

A tour of every folder and file, what it does, and why it is there. Written for someone who is learning Node.js and React: the first part explains the ideas, the second part goes file by file, and the last part follows one real action (posting an announcement) through the whole system so you can see how the pieces connect.

---

## 1. The big picture

UpNotice is **two programs** that talk to each other, plus a database:

```
 ┌────────────────────────┐   HTTP requests (JSON)    ┌──────────────────────┐   SQL    ┌──────────────┐
 │  app/  (the screens)   │ ───────────────────────►  │  server/  (the API)  │ ───────► │  PostgreSQL  │
 │  React + TypeScript    │ ◄───────────────────────  │  Node.js + Express   │ ◄─────── │  (or SQLite) │
 │  runs in the browser,  │   answers + live events   │  runs on the PC /    │          └──────────────┘
 │  Electron or the phone │                           │  in Docker           │
 └────────────────────────┘                           └──────────────────────┘
```

- **`app/`** is what people see: login, announcements, meetings, alerts. It never touches the database directly — it only *asks* the server, e.g. "give me the announcements" or "mark this one as read".
- **`server/`** is the only thing allowed to touch the database. It checks who you are (the token), decides what you're allowed to see (an employee only sees their company's announcements), and answers in JSON.
- **The database** just stores rows in tables. PostgreSQL runs in Docker; SQLite (a single file) is the fallback when Docker is off.

The same `app/` code is packaged three ways: as a website (served by the server), as a Windows program (Electron wraps it in a window), and as an Android/iOS app (Capacitor wraps it in a phone app). That's why the app talks to the server over HTTP even when both are on the same PC — a phone can't open a database file on your computer, but it can call `http://192.168.x.x:4000/api/...`.

### Words you'll see everywhere

| Word | Meaning here |
|---|---|
| **API / endpoint / route** | A URL the server answers, e.g. `GET /api/announcements` (list them) or `POST /api/announcements/5/read` (mark #5 read). `GET` = read, `POST` = create/do something, `PATCH` = change, `DELETE` = remove. |
| **JSON** | The text format used for every answer: `{ "announcements": [ ... ] }`. |
| **JWT token** | After login the server gives the app a long signed string. The app sends it with every request (`Authorization: Bearer ...`) so the server knows who is asking without a password each time. |
| **SQL** | The language for the database: `SELECT * FROM users WHERE id = ?`. |
| **Component** | A piece of React UI (a function that returns HTML-like code). Screens are big components; buttons, sheets, chips are small ones. |
| **State** | Data a component remembers between renders (`useState`). When state changes, React redraws. |
| **SSE (Server-Sent Events)** | A connection the app keeps open so the server can say "something changed" instantly — that's how a new announcement appears on the employee's phone without refreshing. |

---

## 2. Folder by folder

```
pro/
├── package.json          npm run dev / npm start / npm stop / npm run db ...
├── scripts/upnotice.mjs  the launcher those commands run
├── docker-compose.yml    describes the containers (database, app, optional db-web)
├── Dockerfile            recipe to build the "upnotice" container image
├── server/               the API  (Node.js)
├── app/                  the screens (React), packaged for web / desktop / mobile
├── start.bat, start-docker.bat   old double-click shortcuts; they just call npm run dev / npm start
└── README.md             how to run, sign-in accounts, deployment
```

### 2.1 `server/` — the API

Language: JavaScript running in **Node.js**. Web framework: **Express** (a small library that maps URLs to functions).

| File | What it does |
|---|---|
| `package.json` | Lists the libraries the server uses and the commands (`npm run dev`, `npm start`, `npm test`). Libraries: `express` (web server), `pg` (PostgreSQL driver), `better-sqlite3` (SQLite driver), `jsonwebtoken` (login tokens), `bcryptjs` (password hashing — passwords are never stored in plain text), `multer` (file uploads), `xlsx` (read/write Excel for bulk import), `dotenv` (reads `.env`), `cors` (lets a browser on another address call the API), `firebase-admin` (mobile push, optional). |
| `.env` / `.env.example` | Settings that differ per computer: database address (`DATABASE_URL`), secret for tokens (`JWT_SECRET`), port. `.env` is not in git; copy `.env.example` to create it. |
| `src/index.js` | **The entry point.** Creates the Express app, plugs in every route file under `/api/...`, defines `/api/health` (version + which database) and `/api/dashboard` (the numbers on the home screen), serves the built web app from `app/dist` if it exists, opens the database, seeds demo data on first run, starts the 1-minute scheduler, then listens on port 4000 (or 4001 in dev mode). Also has the central error handler (turns crashes into `{ error: ... }` answers). |
| `src/db.js` | **The database layer.** One small set of functions the rest of the server uses — `db.all(sql, params)` (many rows), `db.get` (one row), `db.run` (insert/update/delete), `db.tx(fn)` (transaction: all-or-nothing). Behind them it talks to PostgreSQL *or* SQLite and hides the differences (placeholders, transactions, `RETURNING id`). Also holds the **schema** — the `CREATE TABLE` statements for every table — and the upgrade steps for old SQLite files. `audienceUserIds()` and `visibilitySql()` are the two shared rules for "who is this announcement/meeting for". |
| `src/auth.js` | Login helpers: `signToken` (create a JWT), `requireAuth` (middleware: reject requests without a valid token and attach `req.user`), `requireAdmin` (only the boss), `publicUser` (strip the password hash before sending a user to the app), `wrap` (lets route functions be `async` and still report errors). |
| `src/routes/auth.js` | `/api/auth/*`: login, "who am I" (`/me`), change password, profile photo upload/download, `my-history` (an employee's own attendance record). |
| `src/routes/admin.js` | `/api/companies`, `/api/departments`, `/api/users`: create/edit/delete companies, departments and employees; the Excel/CSV **bulk import** and its template download. Duplicate names/emails become a friendly 409 error. |
| `src/routes/announcements.js` | `/api/announcements/*`: list (filtered by what the user may see), detail with read receipts, create/edit with attachments, scheduling (`publish_at`), expiry, acknowledgement, poll voting, mark-as-read, file download. `publishDueAnnouncements()` is called by the scheduler to release scheduled ones. |
| `src/routes/meetings.js` | `/api/meetings/*`: list (upcoming/past), detail with attendee RSVPs, create (including **recurring** series), edit, cancel, delete (one / future / whole series), RSVP with reason. `sendMeetingReminders()` sends the "in 60 min" reminder. |
| `src/routes/notifications.js` | `/api/notifications/*`: the Alerts list, mark read, delete one / selected / all, and `/stream` — the SSE live connection. |
| `src/routes/comments.js` | `/api/comments/*`: questions & comments under an announcement or meeting; notifies admins / thread participants. |
| `src/routes/reports.js` | `/api/reports/*`: builds the read-rate and attendance numbers per employee / department / announcement / meeting, and exports them as CSV. |
| `src/routes/devices.js` | `/api/devices/*`: phones register their push-notification token here. |
| `src/notify.js` | `createNotifications(userIds, {...})`: writes a row in `notifications` for each person, pushes it live over SSE and sends a mobile push. Every "someone should be told" moment in the server calls this. |
| `src/events.js` | The SSE hub: remembers which browsers/phones are connected and lets the server say "announcements changed" to them. |
| `src/push.js` | Firebase Cloud Messaging: sends push notifications to phones when the app is closed. Does nothing until `FIREBASE_SERVICE_ACCOUNT` is set. |
| `src/uploads.js` | Multer setup: where uploaded files go (`data/uploads`), which types are allowed, size limits. |
| `src/seed.js` | On an empty database, creates the demo companies, departments, users (admin@company.com etc.), announcements and a meeting. |
| `src/migrate-to-postgres.js` | Copies an old SQLite database into PostgreSQL the first time you switch; the server calls it automatically. |
| `test/api.test.js` | 86 automatic checks that call the real API (login, permissions, targeting, RSVP, polls, import, reports…). Run with `npm test` while the server is running — if it prints "All tests passed" nothing important broke. |
| `data/` | Created at runtime: `upnotice.db` (SQLite mode) and `uploads/` (attachments, photos). Not in git. |

### 2.2 `app/` — the screens

Language: **TypeScript** (JavaScript with types) using **React**. Built with **Vite** (fast dev server + bundler).

| File | What it does |
|---|---|
| `package.json` | Libraries: `react`, `react-dom`, `@capacitor/*` (mobile), `electron` + `electron-builder` (desktop), `vite`, `typescript`. Commands: `npm run dev`, `npm run build`, `npm run desktop`, `npm run mobile:android`. |
| `vite.config.ts` | Dev server on port 4000; forwards anything starting with `/api` to the API on 4001 (so the browser only ever sees one address). |
| `index.html` | The single HTML page. Everything else is drawn by React inside `<div id="root">`. |
| `public/favicon.svg` | The tab icon. |
| `src/main.tsx` | **Entry point** of the app: applies the saved theme, then renders `<App />` inside an error boundary (a friendly "UpNotice could not start" screen instead of a blank page). |
| `src/App.tsx` | The frame: sidebar (desktop) / tab bar (phone), top bar with title, back button, dark-mode toggle and settings; decides which screen to show; shows the "server is out of date" banner; registers for push on phones. |
| `src/api.ts` | **Every call to the server lives here** — one function per endpoint (`api.announcements()`, `api.rsvp(id, status, note)`, …) plus the TypeScript types of what comes back (`Announcement`, `Meeting`, `User`…). Stores the token and the server address in `localStorage`. `openLiveStream()` opens the SSE connection. Screens never call `fetch` directly; they call these functions. |
| `src/store.tsx` | Shared state for the whole app (React Context): the signed-in user, current tab/detail, dashboard numbers, company & department lists, the `version` counter that bumps when the server says something changed, and `toast()` for the little black message at the bottom. `useLoader(fn)` is the helper every screen uses to load data and automatically reload when `version` changes. |
| `src/screens/Login.tsx` | Email + password form, "Server" address setting (for phones). |
| `src/screens/Home.tsx` | The dashboard tiles (unread, upcoming meetings, pending replies; admin: employees, companies, awaiting reads). |
| `src/screens/Announcements.tsx` | List + detail + the create/edit sheet (title, message, priority, pin, audience, attachments, schedule, expiry, acknowledgement, poll). |
| `src/screens/Meetings.tsx` | List (upcoming/past) + detail with RSVP buttons and reason box + create/edit sheet with repeat options. |
| `src/screens/Notifications.tsx` | The Alerts tab: list, open, mark all read, trash per row, Select mode, clear read / clear all. |
| `src/screens/People.tsx` | Admin only: companies, departments, employees, add/edit/deactivate, the inline "+ Add new department", Excel import. |
| `src/screens/Reports.tsx` | Admin only: read rates and attendance tables with date filter and CSV export buttons. |
| `src/screens/Settings.tsx` | Profile photo, change password, theme, push notifications, my history, sign out. |
| `src/components/ui.tsx` | Small reusable pieces: `Sheet` (the slide-up dialog), `Confirm`, `Toast`, `Empty` state, `Spinner`, `PriorityChip`, `AudiencePicker` (company → departments). |
| `src/components/social.tsx` | `Avatar`, `CommentThread`, `AttachmentList`, `FilePicker`. |
| `src/components/theme-toggle.tsx` | The sun/moon button. |
| `src/theme.ts` | Light / dark / match-device logic, remembered in `localStorage`. |
| `src/notify.ts` | System notifications while the app is open, and push registration on phones (Capacitor). |
| `src/icons.tsx` | The SVG icons as tiny components. |
| `src/styles.css` | All styling. Colors are CSS variables (`--primary`, `--surface`…) defined once for light and once for dark, so every component switches theme automatically. |
| `electron/main.cjs` | The desktop wrapper: opens a window and loads the built app. `preload.cjs` is its (empty) bridge file. |
| `capacitor.config.ts` | Mobile wrapper settings: app id `com.upright.upnotice`, name UpNotice. |
| `dist/` | Created by `npm run build`: the finished website files the server (and Electron/Capacitor) serve. Not in git. |

### 2.3 Running it: `scripts/upnotice.mjs`, `docker-compose.yml`, `Dockerfile`

- **`scripts/upnotice.mjs`** is the launcher behind `npm run dev` / `npm start` / `npm stop` / `npm run db:web`. In dev mode it: stops anything old on ports 4000/4001, starts the `db` container (falls back to SQLite if Docker is off), installs missing packages, then runs the API and Vite together in one window with `[api]` / `[app]` prefixes and opens the browser. Everything it prints is also saved to `upnotice.log`.
- **`docker-compose.yml`** describes three containers: `db` (PostgreSQL 16, data in volume `upnotice-pgdata`, reachable on your PC at port 5433), `upnotice` (API + built app on port 4000, uploads in volume `upnotice-data`), and the optional `db-web` (Adminer, port 4040, only when you run `npm run db:web`).
- **`Dockerfile`** is the recipe for the `upnotice` image in three stages: build the React app, install server packages, copy both into a small runtime image that runs `node src/index.js`.

---

## 3. The database tables

| Table | One row = | Important columns |
|---|---|---|
| `companies` | a company the boss owns | `name` |
| `departments` | a department inside a company | `name`, `company_id` (unique together) |
| `users` | a person who can sign in | `email`, `password_hash`, `role` (`admin`/`employee`), `company_id`, `department_id`, `active`, `avatar_path` |
| `announcements` | one announcement | `title`, `body`, `priority`, `pinned`, `company_id` (NULL = all companies), `publish_at`, `expires_at`, `ack_required`, `poll_question`, `notified` |
| `announcement_targets` | "this announcement is for this department" | no rows = whole company |
| `announcement_reads` | "this user opened this announcement" | `read_at`, `acknowledged_at` |
| `announcement_attachments`, `poll_options`, `poll_votes` | files and poll data of an announcement | |
| `meetings` | one meeting occurrence | `starts_at`, `ends_at`, `location`, `link`, `status`, `company_id`, `series_id` + `recurrence` (repeating meetings share a series id), `reminder_sent` |
| `meeting_targets`, `meeting_rsvps` | who it's for; who answered what (`status`, `note`) | |
| `notifications` | one alert for one user | `title`, `body`, `ref_type`/`ref_id` (what it points to), `read_at` |
| `comments` | a comment under an announcement or meeting | `ref_type`, `ref_id`, `user_id`, `body` |
| `device_tokens` | a phone that wants push notifications | `token`, `user_id` |

All dates are stored as text in ISO format (`2026-09-03T02:42:08.541Z`, always UTC) so they sort and compare correctly in both databases; the app converts them to Manila time for display.

**The visibility rule** (used for both announcements and meetings): an employee sees an item if `company_id` is NULL (all companies) or equals their company, **and** the item has no department targets or one of the targets is their department. Admins see everything. In SQL this is `visibilitySql()` in `db.js`; the same rule in JavaScript is `canSee()` in the route files.

---

## 4. Follow one action end to end: the boss posts an announcement

1. **Screen** — `app/src/screens/Announcements.tsx`: the admin fills the sheet and presses Save. The component builds the fields (title, body, priority, company/department from `AudiencePicker`, files, schedule…) and calls `api.createAnnouncement(fields, files)`.
2. **API client** — `app/src/api.ts`: `requestForm('POST', '/api/announcements', …)` packs everything as `multipart/form-data` (because of the files), adds `Authorization: Bearer <token>` and sends it to `getServerUrl() + '/api/announcements'` — in dev that's `http://localhost:4000`, and Vite forwards it to the API on 4001.
3. **Server entry** — `server/src/index.js` has `app.use('/api/announcements', announcementRoutes)`, so Express hands the request to `routes/announcements.js`.
4. **Auth** — `router.use(requireAuth)` runs first: `auth.js` verifies the token, loads the user from the database, puts it on `req.user`. Then `requireAdmin` checks `role === 'admin'`.
5. **Upload** — `attachmentUpload.array('files', 5)` (from `uploads.js`) saves the files into `data/uploads` and puts their info on `req.files`.
6. **Validation** — the route checks title/body, priority, dates, poll options, and `parseTargeting()` makes sure the departments really belong to the chosen company. Any problem → `res.status(400).json({ error: '...' })`, which the app shows in red.
7. **Database** — inside `db.tx(...)` (so it's all-or-nothing): `INSERT INTO announcements ... RETURNING id`, then one `INSERT INTO announcement_targets` per department, poll options, attachment rows.
8. **Telling people** — `sendNewAnnouncementNotifications()` → `audienceUserIds()` works out which active employees it's for → `createNotifications()` (`notify.js`) inserts one `notifications` row per person, pushes `notification` over SSE to anyone connected (`events.js`) and sends a Firebase push (`push.js`). Then `notifyAll('announcements', {id})` tells every connected app "the announcements list changed".
9. **Answer** — the route re-reads the announcement with `baseSelect` (counts, read_by_me…) and returns `{ announcement: {...} }` with status 201.
10. **Back in the app** — the sheet closes and `toast('Announcement posted')`. Meanwhile, on every employee's device, `store.tsx` received the SSE event and bumped `version`; `useLoader` in their Announcements and Alerts screens re-fetches, so the new item appears within a second — no refresh. `notify.ts` also shows a system notification.

The same pattern — screen → `api.ts` → route → auth → validate → SQL → notify → JSON back → screens reload — is how every feature works.

---

## 5. Where to change things

| I want to… | Look in |
|---|---|
| change a color, font, spacing | `app/src/styles.css` (light values at the top, dark values under `[data-theme="dark"]`) |
| change a label or text on a screen | the matching `app/src/screens/*.tsx` |
| add a field to announcements | `server/src/db.js` (column in the schema + an `ADD COLUMN IF NOT EXISTS` for PostgreSQL / `addColumnIfMissing` for SQLite), `routes/announcements.js` (read it from the body, save it, return it), `app/src/api.ts` (add it to the `Announcement` type), `Announcements.tsx` (input + display) |
| add a brand-new API endpoint | a `router.get/post(...)` in the right `server/src/routes/*.js`, a matching function in `app/src/api.ts`, then use it in a screen |
| change who receives something | `audienceUserIds()` / `visibilitySql()` in `server/src/db.js` |
| change the demo accounts | `server/src/seed.js` (only used when the database is empty) |
| change the app name / icon | `app/index.html`, `app/capacitor.config.ts`, `app/package.json` (`build` section), `app/electron/main.cjs`, `app/public/favicon.svg` |
| change ports or the database address | `server/.env`, `docker-compose.yml`, `app/vite.config.ts` |
| see what the server is doing | the `[api]` lines in the `npm run dev` window, or `upnotice.log`; in Docker `npm run logs` |

## 6. Good habits when editing

- After changing the server, run `npm test` from the `pro` folder (server must be running) — 86 checks tell you immediately if you broke login, permissions or targeting.
- After changing the app, `npm run build` inside `app/` also runs the TypeScript checker; red errors there point at the exact line.
- The API version handshake: if you change what an endpoint returns in a way the app depends on, bump `SERVER_VERSION` in `server/src/index.js` and `REQUIRED_SERVER_VERSION` in `app/src/api.ts` together — the app then shows a banner if it's talking to an old server instead of failing mysteriously.
- Commit often: `git add -A` then `git commit -m "what you changed"` in the `pro` folder.
