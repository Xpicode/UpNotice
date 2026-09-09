# Security

How UpNotice protects accounts and data, what you must do when you deploy it, and how to report a problem.
No software is "unhackable"; this is the list of what is covered and what is left to the person running it.

## What the code does

**Sign-in and sessions**

- **Two-factor authentication** (an authenticator app, TOTP — or a code emailed to the account, see below): once it is on, the password alone gets nothing but a five-minute token that can only be spent on the code step. Each code works once — a code read over a shoulder or out of a proxy log is already spent. Wrong codes count towards the same lockout as wrong passwords. Ten single-use recovery codes are issued for a lost phone, stored hashed. The secret is kept encrypted with a key derived from `JWT_SECRET`, which lives in `.env` and never in the database, so a stolen database dump on its own cannot generate anyone's codes. Turning it off needs the password **and** a current code; an admin can reset it for someone else who is locked out, and that reset is written to the activity log.
- Passwords are stored as bcrypt hashes. Minimum 8 characters; the current password, the email address and common passwords are refused. Passwords set by staff are temporary and must be changed at first sign-in.
- Signing in creates a session row and returns a short-lived access token (JWT, 1 hour) plus a refresh token (30 days). The refresh token is stored hashed and is replaced on every use; the old one stops working immediately.
- Every request checks the session row, so "Sign out everywhere", a password change or an admin deactivating the account takes effect at once.
- Wrong passwords: 30 attempts per address per 15 minutes, and 10 wrong passwords lock the account for 15 minutes regardless of address. Unknown emails take the same time to answer as known ones. Failed attempts are written to the activity log.
- Tokens are never accepted in URLs. Files and CSV downloads use a 2-minute ticket bound to one exact path.
- Password-reset links are single-use, expire after 1 hour and are stored hashed. The forgot-password endpoint answers the same way whether or not the email exists.
- The secret that signs tokens must be at least 32 random characters. Production refuses to start without one.

**Requests**

- Every request body is validated with a schema (`server/src/validate.js`); unknown fields are dropped and bad values are rejected before any database query runs.
- All database access uses parameterised queries.
- Rate limits: 600 requests per minute per address for the whole API, and tighter limits on sign-in, password reset, token refresh, second-factor codes, meeting check-ins, uploads and downloads.
- Managers can only read and change rows of their own company; employees only see what is addressed to them. Admin-only routes check the role on the server.
- Attendance cannot be awarded to yourself. Tapping "Check in" only creates a request; it counts as present once the meeting's organizer (or a manager of that company) approves it, or once the person types the code that is only shown in the room. Approving is checked on the server, not just hidden in the interface.
- A meeting's joining link must be an `http(s)` address; anything else (a `javascript:` or `data:` address that would run in another person's browser) is refused when the meeting is saved.
- The joining link for an online meeting is only sent to people whose check-in has been approved, and to the staff who run it. It is removed from the API response for everyone else, so it cannot be read out of the app's data.
- The activity log is admin-only to read. Admins can tidy it, one entry or a selection at a time, but every deletion writes its own entry afterwards recording who removed rows and how many, so the log cannot be cleared invisibly.

**Uploads**

- Files are limited in size and count, checked by their actual bytes (not the declared type), stored under random names outside the web root and served with `nosniff`. Office files must really be zip/OLE containers; images must really be images.
- Spreadsheet imports are parsed in memory with `exceljs`; formulas are never evaluated.

**Browser and apps**

- Helmet sets a Content-Security-Policy (scripts only from the app itself, no inline scripts, no framing), HSTS, `nosniff`, a referrer policy and a `Permissions-Policy` that turns off camera, microphone, location and payment APIs.
- API answers are sent with `Cache-Control: no-store`.
- Browser calls are only accepted from the app's own address, the desktop app and the mobile apps. `CORS_ORIGIN` can add exact origins; `*` is refused in production.
- The React app never inserts raw HTML. The QR code is drawn as an image.
- Electron: `contextIsolation`, `sandbox`, no Node integration; external links open in the system browser.
- Mobile (Capacitor): HTTPS scheme; plain HTTP is only enabled when you build with `CAP_CLEARTEXT=1` for LAN testing.
- Health, errors and logs never include stack traces, secrets or mail configuration.

## What you must do when deploying

1. Put the server behind HTTPS (a reverse proxy such as Caddy or nginx, or your host's TLS) and set `TRUST_PROXY=1` so rate limits and the activity log see real client addresses.
2. Set `JWT_SECRET` to a fresh random value (`npm run setup` does this) and keep `server/.env` out of backups that other people can read.
3. Set `APP_PUBLIC_URL` to the real address; leave `CORS_ORIGIN` unset unless another website must call the API.
4. Use a real PostgreSQL with TLS (`DATABASE_URL`, and `DATABASE_SSL_CA` for cloud providers). Keep the database port closed to the internet.
5. Do not set `SEED_DEMO` in production. Sign in with the first-admin password printed once in the log and change it.
6. Keep dependencies current: `npm audit` in `server/` and `app/`, and update Node.js when your version leaves support.
7. Back up the database and the upload folder; restore tests are part of security too. Notifications tidy themselves up daily (read after 90 days, unread after 180), so old ones are not carried into every backup.

## Known limits

- Two-factor by email is only as strong as the mailbox it goes to. The code is six random digits, good for ten minutes, single-use, stored hashed, burned after five wrong guesses, and only ever sent to the account's own address — but if someone owns that inbox they also own the password reset, so it adds less than an app does. It exists because a second factor people actually turn on beats one they never set up; anyone using it should give the mailbox itself a second factor.
- Two-factor authentication is available but not compulsory. Nothing forces an admin to switch it on, so turning it on for the accounts that can post to everybody and see the employee list is a decision somebody has to make and check.
- Rate limits, lockouts and the "Active now" marker on signed-in devices are kept in memory, which is right for one server process. Running several copies of the server needs a shared store for them; until then a device connected to another copy would show as not active even though it is.
- The tokens are kept in the browser's storage on the device. Anyone with full access to an unlocked device can use that session; "Sign out everywhere" in Settings revokes it.

## Reporting a problem

Email the maintainer at Upright Solutions with the steps to reproduce. Please do not post details publicly until it has been fixed.
