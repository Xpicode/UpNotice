# TeamAnnounce

Company announcements and employee meetings — one codebase that runs as a **web app**, a **Windows desktop app** (Electron) and **Android / iOS apps** (Capacitor), backed by your own **Node.js + SQLite** server.

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
- In-app notification feed + live updates the moment something is posted
- System notifications on phone and desktop while the app is open; **push notifications when the app is closed** (mobile, after the Firebase setup below)

## Folder layout

```
pro/
├── server/          Node.js + Express API, SQLite database (data/teamannounce.db)
│   ├── src/         index.js (entry), db.js (schema), routes/, seed.js (demo data)
│   └── test/        api.test.js – end-to-end smoke test (78 checks)
└── app/             React + TypeScript (Vite)
    ├── src/         screens/, components/, api.ts, store.tsx
    ├── electron/    Desktop wrapper
    └── capacitor.config.ts   Mobile wrapper config
```

## Quickest way: Docker (server + web app in one container)

Requires Docker Desktop. From the `pro` folder:

```bash
docker compose up -d --build
```

Then open http://localhost:4000 — the API and the web app are both served from there.
The database is stored in a Docker volume (`teamannounce-data`), so it survives restarts and rebuilds.

Useful commands:

```bash
docker compose logs -f          # watch the server log
docker compose restart          # restart
docker compose down             # stop (data is kept)
docker compose down -v          # stop AND delete the database (fresh demo data next start)
docker compose up -d --build    # rebuild after changing code
```

Set a real secret before real use: create a `.env` file next to `docker-compose.yml` with `JWT_SECRET=some-long-random-string`.

To reach it from phones on the same Wi‑Fi, use your PC's LAN IP, e.g. `http://192.168.1.10:4000`, as the Server address in the mobile app.

The steps below are for running **without** Docker.

## 1. Run the server

```bash
cd server
npm install
copy .env.example .env      # (Windows)  – then edit JWT_SECRET
npm start
```

The first start creates the database and demo accounts:

| Role     | Email               | Password  |
|----------|---------------------|-----------|
| Admin    | admin@company.com   | admin123  |
| Employee | maria@company.com   | password  |
| Employee | jose@company.com    | password  |
| Employee | ana@company.com     | password  |
| Employee | ben@company.com     | password  |

Demo companies: **Upright Solutions** (Maria, Jose, Ana) and **SixthGear** (Ben). The admin is not tied to a company.
If you already had a database from an earlier version, it is upgraded automatically on the next start — your existing departments and employees are put into a company called "Main Company", which you can rename under People → Companies.

Change these (People → Edit) before real use. To start with a completely empty database, delete `server/data/` — the seed only runs when there are no users.

Test the API any time with `npm test` (server must be running).

## 2. Run the web app (development)

```bash
cd app
npm install
npm run dev          # http://localhost:5173  (proxies /api to the server on :4000)
```

For a production web version: `npm run build` — the server automatically serves `app/dist` at http://localhost:4000, so one server hosts both the API and the web app.

## 3. Windows desktop app (Electron)

```bash
cd app
npm run desktop          # builds and opens the desktop window
npm run desktop:build    # creates an installer in app/release/  (TeamAnnounce Setup.exe)
```

On first sign-in, tap **Server:** on the login screen to point the app at your server address.

## 4. Android / iOS apps (Capacitor)

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

1. Go to https://console.firebase.google.com → **Add project** (e.g. "TeamAnnounce").
2. **Project settings → Service accounts → Generate new private key**. Save the JSON as `server/firebase-service-account.json` and add to `server/.env`:
   `FIREBASE_SERVICE_ACCOUNT=./firebase-service-account.json` (for Docker, also add it under `volumes:` in docker-compose.yml). Restart the server — the log shows `Push notifications enabled (project …)`.
3. **Android**: in Firebase add an Android app with package name `com.upright.teamannounce`, download `google-services.json` into `app/android/app/`, then `npx cap sync android`.
4. **iOS** (Mac + Apple developer account): add an iOS app in Firebase, upload your APNs key, put `GoogleService-Info.plist` in the Xcode project, enable Push Notifications + Background Modes → Remote notifications.
5. In the app, tap **Settings → Enable notifications**. The status line shows whether the device registered.

The server stores each device's token (`device_tokens` table) and sends a push for every in-app notification: announcements, invites, reminders, comments.

## Bulk-importing employees

People → **Import** → download the template, fill in **Name, Email, Password, Company, Department, Role** (password and role optional), upload. Missing companies/departments are created automatically (tick-box), blank passwords are generated and shown once.

## Deploying for real use

The server is a single Node process with a SQLite file — it runs on any small VPS, a Raspberry Pi, or an office PC. Put it behind HTTPS (e.g. Caddy or nginx with Let's Encrypt) and set `CORS_ORIGIN` in `.env`. Then set that `https://…` address in each app's Server setting.

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
| GET | /api/notifications · POST /read-all · POST /:id/read | signed in |
| GET | /api/notifications/stream | Server-Sent Events live feed |
| POST | /api/announcements/:id/acknowledge · /:id/vote · GET /:id/files/:fileId | signed in |
| GET/POST/DELETE | /api/comments/:type/:id · /api/comments/:commentId | signed in |
| GET | /api/reports/summary · /api/reports/export/:kind.csv | admin |
| POST | /api/users/import · GET /api/users/import-template | admin |
| POST/DELETE/GET | /api/auth/avatar · /api/auth/avatar/:userId · GET /api/auth/my-history | signed in |
| POST | /api/devices/register | signed in (mobile push token) |

Attachments and photos are stored in `server/data/uploads/` (inside the Docker volume).

## Ideas for next steps

- Move from SQLite to Postgres when there are many companies
- Email digests for people who haven't opened the app
- Read-only "TV mode" for a lobby screen
