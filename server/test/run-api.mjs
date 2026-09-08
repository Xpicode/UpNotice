// Runs the end-to-end API tests (api.test.js) against a private server:
// a fresh SQLite database with the demo accounts, no email, a random free port and a throwaway secret.
// Nothing else on this machine (a running dev server, your real database, server/.env) is touched.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upnotice-test-'));

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  NODE_ENV: '',
  LOG_LEVEL: 'warn',
  PORT: String(port),
  DATABASE_URL: '',
  DB_FILE: path.join(tmp, 'test.db'),
  UPLOAD_DIR: path.join(tmp, 'uploads'),
  JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
  APP_PUBLIC_URL: base,
  CORS_ORIGIN: '',
  RESEND_API_KEY: '',
  SMTP_HOST: '',
  FIREBASE_SERVICE_ACCOUNT: '',
  SEED_DEMO: '',
};

let serverLog = '';
const server = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const serverExit = new Promise((resolve) => server.on('exit', resolve));

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${serverLog}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start within 30 s:\n${serverLog}`);
}

let code = 1;
try {
  await waitForServer();
  console.log(`API tests against ${base} (temporary database in ${tmp})\n`);
  code = await new Promise((resolve) => {
    const t = spawn(process.execPath, ['test/api.test.js'], { cwd: serverDir, env: { ...process.env, API_URL: base }, stdio: 'inherit' });
    t.on('exit', (c) => resolve(c ?? 1));
  });
} catch (err) {
  console.error(err.message);
} finally {
  server.kill();
  await Promise.race([serverExit, new Promise((r) => setTimeout(r, 5000))]);
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300)); // Windows may still hold the database file for a moment
    }
  }
  if (code !== 0 && serverLog.trim()) console.error(`\n--- server log ---\n${serverLog}`);
}
process.exit(code);
