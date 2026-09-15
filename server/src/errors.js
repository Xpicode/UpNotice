// Error reporting. Optional — switched on by SENTRY_DSN in .env (https://sentry.io, free tier is plenty).
//
// Without it, a crash in production is a line in a log nobody is reading. With it, you get an email with
// the stack trace, how many people hit it, and which release introduced it. Only errors go: no request
// bodies, no addresses, no cookies (sendDefaultPii is off), and the log redaction rules still apply first.
import { log } from './log.js';

let sentry = null;
let status = 'disabled (set SENTRY_DSN in .env to enable)';

export async function initErrorReporting({ release } = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    log.info(`Error reporting: ${status}`);
    return;
  }
  try {
    const mod = await import('@sentry/node');
    mod.init({
      dsn,
      release,
      environment: process.env.NODE_ENV || 'development',
      sendDefaultPii: false,
      tracesSampleRate: 0, // errors only; performance tracing is a separate decision with its own quota
    });
    sentry = mod;
    status = 'enabled (Sentry)';
  } catch (err) {
    status = `error: ${err.message}`;
  }
  log.info(`Error reporting: ${status}`);
}

export function errorReportingStatus() {
  return status;
}

/** Sends one error with a little context. Safe to call when reporting is off — it then does nothing. */
export function reportError(err, context = {}) {
  if (!sentry) return;
  try {
    sentry.captureException(err, { extra: context });
  } catch (reportErr) {
    log.warn({ err: reportErr.message }, 'Could not report an error');
  }
}

/** Gives queued reports a moment to leave before the process exits. */
export async function flushErrorReports(timeoutMs = 2000) {
  if (!sentry) return;
  try {
    await sentry.flush(timeoutMs);
  } catch {
    /* shutting down anyway */
  }
}
