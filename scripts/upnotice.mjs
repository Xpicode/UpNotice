#!/usr/bin/env node
// UpNotice launcher — one command from the pro folder, no .bat files needed:
//   npm run dev     development mode (live reload): PostgreSQL in Docker (or SQLite), API on 4001, app on 4000
//   npm start       Docker mode: builds and starts PostgreSQL + UpNotice, opens http://localhost:4000
//   npm stop        stops everything (containers and dev processes)
//   npm run setup   installs packages for server/ and app/
//   npm run db      opens the PostgreSQL prompt (psql) in the database container
//   npm run db:web  opens a web page to browse/edit the database (http://localhost:4040)
//   npm run db:reset  wipes the database (asks first) and puts the demo accounts back
//   npm run logs    follows the Docker log
// Works on Windows, macOS and Linux. Only uses what ships with Node.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const appDir = path.join(root, 'app');
const win = process.platform === 'win32';
const APP_URL = 'http://localhost:4000';
const DEV_DATABASE_URL = 'postgres://upnotice:upnotice@127.0.0.1:5433/upnotice';

// Everything printed is also written to upnotice.log in the pro folder (overwritten on every run),
// so the full startup output can be checked even after the window scrolled.
const logFile = path.join(root, 'upnotice.log');
try {
  fs.writeFileSync(logFile, `UpNotice launcher — ${new Date().toISOString()} — ${process.argv.slice(2).join(' ')}\n`);
} catch {
  /* read-only folder: no log file */
}
const rawWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try {
    // eslint-disable-next-line no-control-regex
    fs.appendFileSync(logFile, String(chunk).replace(/\x1b\[[0-9;]*m/g, ''));
  } catch {
    /* ignore */
  }
  return rawWrite(chunk, ...rest);
};

const c = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', red: '\x1b[31m', bold: '\x1b[1m' };
const log = (msg) => console.log(`${c.bold}${c.blue}[upnotice]${c.reset} ${msg}`);
const warn = (msg) => console.log(`${c.bold}${c.yellow}[upnotice]${c.reset} ${msg}`);
const fail = (msg) => {
  console.log(`${c.bold}${c.red}[upnotice]${c.reset} ${msg}`);
  process.exit(1);
};

// ---------- helpers ----------
// On Windows npm/npx/docker are .cmd files, which need a shell; pass one command string so Node
// doesn't warn about unescaped arguments (our arguments never contain spaces or quotes).
function shellForm(cmd, args) {
  return win ? [`${cmd} ${args.join(' ')}`.trim(), []] : [cmd, args];
}
function run(cmd, args, opts = {}) {
  const [c0, a0] = shellForm(cmd, args);
  return spawnSync(c0, a0, { cwd: root, encoding: 'utf8', shell: win, windowsHide: true, ...opts });
}
function ok(result) {
  return result.status === 0;
}
function docker(...args) {
  return run('docker', args, { stdio: 'pipe' });
}
function dockerAvailable() {
  const r = run('docker', ['info'], { stdio: 'pipe', timeout: 15000 });
  return ok(r);
}

function killPort(port) {
  if (win) {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (line.includes(`:${port} `) && /LISTENING/.test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
    }
    for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    return pids.size;
  }
  const out = run('sh', ['-c', `lsof -ti tcp:${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`], { stdio: 'pipe', shell: false }).stdout || '';
  const pids = out.split(/\s+/).filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return pids.length;
}

/** Reads server/.env (KEY=VALUE lines) — the launcher needs DATABASE_URL to know whether a cloud database is configured. */
function readServerEnv() {
  const out = {};
  try {
    for (const raw of fs.readFileSync(path.join(serverDir, '.env'), 'utf8').split(/\r?\n/)) {
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
/**
 * Makes sure server/.env has a real JWT_SECRET (the key that signs sign-in tokens). Generates a random one the
 * first time. Returns the secret so Docker mode can pass it to the container.
 */
function ensureJwtSecret() {
  const weak = (v) => !v || v.length < 32 || v === 'change-this-to-a-long-random-string' || v === 'dev-secret-change-me';
  const current = readServerEnv().JWT_SECRET;
  if (!weak(current)) return current;
  const secret = crypto.randomBytes(48).toString('base64url');
  const envFile = path.join(serverDir, '.env');
  let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  if (/^JWT_SECRET=.*$/m.test(text)) text = text.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
  else text += `\nJWT_SECRET=${secret}\n`;
  fs.writeFileSync(envFile, text);
  log(`Generated a random JWT_SECRET and saved it in server/.env${fs.existsSync(envFile) ? '' : ' (created from .env.example)'}.`);
  return secret;
}

/** A DATABASE_URL that is not our local Docker container (e.g. Supabase, Neon, Railway). */
function cloudDatabaseUrl() {
  const url = process.env.DATABASE_URL || readServerEnv().DATABASE_URL || '';
  return url && !/@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url) ? url : null;
}
function describeCloud(url) {
  const host = url.replace(/^.*@/, '').replace(/[/:?].*$/, '');
  return /supabase/.test(host) ? `Supabase (${host})` : /neon/.test(host) ? `Neon (${host})` : host;
}

function stopOldStuff(hasDocker) {
  if (hasDocker) {
    docker('compose', 'rm', '-sf', 'upnotice'); // old app container (the database container keeps running)
    docker('rm', '-f', 'teamannounce');
  }
  for (const port of [4000, 4001]) killPort(port);
}

/** Runs npm install when node_modules is missing or any package from package.json is not installed yet. */
function ensureInstalled(dir, label) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const wanted = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const missing = wanted.filter((name) => !fs.existsSync(path.join(dir, 'node_modules', name, 'package.json')));
  if (missing.length === 0) return;
  log(`Installing ${label} packages (${fs.existsSync(path.join(dir, 'node_modules')) ? 'new: ' + missing.join(', ') : 'first time'})...`);
  const r = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  if (!ok(r)) fail(`npm install failed in ${label}`);
}

async function waitForHealth(url, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function openBrowser(url) {
  if (win) spawnSync('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true });
  else if (process.platform === 'darwin') run('open', [url], { stdio: 'ignore', shell: false });
  else run('xdg-open', [url], { stdio: 'ignore', shell: false });
}

/** Starts a long-running child and prefixes every output line. */
function startChild(label, color, cmd, args, opts, onLine) {
  // On macOS/Linux the child gets its own process group so we can stop npm + node together.
  const [c0, a0] = shellForm(cmd, args);
  const child = spawn(c0, a0, { shell: win, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tag = `${c.bold}${color}[${label}]${c.reset} `;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(tag + line + '\n');
        if (onLine) onLine(line);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

function killChild(child) {
  if (!child || child.exitCode !== null) return;
  if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM'); // whole process group
    } catch {
      child.kill('SIGTERM');
    }
  }
}

// ---------- commands ----------
async function dev() {
  console.log(`${c.bold}UpNotice — development mode${c.reset}\n`);
  const hasDocker = dockerAvailable();
  log('Stopping anything old on ports 4000 / 4001...');
  stopOldStuff(hasDocker);

  const env = { ...process.env };
  const cloud = cloudDatabaseUrl();
  if (cloud) {
    env.DATABASE_URL = cloud;
    log(`Database: ${c.green}PostgreSQL in the cloud${c.reset} — ${describeCloud(cloud)} (from server/.env)`);
  } else if (hasDocker && ok(docker('compose', 'up', '-d', 'db'))) {
    env.DATABASE_URL = env.DATABASE_URL || DEV_DATABASE_URL;
    log(`Database: ${c.green}PostgreSQL${c.reset} in Docker (container upnotice-db, localhost:5433)`);
  } else {
    env.DB_DRIVER = 'sqlite'; // ignore any DATABASE_URL in server/.env
    warn(`Docker is not running — using the SQLite file server/data/upnotice.db instead.`);
    warn('Start Docker Desktop and run "npm run dev" again to use PostgreSQL.');
  }

  ensureInstalled(serverDir, 'server');
  ensureInstalled(appDir, 'app');
  ensureJwtSecret();
  fs.rmSync(path.join(appDir, 'node_modules', '.vite'), { recursive: true, force: true });

  log('Starting the API (port 4001) and the app (port 4000)...');
  const apiLines = [];
  const api = startChild('api', c.magenta, 'npm', ['run', 'dev'], { cwd: serverDir, env }, (line) => {
    apiLines.push(line);
    if (apiLines.length > 25) apiLines.shift();
    if (/Cannot find package/.test(line)) warn('A server package is missing — run "npm run setup" (or "npm install" inside server) and start again.');
    else if (/Could not open the database/.test(line)) warn('The API could not reach the database — see the [api] lines above.');
  });
  const app = startChild('app', c.green, 'npx', ['vite', '--force'], { cwd: appDir, env });

  const stop = () => {
    console.log();
    log('Stopping...');
    killChild(app);
    killChild(api);
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const [name, child] of [
    ['API', api],
    ['app', app],
  ]) {
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        warn(`${name} stopped (exit code ${code}). Fix the error above and run "npm run dev" again.`);
        stop();
      }
    });
  }

  const health = await waitForHealth(`${APP_URL}/api/health`, 60);
  if (health) {
    log(`Ready: ${c.bold}${APP_URL}${c.reset}  (server ${health.version}, database: ${health.database})`);
    log('Sign in with admin@company.com / admin123 (demo data).  Press Ctrl+C to stop.');
    openBrowser(APP_URL);
  } else {
    warn(`Still not answering at ${APP_URL} after 60 s. The last messages from the API were:`);
    for (const line of apiLines) if (!/^\s*>/.test(line)) console.log(`${c.dim}   ${line}${c.reset}`);
    warn('Fix the problem above, then press Ctrl+C and run "npm run dev" again (or send these lines to Claude).');
  }
}

async function dockerMode() {
  console.log(`${c.bold}UpNotice — Docker mode${c.reset}\n`);
  if (!dockerAvailable()) fail('Docker is not running. Start Docker Desktop, then run "npm start" again (or use "npm run dev" without Docker).');
  log('Stopping anything old on port 4000...');
  stopOldStuff(true);
  const cloud = cloudDatabaseUrl();
  // JWT_SECRET comes from server/.env (env_file in docker-compose.yml); SEED_DEMO=1 creates the demo accounts,
  // which must all choose a new password at their first sign-in because the image runs in production mode.
  const env = { ...process.env, JWT_SECRET: ensureJwtSecret(), SEED_DEMO: process.env.SEED_DEMO || '1' };
  let r;
  if (cloud) {
    log(`Database: PostgreSQL in the cloud — ${describeCloud(cloud)} (from server/.env); no database container needed.`);
    log('Building the image and starting UpNotice (first time takes a few minutes)...');
    r = run('docker', ['compose', 'up', '-d', '--build', '--no-deps', 'upnotice'], { stdio: 'inherit', env: { ...env, DATABASE_URL: cloud } });
  } else {
    log('Building the image and starting PostgreSQL + UpNotice (first time takes a few minutes)...');
    r = run('docker', ['compose', 'up', '-d', '--build'], { stdio: 'inherit', env });
  }
  if (!ok(r)) fail('docker compose failed — see the messages above.');
  const health = await waitForHealth(`${APP_URL}/api/health`, 90);
  if (!health) fail(`The container started but ${APP_URL} is not answering. Run "npm run logs" to see why.`);
  log(`Ready: ${c.bold}${APP_URL}${c.reset}  (server ${health.version}, database: ${health.database})`);
  log('Sign in with admin@company.com / admin123 — you will be asked to choose a new password the first time.');
  log(
    cloud
      ? 'Container: upnotice (app + API).  Logs: npm run logs   Stop: npm stop'
      : 'Containers: upnotice (app + API), upnotice-db (PostgreSQL).  Logs: npm run logs   Stop: npm stop'
  );
  openBrowser(APP_URL);
}

async function dbWeb() {
  if (!dockerAvailable()) fail('Docker is not running. Start Docker Desktop first.');
  log('Starting the database web page (container upnotice-db-web)...');
  // --force-recreate: a fresh container every time, which also clears Adminer's "too many logins" lock.
  const r = run('docker', ['compose', '--profile', 'tools', 'up', '-d', '--force-recreate', 'db-web'], { stdio: 'inherit' });
  if (!ok(r)) fail('Could not start it — see the messages above.');
  // Wait on the plain page: a URL with username= counts as a login attempt in Adminer.
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      if ((await fetch('http://localhost:4040/')).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  log(`Ready: ${c.bold}http://localhost:4040${c.reset}  — type the password ${c.bold}upnotice${c.reset} and click Login (the other fields are filled in).`);
  log('Stop it again with: npm stop');
  openBrowser('http://localhost:4040/?pgsql=db&username=upnotice&db=upnotice');
}

async function dbReset() {
  const hasDocker = dockerAvailable();
  const env = { ...process.env };
  const cloud = cloudDatabaseUrl();
  let which;
  if (cloud) {
    env.DATABASE_URL = cloud;
    which = `PostgreSQL in the cloud — ${describeCloud(cloud)}`;
  } else if (hasDocker && ok(docker('compose', 'up', '-d', 'db'))) {
    env.DATABASE_URL = env.DATABASE_URL || DEV_DATABASE_URL;
    which = 'PostgreSQL in Docker (container upnotice-db)';
  } else {
    env.DB_DRIVER = 'sqlite';
    which = 'the SQLite file server/data/upnotice.db';
  }
  console.log(`${c.bold}UpNotice — reset the database${c.reset}\n`);
  warn(`This deletes EVERYTHING in ${which}: all companies, people, announcements, meetings, alerts and uploaded files.`);
  warn('Afterwards only the demo accounts exist again (admin@company.com / admin123, Maria, Jose, Ana, Ben).');
  warn('Everyone signed in right now will be signed out.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question('Type RESET to continue, anything else to cancel: ', res));
  rl.close();
  if (answer.trim() !== 'RESET') return log('Cancelled — nothing was changed.');
  log('Stopping UpNotice first...');
  stopOldStuff(hasDocker);
  ensureInstalled(serverDir, 'server');
  const r = run('node', ['src/reset-db.js'], { cwd: serverDir, env, stdio: 'inherit' });
  if (!ok(r)) fail('The reset did not finish — see the messages above.');
  log('Done. Start again with "npm run dev" (or "npm start").');
}

function stopAll() {
  log('Stopping UpNotice...');
  if (dockerAvailable()) run('docker', ['compose', '--profile', 'tools', 'down'], { stdio: 'inherit' });
  const n = killPort(4000) + killPort(4001);
  if (n) log(`Stopped ${n} dev process(es).`);
  log('Done.');
}

function setup() {
  for (const [dir, label] of [
    [serverDir, 'server'],
    [appDir, 'app'],
  ]) {
    log(`Installing ${label} packages...`);
    const r = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
    if (!ok(r)) fail(`npm install failed in ${label}`);
  }
  const envFile = path.join(serverDir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(serverDir, '.env.example'), envFile);
    log('Created server/.env from .env.example.');
  }
  ensureJwtSecret();
  log('Setup complete. Next: "npm run dev" (development) or "npm start" (Docker).');
}

const cmd = process.argv[2];
const commands = { dev, docker: dockerMode, start: dockerMode, stop: stopAll, setup, dbweb: dbWeb, dbreset: dbReset };
if (!commands[cmd]) {
  console.log('Usage: npm run dev | npm start | npm stop | npm run setup | npm run db | npm run db:web | npm run db:reset | npm run logs');
  process.exit(1);
}
await commands[cmd]();
