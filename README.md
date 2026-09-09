# UpNotice

**UpNotice** by Upright Solutions — company announcements and employee meetings in one codebase that runs as a **web app**, a **Windows desktop app** (Electron) and **Android / iOS apps** (Capacitor), backed by your own **Node.js + PostgreSQL** server (a single-file SQLite mode is also available for quick tests).

## What it does

**Admins (management)**
- Manage several **companies** — each employee and department belongs to one; the admin sees all of them
- Give trusted people the **Manager** role: a manager does everything below for **their own company only** (post, schedule, attendance, reports, employees) and never sees other companies
- Post announcements (normal / important / urgent, optional pin) to **all companies**, one company, or specific departments in it, with a **category** (Safety, HR, Events… or your own)
- **Save as draft** and publish later, **duplicate** an old announcement, or save it as a **template** and reuse it in one click
- **Attach files** (images, PDF, Word, Excel…) to an announcement
- **Publish later** at a set time and/or **hide automatically** after a date
- **Require acknowledgement** ("I have read and understood") and add a **quick poll**
- See exactly who has read / acknowledged / voted, and who hasn't
- Schedule meetings (date, time, location, online link, agenda) for all companies, one company, or specific departments; **repeat weekly / every 2 weeks / monthly**; duplicate a past meeting
- **Take attendance**: show a 6-letter **check-in code / QR** on a screen — employees type it and are marked present — or tick people manually; write the **minutes** afterwards (everyone invited gets them)
- **Nobody has to go looking for the check-in**: when a meeting starts, everyone expected gets a notification and a "Check in" strip across the top of the app, wherever they are in it; it appears on its own and goes as soon as they are marked present
- See who is going / maybe / declined (with their reason) / hasn't replied; edit, cancel or delete meetings (one occurrence, future ones, or the whole series)
- Answer employees' **comments & questions** under any announcement or meeting
- **Reports**: read rates and attendance per company/department, per employee, per announcement and per meeting, with date filter and **CSV export** (opens in Excel)
- **Activity log** (admin): who posted, edited, deleted, signed in, changed a password… searchable by person, type and date
- Manage employees (add, edit, deactivate, reset password), departments and companies — a new department can be created right inside the Add Employee form; **bulk-import employees from Excel/CSV**

**Employees**
- Home screen with unread announcements, upcoming meetings and pending replies
- **Search** announcements and meetings, filter by category, company, department, date or unread
- Opening an announcement marks it as read automatically; acknowledge, vote in polls, download attachments
- RSVP to meetings (Going / Maybe / Can't go with a reason) — change anytime; reminder 1 hour before each meeting
- **Calendar view** of meetings (month grid) and **Add to Google Calendar / download .ics** for Outlook, Apple Calendar…
- **Check in** to a meeting with the code on screen; read the minutes afterwards
- Ask questions / comment under announcements and meetings
- Profile photo and personal attendance history (Settings)
- In-app notification feed (Alerts) + live updates the moment something is posted; delete single alerts, select several to delete, or clear read / clear all
- **Email notifications** (announcements, invites, reminders, minutes) once email is set up — each person can turn them off in Settings; **Forgot password?** link on the sign-in screen
- System notifications on phone and desktop while the app is open; **push notifications when the app is closed** (mobile, after the Firebase setup below)
- **Installable web app (PWA)**: open the web address in Chrome/Edge/Safari and choose *Install* / *Add to Home Screen* — it gets its own icon and window, no app store needed

## Sign-in accounts (demo data)

These accounts are created automatically the first time the server starts:

| Role     | Email               | Password  | Company / department              |
|----------|---------------------|-----------|-----------------------------------|
| **Admin (boss)** | `admin@company.com` | `admin123` | manages all companies          |
| Employee | `maria@company.com` | `password` | Upright Solutions · Operations   |
| Employee | `jose@company.com`  | `password` | Upright Solutions · Operations   |
| Employee | `ana@company.com`   | `password` | Upright Solutions · Sales        |
| Employee | `ben@company.com`   | `password` | SixthGear · Shop                 |

There is no demo **manager** — create one with People → Add → Role: *Manager* and pick the company. That person then signs in and only sees their own company.

Sign in as the **admin** to post announcements, schedule meetings and manage people. Sign in as an **employee** (in another browser or a private window) to see the employee side: read receipts, RSVP, comments.

The demo accounts only exist in development mode (`npm run dev`). With `npm start` (Docker) they are created too, but everyone is asked to **choose a new password at the first sign-in**. A real deployment (no `SEED_DEMO`) creates a single admin with a random password printed once in the server log — see *Security* below.

**Before real use:** add your real employees (People → Add / Import). Every password staff type in is temporary: the person picks their own (at least 8 characters) the first time they sign in. To start over at any time (test data, imported employees…), run `npm run db:reset` — it empties whichever database is configured (Supabase, Docker or SQLite) and recreates just the demo accounts.

## Security

What the server does to keep the data safe, and the switches you may need in `server/.env`:

- **Sign-in sessions.** Signing in gives the app a 1-hour access token and a 30-day refresh token that rotates on every use. Every request checks the session in the database, so *Settings → Sign out everywhere*, deactivating an account, a password reset or `npm run db:reset` take effect immediately. Tokens are only ever sent in the `Authorization` header — never in a URL. Files opened in a new tab (a PDF, the CSV export, the calendar file) use a 2-minute single-purpose link the app requests first.
- **Brute force.** 10 wrong passwords lock the account for 15 minutes; addresses are also rate-limited (sign-in, forgot-password, check-in codes, uploads, the whole API). Failed sign-ins appear in the Activity log.
- **Passwords.** At least 8 characters, not a common one, not the person's email or name. Temporary passwords (set by staff or the import) must be replaced at the first sign-in. Reset links live one hour and are stored hashed.
- **Uploads.** Every file's first bytes are checked against the declared type: a "photo" that is really HTML is refused, SVG is never accepted, office files must match their container, and files are served with `nosniff` and the type *we* detected. Attachments: images, PDF, Office and text only, 15 MB each, 5 per announcement.
- **Headers and origins.** Helmet sets a Content-Security-Policy, HSTS, `nosniff` and frame-blocking. The API answers browser calls from its own address, the desktop and mobile apps, and whatever you list in `CORS_ORIGIN` (comma-separated). `CORS_ORIGIN=*` is refused in production. API answers are sent with `Cache-Control: no-store`, and a `Permissions-Policy` switches off camera, microphone, location and payment APIs. See [SECURITY.md](SECURITY.md) for the full list and the deployment checklist.
- **Secrets.** `JWT_SECRET` must be at least 32 random characters; `npm run setup` / `npm start` generate one into `server/.env`, and the server refuses to start in production without it. Changing it signs everyone out.
- **Database connections.** Cloud PostgreSQL is encrypted **and the certificate is verified**. Supabase's certificate authority ships in `server/certs`; for another provider set `DATABASE_SSL_CA=path/to/ca.crt`. `DATABASE_SSL=no-verify` disables the check (not recommended).
- **Behind a proxy.** With nginx / Caddy / a load balancer in front, set `TRUST_PROXY=1` so rate limits and the Activity log see the real client address.
- **Input.** Every request body and query string is validated (zod) before it reaches the database; SQL is always parameterised.
- **Logs.** Structured JSON logs (pino) with a request id on every line; secrets are redacted. `LOG_LEVEL=debug|info|warn|error`.
- **Offline copy.** The installable web app keeps only the reading endpoints (announcements, meetings, alerts) for offline use, for one day, and clears them at sign-out. People lists, reports and the activity log are never cached.

## Folder layout

Want to understand the code itself? Read **[CODE-GUIDE.md](CODE-GUIDE.md)** — every file explained, plus one request followed end to end.

```
pro/
├── package.json     npm run dev / npm start / npm stop (see below)
├── scripts/         upnotice.mjs – the launcher behind those commands
├── server/          Node.js + Express API (PostgreSQL, or SQLite in data/upnotice.db)
│   ├── src/         index.js (entry), db.js (schema + database layer), routes/, seed.js (demo data),
│   │                mail.js (email), activity.js (activity log), migrate-to-postgres.js (SQLite → PostgreSQL)
│   └── test/        api.test.js – end-to-end smoke test (132 checks)
└── app/             React + TypeScript (Vite)
    ├── src/         screens/, components/, api.ts, store.tsx
    ├── electron/    Desktop wrapper
    └── capacitor.config.ts   Mobile wrapper config
```

## Starting UpNotice

Open a terminal in the `pro` folder (in File Explorer: click the address bar, type `cmd`, Enter) and run **one** of these:

```bash
npm run dev      # development mode (live reload while you change code)
npm start        # Docker mode ("just run it")
npm stop         # stop everything
```

Both modes open **http://localhost:4000** in your browser when ready and print which database is in use. Other commands: `npm run logs` (Docker log), `npm run setup` (install packages + create `server/.env`), `npm run db:reset` (**wipe the database** and put the demo accounts back — asks you to type RESET first; works for Supabase, Docker and SQLite; uploaded files and any old SQLite file are moved to `server/data/backup/`), `npm test` (unit tests + API checks against a private throwaway server), `npm run build`, `npm run desktop`.

- **`npm run dev`** starts the PostgreSQL container, installs packages if needed, clears the Vite cache and runs the API (port 4001) and the app (port 4000) in the same window with `[api]` / `[app]` prefixes. **Ctrl+C stops both.** If Docker Desktop isn't running it says so and uses the SQLite file instead.
- **`npm start`** rebuilds the Docker image and starts PostgreSQL + UpNotice in the background; the window can be closed afterwards. Containers: `upnotice` (app + API) and `upnotice-db` (PostgreSQL).

The old double-click files still work — `start.bat` runs `npm run dev`, `start-docker.bat` runs `npm start`. Run one mode **or** the other, not both; each one first cleans up whatever the other left running (old containers, stale processes on ports 4000/4001, old app cache), which is also the fix if you ever see `Request failed (404)` or a blank page.

## Database

UpNotice uses **PostgreSQL**. Docker Compose runs it for you as the container **`upnotice-db`** (image `postgres:16`, user/password/database all `upnotice`, reachable from your PC at `localhost:5433`). The server connects using `DATABASE_URL` in `server/.env`:

```
DATABASE_URL=postgres://upnotice:upnotice@127.0.0.1:5433/upnotice
```

Any other PostgreSQL works too — a server you already have, or a cloud service. Tables are created and upgraded automatically on the first start.

**Using Supabase (cloud PostgreSQL, free tier):**

1. https://supabase.com → **New project** (Singapore region is closest to the Philippines) → choose a database password and keep it.
2. In the project click **Connect** (top bar) → **Session pooler** → copy the URI, e.g. `postgresql://postgres.abcd1234:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`, and replace `[YOUR-PASSWORD]` with the password from step 1. (Use the *session* pooler on port 5432, not the transaction pooler on 6543.)
3. Open `server/.env` (create it from `.env.example` if it doesn't exist) and set `DATABASE_URL=` to that string.
4. Start as usual — `npm run dev` or `npm start`. The launcher sees the cloud address and **skips the local database container**: the log shows `Database: PostgreSQL in the cloud — Supabase (...)`. Tables are created and the demo accounts (or your old SQLite data, if `server/data/upnotice.db` exists) are loaded on the first start.

With Supabase, Docker is only needed for `npm start` (the `upnotice` container); `npm run dev` needs no Docker at all. View and edit the data in Supabase's **Table Editor** (`npm run db` / `npm run db:web` are for the local container only). Uploaded files (attachments, photos) still live in `server/data/uploads` on the server, not in Supabase. To go back to the local database, remove or comment out `DATABASE_URL` in `server/.env`.

Encryption is switched on automatically for any non-local address (`DATABASE_SSL=false` turns it off, `DATABASE_SSL=true` forces it). You can view and edit the data in Supabase's own **Table Editor**. Uploaded files (attachments, photos) still live in `server/data/uploads` on the server, not in Supabase.

**Coming from the SQLite version?** Nothing to do: the first time the server starts with `DATABASE_URL` set and finds the old `server/data/upnotice.db` (or the Docker volume's copy), it copies every table into PostgreSQL. You can also run it by hand with `npm run migrate:pg` in `server/`. Uploaded files stay in `server/data/uploads`.

**SQLite mode:** leave `DATABASE_URL` out of `.env` and the server uses the single file `server/data/upnotice.db` — handy for a quick test on a PC without Docker. Everything works the same; PostgreSQL is simply the better choice for real use with several companies.

**Opening the database** (to look at or edit the tables directly):

- **In the browser:** `npm run db:web` from the `pro` folder starts a small database web page (Adminer, container `upnotice-db-web`) and opens http://localhost:4040 — enter the password `upnotice` and you can click through every table, edit rows and run SQL. It only runs when you start it; `npm stop` stops it. (The database port itself, `localhost:5433`, is not a web page — a browser can't open it.)
- Command line: `npm run db` — opens the PostgreSQL prompt (`psql`) inside the container. Try `\dt` (list tables), `SELECT * FROM users;`, `\q` (quit).
- With a program: install the free **DBeaver** (https://dbeaver.io) or **pgAdmin**, choose *PostgreSQL* and connect with host `localhost`, port `5433`, database `upnotice`, user `upnotice`, password `upnotice`. Then you can browse and edit every table like a spreadsheet.
- In SQLite mode the data is the single file `server/data/upnotice.db` — open it with **DB Browser for SQLite** (https://sqlitebrowser.org).

Change the database password before real use: put `DB_PASSWORD=...` in a `.env` file next to `docker-compose.yml` (Compose uses it for both containers) and update `DATABASE_URL` in `server/.env` to match.

## Docker (what `npm start` runs)

Requires Docker Desktop. `npm start` runs `docker compose up -d --build` for you, then opens http://localhost:4000 — the API and the web app are both served from there. Docker Desktop shows the two containers grouped under the project: **upnotice** (app + API) and **upnotice-db** (PostgreSQL).
Data is stored in Docker volumes (`upnotice-pgdata` for the database, `upnotice-data` for uploaded files), so it survives restarts and rebuilds.

Useful commands:

```bash
docker compose logs -f          # watch the server log
docker compose restart          # restart
docker compose down             # stop (data is kept)
docker compose down -v          # stop AND delete the database + uploads (fresh demo data next start)
docker compose up -d --build    # rebuild after changing code
docker compose up -d db         # start only PostgreSQL (what npm run dev does for dev mode)
```

The container reads `server/.env` (Compose `env_file`), so `JWT_SECRET`, email settings and `APP_PUBLIC_URL` only need to be set there. `npm start` generates `JWT_SECRET` if it is missing and passes `SEED_DEMO=1` so the demo accounts exist (everyone must pick a new password at the first sign-in). Running `docker compose up` by hand without `SEED_DEMO` creates one admin with a random password printed in `docker compose logs`. The database port is published on `127.0.0.1` only.

To reach it from phones on the same Wi‑Fi, use your PC's LAN IP, e.g. `http://192.168.1.10:4000`, as the Server address in the mobile app.

## Running the pieces by hand (what `npm run dev` does)

### 1. Run the server

```bash
cd server
npm install
copy .env.example .env      # (Windows)  – then set JWT_SECRET (npm run setup does this) and DATABASE_URL, see "Database" above
docker compose up -d db     # start PostgreSQL (skip this to use the SQLite file instead)   – from the pro folder
npm run dev                 # dev: API on :4001 (Vite owns :4000)   |   npm start → API + built app on :4000
```

The first start creates the tables and the demo accounts listed at the top of this file. A database from an earlier version is upgraded automatically on the next start. The startup log shows which database is in use (`Database: PostgreSQL (encrypted, certificate verified)` or `Database: SQLite (...)`), and so does http://localhost:4000/api/health.

**Checks** (all from the `pro` folder): `npm run lint` (ESLint over server + app), `npm run typecheck`, `npm run test:unit` (Vitest: password rules, upload sniffing, validation, lockout, tokens), `npm run test:api` (152 end-to-end checks against a running server, `API_URL=http://localhost:4100` to point elsewhere), `npm run format` (Prettier). GitHub Actions (`.github/workflows/ci.yml`) runs all of them plus a dependency audit on every push.

### 2. Run the web app (development)

```bash
cd app
npm install
npm run dev          # http://localhost:4000  (forwards /api to the dev API on :4001)
```

For a production web version: `npm run build` — the server automatically serves `app/dist` at http://localhost:4000, so one server hosts both the API and the web app.

## Windows desktop app (Electron)

```bash
cd app
npm run desktop          # builds and opens the desktop window
npm run desktop:build    # creates an installer in app/release/  (UpNotice Setup.exe)
```

On first sign-in, tap **Server:** on the login screen to point the app at your server address.

## Android / iOS apps (Capacitor)

Requirements: Android Studio (Android) or Xcode on a Mac (iOS).

```bash
cd app
npx cap add android      # once
npx cap add ios          # once, Mac only
npm run mobile:android   # builds the web app, syncs it, opens Android Studio → Run
```

On the phone's login screen, open **Server** and enter your PC's LAN address, e.g. `http://192.168.1.10:4000` (find it with `ipconfig`). Phone and PC must be on the same Wi-Fi, and Windows Firewall must allow port 4000.

## Email notifications & "Forgot password?"

Out of the box the server prints `Email: disabled` and everything works without email. To also send emails (new announcement, meeting invite, reminder, minutes, password-reset link), add **one** of these to `server/.env` and restart:

**Option A — any mailbox over SMTP** (Gmail: Google Account → Security → 2-Step Verification → *App passwords*, then use that 16-character password):
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
```
**Option B — Resend** (https://resend.com, free tier, made for apps): `RESEND_API_KEY=re_xxxx` and verify your domain there (or use `onboarding@resend.dev` as sender while testing).

Also set `MAIL_FROM="UpNotice <no-reply@yourcompany.com>"` and, once the app has a real address, `APP_PUBLIC_URL=https://…` so the links in emails (and the reset link) point to it. The log then shows `Email: enabled (SMTP …)` or `enabled (Resend)`, and `Settings` in the app shows an **Email notifications** switch per person. **Forgot password?** on the sign-in screen sends a link valid for 1 hour; without email set up it tells the person to ask the admin instead (People → Edit → new password).

## Installing as an app (PWA)

The web app is installable: open http://localhost:4000 (or your real address, HTTPS needed outside localhost) in Chrome or Edge → address-bar **Install** icon (or ⋮ → *Install UpNotice*); on Android Chrome → ⋮ → *Add to Home screen*; on iPhone Safari → Share → *Add to Home Screen*. It opens in its own window with the UpNotice icon, the last loaded screens still open briefly offline, and updates itself when you deploy a new build. The native Electron / Capacitor apps below are still there for tray icons, push notifications and store distribution.

## Push notifications when the app is closed (mobile)

Alerts while the app is open already work everywhere. For alerts when the phone app is **closed**, connect Firebase Cloud Messaging (free):

1. Go to https://console.firebase.google.com → **Add project** (e.g. "UpNotice").
2. **Project settings → Service accounts → Generate new private key**. Save the JSON as `server/firebase-service-account.json` and add to `server/.env`:
   `FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json` (for Docker, also add it under `volumes:` in docker-compose.yml). Restart the server — the log shows `Push notifications enabled (project …)`.
3. **Android**: in Firebase add an Android app with package name `com.upright.upnotice`, download `google-services.json` into `app/android/app/`, then `npx cap sync android`.
4. **iOS** (Mac + Apple developer account): add an iOS app in Firebase, upload your APNs key, put `GoogleService-Info.plist` in the Xcode project, enable Push Notifications + Background Modes → Remote notifications.
5. In the app, tap **Settings → Enable notifications**. The status line shows whether the device registered.

The server stores each device's token (`device_tokens` table) and sends a push for every in-app notification: announcements, invites, reminders, comments.

## Bulk-importing employees

People → **Import** → download the template, fill in **Name, Email, Password, Company, Department, Role** (password and role optional), upload. Missing companies/departments are created automatically (tick-box), blank passwords are generated and shown once.

Big files are fine — tested with **10,000 employees**: with passwords in the file the import takes about a second; with blank passwords each generated password has to be encrypted (about 80 ms each, spread over your CPU cores), so 10,000 take a few minutes — a progress bar shows how far it is, and the import keeps running on the server even if you close the sheet. The People screen searches and pages on the server (100 at a time), an announcement to 10,000 people posts in well under a second, and the read-receipt / attendee lists show the first 300 people with the full counts (Reports has everyone).

## Deploying for real use

The server is a single Node process plus PostgreSQL — `docker compose up -d --build` runs both on any small VPS or an office PC. Checklist:

1. `server/.env`: a real `JWT_SECRET` (generated by `npm run setup`), `APP_PUBLIC_URL=https://…` (your address; also used for email links), `DATABASE_URL` (or the Docker database with `DB_PASSWORD` set in a `.env` next to `docker-compose.yml`), `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the first admin (or read the random one from the log), email settings if you want them.
2. Put it behind HTTPS (e.g. Caddy or nginx with Let's Encrypt) and set `TRUST_PROXY=1`.
3. Do **not** set `SEED_DEMO`; leave `CORS_ORIGIN` unset unless another website must call the API.
4. Set that `https://…` address in each app's Server setting. Back up the `upnotice-pgdata` and `upnotice-data` volumes.

## API summary

All endpoints except sign-in, refresh and forgot/reset need `Authorization: Bearer <access token>`. Bodies are validated; a bad value answers `400 {error}`. Rate limits answer `429`.

| Method | Path | Who |
|--------|------|-----|
| POST | /api/auth/login → `{token, refresh_token, expires_in, user}` · /api/auth/refresh `{refresh_token}` (rotates) · /api/auth/logout · /api/auth/logout-all · GET /api/auth/sessions | all · signed in |
| POST | /api/auth/ticket `{path}` → `{url}` (a 2-minute link for one file: attachment, `.ics`, CSV export, import template) | signed in |
| GET/PATCH | /api/auth/me (`email_notifications`) · POST /api/auth/change-password (clears `must_change_password`, signs out other devices) | signed in |
| POST | /api/auth/forgot `{email}` · /api/auth/reset `{token,password}` | all (needs email set up) |
| GET | /api/dashboard | signed in |
| GET/POST/PATCH/DELETE | /api/companies | list: all · edit: admin |
| GET/POST/PATCH/DELETE | /api/departments | list: all · edit: admin (`company_id` required on create) |
| GET/POST/PATCH/DELETE | /api/users (`?q, company_id, role, limit, offset` → `total`) | admin · manager (own company, employees only) |
| GET/POST/PATCH/DELETE | /api/announcements · GET /:id · POST /:id/read | list filters `?q, category, company_id, department_id, from, to, status, unread, limit, offset` (with `limit` the answer adds `total` + `has_more`); `draft:true` saves a draft, PATCH `draft:false` publishes; employees see only what targets them |
| GET | /api/announcements/categories | signed in |
| GET/POST/DELETE | /api/templates | staff (admin or manager) |
| GET/POST/PATCH/DELETE | /api/meetings · GET /:id · POST /:id/rsvp | same filters as announcements |
| POST | /api/meetings/:id/attendance `{user_id,present}` · /:id/checkin `{code}` · PATCH /:id/minutes · GET /:id/ics | staff · invitee · staff · signed in |
| GET | /api/activity `?limit, before, action, user_id, q, from, to` · DELETE /:id · POST /delete `{ids}` | admin (deleting an entry is itself recorded) |
| GET | /api/notifications · POST /read-all · POST /:id/read · DELETE /:id · POST /delete `{ids|read|all}` | signed in |
| GET | /api/notifications/stream | Server-Sent Events live feed (open it with `fetch` + the Bearer header; the app reconnects by itself) |
| POST | /api/announcements/:id/acknowledge · /:id/vote · GET /:id/files/:fileId | signed in |
| GET/POST/DELETE | /api/comments/:type/:id · /api/comments/:commentId | signed in |
| GET | /api/reports/summary · /api/reports/export/:kind.csv | admin · manager (own company) |
| POST | /api/users/import (returns results, or `202` + `job` for big files) · GET /api/users/import/:job (progress) · GET /api/users/import-template | admin · manager |
| POST/DELETE/GET | /api/auth/avatar · /api/auth/avatar/:userId · GET /api/auth/my-history | signed in |
| POST | /api/devices/register | signed in (mobile push token) |

Attachments and photos are stored in `server/data/uploads/` (inside the `upnotice-data` Docker volume).

## Ideas for next steps

- Email digests (one daily summary instead of one email per post) for people who haven't opened the app
- Read-only "TV mode" for a lobby screen
