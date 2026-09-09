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

// A throwaway SMTP server on this machine so the emailed-code tests can read what was actually sent.
// Nothing leaves the machine: the server talks to this socket, and each message is appended to mail.jsonl.
const mailFile = path.join(tmp, 'mail.jsonl');
const smtpPort = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const smtp = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  socket.write('220 localhost UpNotice test SMTP\r\n');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        fs.appendFileSync(mailFile, JSON.stringify({ to: /^To: (.*)$/m.exec(message)?.[1] ?? '', subject: /^Subject: (.*)$/m.exec(message)?.[1] ?? '' }) + '\n');
        socket.write('250 OK\r\n');
        continue;
      }
      const nl = buffer.indexOf('\r\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') socket.write('250-localhost\r\n250 8BITMIME\r\n');
      else if (verb === 'DATA') {
        inData = true;
        socket.write('354 Go ahead\r\n');
      } else if (verb === 'QUIT') {
        socket.write('221 Bye\r\n');
        socket.end();
        return;
      } else socket.write('250 OK\r\n');
    }
  });
});
smtp.listen(smtpPort, '127.0.0.1');
smtp.unref();

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
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtpPort),
  MAIL_FROM: 'UpNotice <test@localhost>',
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
    const t = spawn(process.execPath, ['test/api.test.js'], { cwd: serverDir, env: { ...process.env, API_URL: base, MAIL_FILE: mailFile }, stdio: 'inherit' });
    t.on('exit', (c) => resolve(c ?? 1));
  });
} catch (err) {
  console.error(err.message);
} finally {
  server.kill();
  smtp.close();
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
