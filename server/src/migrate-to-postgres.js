// Copies everything from the SQLite file (data/upnotice.db or DB_FILE) into the PostgreSQL database
// in DATABASE_URL. The server runs this automatically the first time it starts with DATABASE_URL set
// and finds an existing SQLite file; you can also run it by hand:   npm run migrate:pg
// It only migrates when the PostgreSQL database has no users yet, so it is safe to re-run.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Order matters because of foreign keys.
const TABLES = [
  'companies',
  'departments',
  'users',
  'announcements',
  'announcement_targets',
  'announcement_reads',
  'meetings',
  'meeting_targets',
  'meeting_rsvps',
  'notifications',
  'announcement_attachments',
  'poll_options',
  'poll_votes',
  'comments',
  'device_tokens',
  'meeting_attendance',
  'templates',
  'activity_log',
];
const WITH_ID = new Set([
  'companies',
  'departments',
  'users',
  'announcements',
  'meetings',
  'notifications',
  'announcement_attachments',
  'poll_options',
  'comments',
  'templates',
  'activity_log',
]);

export function sqliteFilePath() {
  const file = process.env.DB_FILE ? path.resolve(process.cwd(), process.env.DB_FILE) : path.resolve(__dirname, '../data/upnotice.db');
  // The app used to be called TeamAnnounce: fall back to the old file name if that is all there is.
  const legacy = path.join(path.dirname(file), 'teamannounce.db');
  return !fs.existsSync(file) && fs.existsSync(legacy) ? legacy : file;
}

/**
 * Imports the SQLite data into the (already initialised) PostgreSQL database.
 * Returns the number of rows copied, or null when there was nothing to do.
 */
export async function migrateFromSqlite({ log = console.log } = {}) {
  if (db.dialect !== 'postgres') return null;
  const file = sqliteFilePath();
  if (!fs.existsSync(file)) return null;
  const existing = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  if (existing > 0) return null;

  const { default: Database } = await import('better-sqlite3');
  const src = new Database(file, { readonly: true });
  let total = 0;
  try {
    log(`Importing existing SQLite data from ${file} into PostgreSQL...`);
    await db.tx(async () => {
      for (const table of TABLES) {
        const rows = src.prepare(`SELECT * FROM ${table}`).all();
        if (rows.length === 0) continue;
        // Only copy columns that exist in PostgreSQL (older SQLite files may have legacy columns).
        const pgCols = (await db.all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', [table])).map((r) => r.column_name);
        const cols = Object.keys(rows[0]).filter((c) => pgCols.includes(c));
        const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`;
        for (const row of rows)
          await db.run(
            sql,
            cols.map((c) => row[c] ?? null)
          );
        if (WITH_ID.has(table)) {
          await db.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
        }
        log(`  ${table}: ${rows.length} row(s)`);
        total += rows.length;
      }
    });
    log(`Done — ${total} rows copied. Uploaded files stay in server/data/uploads.`);
  } finally {
    src.close();
  }
  return total;
}

// Run directly: npm run migrate:pg
if (process.argv[1] && process.argv[1].endsWith('migrate-to-postgres.js')) {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL (PostgreSQL connection string) in server/.env first.');
    process.exit(1);
  }
  await initDb();
  const n = await migrateFromSqlite();
  if (n === null) console.log(fs.existsSync(sqliteFilePath()) ? 'PostgreSQL already has data — nothing migrated.' : `No SQLite file at ${sqliteFilePath()} — nothing to migrate.`);
  await db.close();
}
