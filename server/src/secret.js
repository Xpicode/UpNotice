// The secret that signs access tokens. Production refuses to start without a real one; development
// generates one once and keeps it in data/.dev-jwt-secret so restarts don't sign everyone out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isProduction, log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLACEHOLDERS = new Set(['', 'change-this-to-a-long-random-string', 'dev-secret-change-me', 'secret', 'changeme']);

export function isWeakSecret(value) {
  const v = String(value || '').trim();
  return PLACEHOLDERS.has(v) || v.length < 32;
}

export function loadJwtSecret() {
  const fromEnv = String(process.env.JWT_SECRET || '').trim();
  if (!isWeakSecret(fromEnv)) return fromEnv;
  if (isProduction) {
    throw new Error(
      "JWT_SECRET is missing or too short. Set JWT_SECRET in server/.env (or the environment) to a random string of at least 32 characters, e.g. the output of:  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
  }
  const file = path.resolve(__dirname, '../data/.dev-jwt-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (!isWeakSecret(saved)) return saved;
  } catch {
    /* first run */
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch {
    /* read-only folder: tokens will only last until the next restart */
  }
  log.warn(
    'JWT_SECRET is not set (or is the placeholder). Using a generated development secret from server/data/.dev-jwt-secret. Set a real JWT_SECRET in server/.env before real use.'
  );
  return generated;
}
