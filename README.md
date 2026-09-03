# UpNotice

**UpNotice** by Upright Solutions — company announcements and employee meetings in one codebase that runs as a **web app**, a **Windows desktop app** (Electron) and **Android / iOS apps** (Capacitor), backed by your own **Node.js + PostgreSQL** server (a single-file SQLite mode is also available for quick tests).

## What it does

**Admins (management)**
- Manage several **companies** — each employee and department belongs to one; the admin sees all of them
- Post announcements (normal / important / urgent, optional pin) to **all companies**, one company, or specific departments in it
- **Attach files** (images, PDF, Word, Excel…) to an announcement
- **Publish later** at a set time and/or **hide automatically** after a date
- **Require acknowledgement** ("I have read and understood") and add a **quick poll**
- See exactly who has read / acknowledged / voted, and who hasn't
- Schedule meetings (date, time, location, online link, agenda) for all companies, one company, or specific departments; **repeat weekly / every 2 weeks / monthly**
- See who is going / maybe / declined (with their reason) / hasn't replied; edit, cancel or delete meetings (one occurrence, future ones, or the whole series)
- Answer employees' **comments & questions** under any announcement or meeting
- **Reports**: read rates and attendance per company/department, per employee, per announcement and per meeting, with date filter and **CSV export** (opens in Excel)
- Manage employees (add, edit, deactivate, reset password), departments and companies — a new department can be created right inside the Add Employee form; **bulk-import employees from Excel/CSV**

**Employees**
- Home screen with unread announcements, upcoming meetings and pending replies
- Opening an announcement marks it as read automatically; acknowledge, vote in polls, download attachments
- RSVP to meetings (Going / Maybe / Can't go with a reason) — change anytime; reminder 1 hour before each meeting
- Ask questions / comment under announcements and meetings
- Profile photo and personal attendance history (Settings)
- In-app notification feed (Alerts) + live updates the moment something is posted; delete single alerts, select several to delete, or clear read / clear all
- System notifications on phone and desktop while the app is open; **push notifications when the app is closed** (mobile, after the Firebase setup below)

## Sign-in accounts (demo data)

These accounts are created automatically the first time the server starts:

| Role     | Email               | Password  | Company / department              |
|----------|---------------------|-----------|-----------------------------------|
| **Admin (boss)** | `admin@company.com` | `admin123` | manages all companies          |
| Employee | `maria@company.com` | `password` | Upright Solutions · Operations   |
| Employee | `jose@company.com`  | `password` | Upright Solutions · Operations   |
| Employee | `ana@company.com`   | `password` | Upright Solutions · Sales        |
| Employee | `ben@company.com`   | `password` | SixthGear · Shop                 |

Sign in as the **admin** to post announcements, schedule meetings and manage people. Sign in as an **employee** (in another browser or a private window) to see the employee side: read receipts, RSVP, comments.

**Before real use:** change the admin password (Settings → Change password) and add your real employees (People → Add / Import). To start with a completely empty database instead of the demo data, run `docker compose down -v` (deletes the PostgreSQL volume) — or, in SQLite mode, delete `server/data/upnotice.db` — before starting.

## Folder layout

```
pro/
├── package.json     npm run dev / npm start / npm stop (see below)
├── scripts/         upnotice.mjs – the launcher behind those commands
├── server/          Node.js + Express API (PostgreSQL, or SQLite in data/upnotice.db)
│   ├── src/         index.js (entry), db.js (schema + database layer), routes/, seed.js (demo data),
│   │                migrate-to-postgres.js (copies an old SQLite database into PostgreSQL)
│   └── test/        api.test.js – end-to-end smoke test (86 checks)
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

Both modes open **http://localhost:4000** in your browser when ready and print which database is in use. Other commands: `npm run logs` (Docker log), `npm run setup` (install packages + create `server/.env`), `npm test` (API checks, server must be running), `npm run build`, `npm run desktop`.

- **`npm run dev`** starts the PostgreSQL container, installs packages if needed, clears the Vite cache and runs the API (port 4001) and the app (port 4000) in the same window with `[api]` / `[app]` prefixes. **Ctrl+C stops both.** If Docker Desktop isn't running it says so and uses the SQLite file instead.
- **`npm start`** rebuilds the Docker image and starts PostgreSQL + UpNotice in the background; the window can be closed afterwards. Containers: `upnotice` (app + API) and `upnotice-db` (PostgreSQL).

The old double-click files still work — `start.bat` runs `npm run dev`, `start-docker.bat` runs `npm start`. Run one mode **or** the other, not both; each one first cleans up whatever the other left running (old containers, stale processes on ports 4000/4001, old app cache), which is also the fix if you ever see `Request failed (404)` or a blank page.

## Database

UpNotice uses **PostgreSQL**. Docker Compose runs it for you as the container **`upnotice-db`** (image `postgres:16`, user/password/database all `upnotice`, reachable from your PC at `localhost:5433`). The server connects using `DATABASE_URL` in `server/.env`:

```
DATABASE_URL=postgres://upnotice:upnotice@127.0.0.1:5433/upnotice
```

Any other PostgreSQL works too (a server you already have, or a cloud service such as Neon, Supabase or Railway) — just paste its connection string into `DATABASE_URL`. Tables are created and upgraded automatically on the first start.

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

Set a real secret before real use: create a `.env` file next to `docker-compose.yml` with `JWT_SECRET=some-long-random-string`.

To reach it from phones on the same Wi‑Fi, use your PC's LAN IP, e.g. `http://192.168.1.10:4000`, as the Server address in the mobile app.

## Running the pieces by hand (what `npm run dev` does)

### 1. Run the server

```bash
cd server
npm install
copy .env.example .env      # (Windows)  – then edit JWT_SECRET (and DATABASE_URL, see "Database" above)
docker compose up -d db     # start PostgreSQL (skip this to use the SQLite file instead)   – from the pro folder
npm run dev                 # dev: API on :4001 (Vite owns :4000)   |   npm start → API + built app on :4000
```

The first start creates the tables and the demo accounts listed at the top of this file. A database from an earlier version is upgraded automatically on the next start. The startup log shows which database is in use (`Database: PostgreSQL` or `Database: SQLite (...)`), and so does http://localhost:4000/api/health.

Test the API any time with `npm test` (server must be running).

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

## Deploying for real use

The server is a single Node process plus PostgreSQL — `docker compose up -d --build` runs both on any small VPS or an office PC. Put it behind HTTPS (e.g. Caddy or nginx with Let's Encrypt) and set `CORS_ORIGIN` in `.env`. Then set that `https://…` address in each app's Server setting.

## API summary

| Method | Path | Who |
|--------|------|-----|
| POST | /api/auth/login | all |
| GET | /api/auth/me · POST /api/auth/change-password | signed in |
| GET | /api/dashboard | signed in |
| GET/POST/PATCH/DELETE | /api/companies | list: all · edit: admin |
| GET/POST/PATCH/DELETE | /api/departments | list: all · edit: admin (`company_id` required on create) |
| GET/POST/PATCH/DELETE | /api/users | admin |
| GET/POST/PATCH/DELETE | /api/announcements · GET /:id · POST /:id/read | employees see only what targets them |
| GET/POST/PATCH/DELETE | /api/meetings · GET /:id · POST /:id/rsvp | same |
| GET | /api/notifications · POST /read-all · POST /:id/read · DELETE /:id · POST /delete `{ids|read|all}` | signed in |
| GET | /api/notifications/stream | Server-Sent Events live feed |
| POST | /api/announcements/:id/acknowledge · /:id/vote · GET /:id/files/:fileId | signed in |
| GET/POST/DELETE | /api/comments/:type/:id · /api/comments/:commentId | signed in |
| GET | /api/reports/summary · /api/reports/export/:kind.csv | admin |
| POST | /api/users/import · GET /api/users/import-template | admin |
| POST/DELETE/GET | /api/auth/avatar · /api/auth/avatar/:userId · GET /api/auth/my-history | signed in |
| POST | /api/devices/register | signed in (mobile push token) |

Attachments and photos are stored in `server/data/uploads/` (inside the `upnotice-data` Docker volume).

## Ideas for next steps

- Email digests for people who haven't opened the app
- Read-only "TV mode" for a lobby screen
