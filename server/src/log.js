// Structured logging (pino). Every line is JSON in production (easy to ship to a log service) and
// pretty-printed in development. Requests get an id so one problem can be followed across lines.
import pino from 'pino';
import pinoHttp from 'pino-http';
import crypto from 'node:crypto';

export const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

export const log = pino({
  level,
  base: undefined, // no pid/hostname noise
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.refresh_token'], censor: '[hidden]' },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,req,res,responseTime', singleLine: true },
        },
      }),
});

/** Express middleware: one line per request with method, path, status, duration and a request id. */
export const httpLogger = pinoHttp({
  logger: log,
  genReqId: (req, res) => {
    const id = crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  autoLogging: {
    // Health checks and the live stream would flood the log.
    ignore: (req) => req.url === '/api/health' || req.url.startsWith('/api/notifications/stream') || !req.url.startsWith('/api/'),
  },
  customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  customSuccessMessage: (req, res) => `${req.method} ${req.url.split('?')[0]} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url.split('?')[0]} ${res.statusCode}`,
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0], ip: req.remoteAddress, user: req.raw?.user?.id }),
    res: (res) => ({ status: res.statusCode }),
  },
});
