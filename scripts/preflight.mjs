#!/usr/bin/env node
// Preflight — is this deployment fit for real people?
//
//   npm run preflight                     checks server/.env
//   npm run preflight https://notice.co   also asks the live server
//
// Read-only: it never writes to the database, never changes a setting. Blockers make it exit non-zero,
// so it can stand between a build and a release. Run it on the machine that holds server/.env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', red: '\x1b[31m', bold: '\x1b[1m' };
const tag = `${c.bold}${c.blue}[preflight]${c.reset}`;

/** server/.env as an object. Missing file is fine — every check then reports what is not set. */
function readServerEnv() {
  const out = {};
  try {
    for (const raw of fs.readFileSync(path.join(root, 'server', '.env'), 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i > 0)
        out[line.slice(0, i).trim()] = line
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env yet */
  }
  return out;
}

const PLACEHOLDER_SECRETS = ['change-this-to-a-long-random-string', 'dev-secret-change-me', 'changeme', 'secret'];
const WEAK_PASSWORDS = ['admin', 'admin123', 'password', 'password1', 'changeme', 'letmein', 'upnotice'];

/** Everything that can be judged from the settings alone. */
export function checkConfig(env) {
  const results = [];
  const add = (level, name, detail) => results.push({ level, name, detail });
  const val = (k) => String(env[k] ?? '').trim();

  // The key that signs sign-in tokens. Everything else rests on this one being unguessable.
  const secret = val('JWT_SECRET');
  if (!secret) add('FAIL', 'JWT_SECRET', 'not set — the server refuses to start in production without it');
  else if (secret.length < 32) add('FAIL', 'JWT_SECRET', `only ${secret.length} characters; needs 32+ random ones ("npm run setup" writes one)`);
  else if (PLACEHOLDER_SECRETS.includes(secret.toLowerCase())) add('FAIL', 'JWT_SECRET', 'still an example value — anyone with the source could forge a sign-in');
  else add('PASS', 'JWT_SECRET', `${secret.length} characters`);

  // Demo accounts have published passwords.
  if (val('SEED_DEMO')) add('FAIL', 'SEED_DEMO', 'set — demo accounts with published passwords would be created');
  else add('PASS', 'SEED_DEMO', 'not set');

  // Which websites may call the API from someone's signed-in browser.
  const cors = val('CORS_ORIGIN');
  if (cors === '*') add('FAIL', 'CORS_ORIGIN', 'is "*" — any website could call your API from a signed-in browser');
  else if (cors) add('PASS', 'CORS_ORIGIN', cors);
  else add('PASS', 'CORS_ORIGIN', 'not set, so only the app itself');

  // The address that ends up in password-reset links.
  const url = val('APP_PUBLIC_URL');
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);
  if (!url) add('FAIL', 'APP_PUBLIC_URL', 'not set — reset and email links would point at localhost');
  else if (!url.startsWith('https://') && !isLocal) add('FAIL', 'APP_PUBLIC_URL', `${url} is not https — sign-in tokens would cross the network in the clear`);
  else add('PASS', 'APP_PUBLIC_URL', url);

  // Behind a reverse proxy, without this every request looks like it came from the proxy.
  if (url.startsWith('https://') && !val('TRUST_PROXY')) add('WARN', 'TRUST_PROXY', 'not set behind HTTPS — rate limits and the activity log would see the proxy, not the person');
  else if (val('TRUST_PROXY')) add('PASS', 'TRUST_PROXY', val('TRUST_PROXY'));

  const dbUrl = val('DATABASE_URL');
  const localDb = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(dbUrl);
  if (!dbUrl) add('WARN', 'DATABASE_URL', 'not set — falls back to a SQLite file. Fine for one department on one machine; move to PostgreSQL before you grow');
  else if (localDb) add('PASS', 'DATABASE_URL', 'PostgreSQL on this machine or in Docker');
  else if (/sslmode=disable/.test(dbUrl)) add('FAIL', 'DATABASE_URL', 'a remote database with sslmode=disable — that connection is unencrypted');
  else add('PASS', 'DATABASE_URL', `remote PostgreSQL (${dbUrl.replace(/^.*@/, '').replace(/[/:?].*$/, '')})`);

  const adminPassword = val('ADMIN_PASSWORD');
  if (adminPassword && WEAK_PASSWORDS.includes(adminPassword.toLowerCase())) add('FAIL', 'ADMIN_PASSWORD', 'is one of the most-guessed passwords there is');
  else if (adminPassword) add('WARN', 'ADMIN_PASSWORD', 'kept in .env as plain text — set it once, change it in the app, then delete the line');

  // Without email, nobody can reset their own password.
  if (val('RESEND_API_KEY')) add('PASS', 'Email', 'Resend');
  else if (val('SMTP_HOST')) add('PASS', 'Email', `SMTP (${val('SMTP_HOST')})`);
  else add('WARN', 'Email', 'not set up — "Forgot password?" cannot send anything, so every reset goes through an admin');

  if (val('FIREBASE_SERVICE_ACCOUNT')) add('PASS', 'Push', 'Firebase configured');
  else add('WARN', 'Push', 'not set up — phones get nothing while the app is closed');

  return results;
}

/** What only the running server can answer. */
export async function checkLive(url, fetchImpl = fetch) {
  const results = [];
  const add = (level, name, detail) => results.push({ level, name, detail });
  let res;
  try {
    res = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    add('FAIL', 'Reachable', `${url} did not answer (${err.message})`);
    return results;
  }
  const health = await res.json().catch(() => ({}));
  if (!health.ok) {
    add('FAIL', 'Reachable', `${url}/api/health did not report ok`);
    return results;
  }
  add('PASS', 'Reachable', `${health.name} ${health.version}, database ${health.database}`);

  const header = (h) => res.headers.get(h) || '';
  // HSTS is only meaningful once it really is served over HTTPS.
  if (url.startsWith('https://')) {
    if (header('strict-transport-security')) add('PASS', 'HSTS', header('strict-transport-security'));
    else add('FAIL', 'HSTS', 'missing — a browser could be talked back down to plain http');
  }
  if (header('x-content-type-options') === 'nosniff') add('PASS', 'nosniff', 'set');
  else add('FAIL', 'nosniff', 'missing');
  if (header('content-security-policy')) add('PASS', 'CSP', 'set');
  else add('WARN', 'CSP', 'missing on this response');

  // The demo password is published in the README. If it opens the door, nothing else here matters.
  try {
    const login = await fetchImpl(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@company.com', password: 'admin123' }),
      signal: AbortSignal.timeout(10000),
    });
    if (login.status === 200) {
      add('FAIL', 'Demo account', 'admin@company.com / admin123 still signs in — change it before anything else');
      // Don't leave the session this check just opened lying around for 30 days.
      const token = (await login.json().catch(() => ({}))).token;
      if (token) await fetchImpl(`${url}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }).catch(() => {});
    } else add('PASS', 'Demo account', 'the demo password does not work');
  } catch {
    add('WARN', 'Demo account', 'could not be checked');
  }
  return results;
}

async function main() {
  const env = { ...readServerEnv(), ...process.env };
  const given = process.argv[2];
  const url = String(given || env.APP_PUBLIC_URL || '').replace(/\/+$/, '');

  console.log('');
  console.log(`${tag} Checking this deployment before real people use it.`);
  console.log(`${c.dim}   server/.env${url ? ` and ${url}` : ' only — pass a URL to also check the live server'}${c.reset}\n`);

  const results = checkConfig(env);
  if (url) results.push(...(await checkLive(url)));

  const mark = { PASS: `${c.green}PASS${c.reset}`, WARN: `${c.yellow}WARN${c.reset}`, FAIL: `${c.red}FAIL${c.reset}` };
  for (const r of results) console.log(`  ${mark[r.level]}  ${r.name.padEnd(16)} ${c.dim}${r.detail}${c.reset}`);

  const blockers = results.filter((r) => r.level === 'FAIL').length;
  const warnings = results.filter((r) => r.level === 'WARN').length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  console.log('');
  if (blockers) {
    console.log(`${c.bold}${c.red}[preflight]${c.reset} ${plural(blockers, 'blocker')} and ${plural(warnings, 'warning')}. Fix the blockers before anyone signs in.`);
  } else if (warnings) {
    console.log(`${c.bold}${c.yellow}[preflight]${c.reset} No blockers, ${plural(warnings, 'warning')} — each one is something you are choosing to live without.`);
  } else {
    console.log(`${tag} ${c.green}No blockers and no warnings.${c.reset}`);
  }
  console.log(`${c.dim}   Two things this cannot check: that you have restored from a backup at least once,${c.reset}`);
  console.log(`${c.dim}   and that the people in the pilot know who to tell when something looks wrong.${c.reset}\n`);
  process.exit(blockers ? 1 : 0);
}

// Importable for the tests; only runs the report when called as a command.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
