// Wipes the database and starts over with the demo data.  Run through the launcher:  npm run db:reset
//   - PostgreSQL (local Docker or cloud/Supabase): drops every UpNotice table, then recreates them + demo accounts
//   - SQLite: moves the file to data/backup/ and creates a fresh one
// Uploaded attachments / photos are moved to data/backup/ as well, and any old SQLite file is moved out of the way
// so the server doesn't re-import it into the freshly emptied PostgreSQL database.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb, DIALECT } from './db.js';
import { ensureSeed } from './seed.js';
import { sqliteFilePath } from './migrate-to-postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(dataDir, 'backup', stamp);

function moveAway(from, label) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  const to = path.join(backupDir, path.basename(from));
  fs.renameSync(from, to);
  console.log(`Moved ${label} to ${path.relative(process.cwd(), to)}`);
}

if (DIALECT === 'postgres') {
  // Drop with a plain pg connection (db.js caches its schema state), then let initDb() rebuild everything.
  const { default: pg } = await import('pg');
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url);
  const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename);
  if (tables.length) {
    console.log(`Dropping ${tables.length} tables: ${tables.join(', ')}`);
    await client.query(`DROP TABLE IF EXISTS ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  } else {
    console.log('No tables found — nothing to drop.');
  }
  await client.end();
  // The old SQLite file would be re-imported into the now-empty PostgreSQL database on the next start.
  moveAway(sqliteFilePath(), 'the old SQLite file');
} else {
  for (const suffix of ['', '-wal', '-shm']) moveAway(sqliteFilePath() + suffix, `SQLite file${suffix}`);
}
moveAway(path.join(dataDir, 'uploads'), 'uploaded files');

await initDb();
await ensureSeed();
const n = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
console.log(`Database reset — ${n} demo accounts created (admin@company.com / admin123).`);
await db.close();
