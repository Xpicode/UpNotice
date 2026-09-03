#!/usr/bin/env node
// UpNotice launcher — one command from the pro folder, no .bat files needed:
//   npm run dev     development mode (live reload): PostgreSQL in Docker (or SQLite), API on 4001, app on 4000
//   npm start       Docker mode: builds and starts PostgreSQL + UpNotice, opens http://localhost:4000
//   npm stop        stops everything (containers and dev processes)
//   npm run setup   installs packages for server/ and app/
//   npm run logs    follows the Docker log
// Works on Windows, macOS and Linux. Only uses what ships with Node.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const appDir = path.join(root, 'app');
const win = process.platform === 'win32';
const APP_URL = 'http://localhost:4000';
const DEV_DATABASE_URL = 'postgres://upnotice:upnotice@localhost:5433/upnotice';

const c = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', red: '\x1b[31m', bold: '\x1b[1m' };
const log = (msg) => console.log(`${c.bold}${c.blue}[upnotice]${c.reset} ${msg}`);
const warn = (msg) => console.log(`${c.bold}${c.yellow}[upnotice]${c.reset} ${msg}`);
const fail = (msg) => {
  console.error(`${c.bold}${c.red}[upnotice]${c.reset} ${msg}`);
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
  if (hasDocker && ok(docker('compose', 'up', '-d', 'db'))) {
    env.DATABASE_URL = env.DATABASE_URL || DEV_DATABASE_URL;
    log(`Database: ${c.green}PostgreSQL${c.reset} in Docker (container upnotice-db, localhost:5433)`);
  } else {
    env.DB_DRIVER = 'sqlite'; // ignore any DATABASE_URL in server/.env
    warn(`Docker is not running — using the SQLite file server/data/upnotice.db instead.`);
    warn('Start Docker Desktop and run "npm run dev" again to use PostgreSQL.');
  }

  ensureInstalled(serverDir, 'server');
  ensureInstalled(appDir, 'app');
  fs.rmSync(path.join(appDir, 'node_modules', '.vite'), { recursive: true, force: true });

  log('Starting the API (port 4001) and the app (port 4000)...');
  const api = startChild('api', c.magenta, 'npm', ['run', 'dev'], { cwd: serverDir, env }, (line) => {
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
  for (const [name, child] of [['API', api], ['app', app]]) {
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
    log('Sign in with admin@company.com / admin123.  Press Ctrl+C to stop.');
    openBrowser(APP_URL);
  } else {
    warn(`Still not answering at ${APP_URL} after 60 s — check the [api] / [app] lines above.`);
  }
}

async function dockerMode() {
  console.log(`${c.bold}UpNotice — Docker mode${c.reset}\n`);
  if (!dockerAvailable()) fail('Docker is not running. Start Docker Desktop, then run "npm start" again (or use "npm run dev" without Docker).');
  log('Stopping anything old on port 4000...');
  stopOldStuff(true);
  log('Building the image and starting PostgreSQL + UpNotice (first time takes a few minutes)...');
  const r = run('docker', ['compose', 'up', '-d', '--build'], { stdio: 'inherit' });
  if (!ok(r)) fail('docker compose failed — see the messages above.');
  const health = await waitForHealth(`${APP_URL}/api/health`, 90);
  if (!health) fail(`The container started but ${APP_URL} is not answering. Run "npm run logs" to see why.`);
  log(`Ready: ${c.bold}${APP_URL}${c.reset}  (server ${health.version}, database: ${health.database})`);
  log('Sign in with admin@company.com / admin123');
  log('Containers: upnotice (app + API), upnotice-db (PostgreSQL).  Logs: npm run logs   Stop: npm stop');
  openBrowser(APP_URL);
}

function stopAll() {
  log('Stopping UpNotice...');
  if (dockerAvailable()) run('docker', ['compose', 'down'], { stdio: 'inherit' });
  const n = killPort(4000) + killPort(4001);
  if (n) log(`Stopped ${n} dev process(es).`);
  log('Done.');
}

function setup() {
  for (const [dir, label] of [[serverDir, 'server'], [appDir, 'app']]) {
    log(`Installing ${label} packages...`);
    const r = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
    if (!ok(r)) fail(`npm install failed in ${label}`);
  }
  const envFile = path.join(serverDir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(serverDir, '.env.example'), envFile);
    log('Created server/.env from .env.example — change JWT_SECRET before real use.');
  }
  log('Setup complete. Next: "npm run dev" (development) or "npm start" (Docker).');
}

const cmd = process.argv[2];
const commands = { dev, docker: dockerMode, start: dockerMode, stop: stopAll, setup };
if (!commands[cmd]) {
  console.log('Usage: npm run dev | npm start | npm stop | npm run setup | npm run logs');
  process.exit(1);
}
await commands[cmd]();
