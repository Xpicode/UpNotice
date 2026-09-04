// Database layer. UpNotice runs on PostgreSQL (set DATABASE_URL) or on a local SQLite file (default).
//
// Every query goes through the same small async API so the routes don't care which one is used:
//   db.all(sql, params)  -> rows          db.get(sql, params) -> first row or undefined
//   db.run(sql, params)  -> { changes, id, rows }   (add "RETURNING id" to an INSERT to get the new id)
//   db.exec(sql)         -> runs raw SQL (schema)   db.tx(async () => { ... }) -> transaction
//
// Write SQL with "?" placeholders (or @name with an object of params). It is translated for PostgreSQL.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB_DRIVER=sqlite forces the SQLite file even when DATABASE_URL is set (used by the launcher when Docker is off).
export const DIALECT = process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'postgres' : 'sqlite';
const isPg = DIALECT === 'postgres';

/** Current time in the ISO format we store (UTC). */
export function nowIso() {
  return new Date().toISOString();
}

// ---------- placeholder handling ----------
function bind(sql, params) {
  // Named params: { me: 1, dept: 2 } with @me / @dept in the SQL.
  if (params && !Array.isArray(params) && typeof params === 'object') {
    const values = [];
    sql = sql.replace(/@([A-Za-z_]\w*)/g, (_, name) => {
      if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
      values.push(params[name]);
      return '?';
    });
    params = values;
  }
  params = (params || []).map((v) => (v === undefined ? null : v));
  if (isPg) {
    let n = 0;
    sql = sql.replace(/\?/g, () => `$${++n}`);
  }
  return { sql, params };
}

let impl = null;
const txStore = new AsyncLocalStorage();

// ---------- PostgreSQL ----------
async function openPostgres() {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8 (COUNT/SUM) as numbers
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric (AVG) as numbers
  // Cloud databases (Supabase, Neon, Railway…) need an encrypted connection; local Docker does not.
  // DATABASE_SSL=true/false overrides the guess.
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url);
  const ssl = process.env.DATABASE_SSL ? process.env.DATABASE_SSL !== 'false' : !local || /sslmode=require/.test(url);
  const pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), max: 10, ssl: ssl ? { rejectUnauthorized: false } : false });
  // Wait for the database to accept connections (Docker starts both containers together).
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      if (attempt === 1) console.log('Waiting for PostgreSQL...');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const conn = () => txStore.getStore() || pool;
  const query = async (sql, params) => {
    const b = bind(sql, params);
    return conn().query(b.sql, b.params);
  };
  return {
    name: `PostgreSQL (${ssl ? 'cloud, encrypted' : 'local'})`,
    all: async (sql, params) => (await query(sql, params)).rows,
    get: async (sql, params) => (await query(sql, params)).rows[0],
    run: async (sql, params) => {
      const r = await query(sql, params);
      return { changes: r.rowCount ?? 0, id: r.rows[0]?.id, rows: r.rows };
    },
    exec: async (sql) => {
      await conn().query(sql);
    },
    tx: async (fn) => {
      if (txStore.getStore()) return fn(); // already inside a transaction
      const client = await pool.connect();
      try {
        return await txStore.run(client, async () => {
          await client.query('BEGIN');
          try {
            const result = await fn();
            await client.query('COMMIT');
            return result;
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        });
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// ---------- SQLite ----------
async function openSqlite() {
  const { default: Database } = await import('better-sqlite3');
  const dbFile = process.env.DB_FILE ? path.resolve(process.cwd(), process.env.DB_FILE) : path.resolve(__dirname, '../data/upnotice.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  // The app used to be called TeamAnnounce: if only the old database file exists, adopt it under the new name.
  const legacy = path.join(path.dirname(dbFile), 'teamannounce.db');
  if (!fs.existsSync(dbFile) && fs.existsSync(legacy)) {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, dbFile + suffix);
    console.log('Renamed database teamannounce.db -> upnotice.db');
  }
  const sqlite = new Database(dbFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = sqlite.prepare(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
  return {
    name: `SQLite (${dbFile})`,
    file: dbFile,
    raw: sqlite,
    all: async (sql, params) => {
      const b = bind(sql, params);
      return stmt(b.sql).all(...b.params);
    },
    get: async (sql, params) => {
      const b = bind(sql, params);
      return stmt(b.sql).get(...b.params);
    },
    run: async (sql, params) => {
      const b = bind(sql, params);
      if (/\bRETURNING\b/i.test(sql)) {
        const rows = stmt(b.sql).all(...b.params);
        return { changes: rows.length, id: rows[0]?.id, rows };
      }
      const info = stmt(b.sql).run(...b.params);
      return { changes: info.changes, id: info.lastInsertRowid, rows: [] };
    },
    exec: async (sql) => {
      sqlite.exec(sql);
    },
    tx: async (fn) => {
      if (sqlite.inTransaction) return fn();
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    close: async () => sqlite.close(),
  };
}

function need() {
  if (!impl) throw new Error('Database not initialised — call initDb() first');
  return impl;
}

export const db = {
  get dialect() {
    return DIALECT;
  },
  get description() {
    return need().name;
  },
  all: (sql, params) => need().all(sql, params),
  get: (sql, params) => need().get(sql, params),
  run: (sql, params) => need().run(sql, params),
  exec: (sql) => need().exec(sql),
  tx: (fn) => need().tx(fn),
  close: () => (impl ? impl.close() : Promise.resolve()),
};

// ---------- schema ----------
const ID = isPg ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const NOW = isPg ? `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : `datetime('now')`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id ${ID},
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS departments (
  id ${ID},
  name TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id ${ID},
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE${isPg ? '' : ' COLLATE NOCASE'},
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')) DEFAULT 'employee',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  avatar_path TEXT,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS announcements (
  id ${ID},
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('normal', 'important', 'urgent')) DEFAULT 'normal',
  pinned INTEGER NOT NULL DEFAULT 0,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  publish_at TEXT,
  expires_at TEXT,
  ack_required INTEGER NOT NULL DEFAULT 0,
  poll_question TEXT,
  notified INTEGER NOT NULL DEFAULT 1,
  category TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS announcement_targets (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, department_id)
);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (${NOW}),
  acknowledged_at TEXT,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  id ${ID},
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled')) DEFAULT 'scheduled',
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  organizer_id INTEGER NOT NULL REFERENCES users(id),
  series_id TEXT,
  recurrence TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  minutes TEXT,
  minutes_updated_at TEXT,
  checkin_code TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS meeting_targets (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, department_id)
);

CREATE TABLE IF NOT EXISTS meeting_rsvps (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
  note TEXT NOT NULL DEFAULT '',
  responded_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id ${ID},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS announcement_attachments (
  id ${ID},
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_options (
  id ${ID},
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voted_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id ${ID},
  ref_type TEXT NOT NULL CHECK (ref_type IN ('announcement', 'meeting')),
  ref_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE INDEX IF NOT EXISTS idx_comments_ref ON comments(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE TABLE IF NOT EXISTS meeting_attendance (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked_in_at TEXT NOT NULL DEFAULT (${NOW}),
  method TEXT NOT NULL DEFAULT 'staff',
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS templates (
  id ${ID},
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  category TEXT,
  ack_required INTEGER NOT NULL DEFAULT 0,
  poll_question TEXT,
  poll_options TEXT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS activity_log (
  id ${ID},
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(starts_at);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
`;

/** Opens the database, creates tables on first run and upgrades older databases. Call once at startup. */
export async function initDb() {
  if (impl) return db;
  impl = isPg ? await openPostgres() : await openSqlite();
  await impl.exec(SCHEMA);
  if (isPg) await migratePostgres();
  else await migrateSqlite(impl.raw);
  await impl.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_company_name ON departments(company_id, name)');
  console.log(`Database: ${impl.name}`);
  return db;
}

async function migratePostgres() {
  // Case-insensitive unique e-mails (SQLite does this with COLLATE NOCASE).
  await impl.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))');
  // Columns added after the first PostgreSQL release (CREATE TABLE IF NOT EXISTS won't add them to existing tables).
  await impl.exec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_draft INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS minutes TEXT;
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS minutes_updated_at TEXT;
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS checkin_code TEXT;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'employee'));
  `);
}

// ---------- upgrades for SQLite databases created by older versions ----------
async function migrateSqlite(sqlite) {
  const hasColumn = (table, column) => sqlite.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  const addColumnIfMissing = (table, column, definition) => {
    if (!hasColumn(table, column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumnIfMissing('departments', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
  addColumnIfMissing('users', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE SET NULL');
  addColumnIfMissing('announcements', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
  addColumnIfMissing('meetings', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
  addColumnIfMissing('meeting_rsvps', 'note', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('announcements', 'publish_at', 'TEXT');
  addColumnIfMissing('announcements', 'expires_at', 'TEXT');
  addColumnIfMissing('announcements', 'ack_required', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('announcements', 'poll_question', 'TEXT');
  addColumnIfMissing('announcements', 'notified', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('announcement_reads', 'acknowledged_at', 'TEXT');
  addColumnIfMissing('meetings', 'series_id', 'TEXT');
  addColumnIfMissing('meetings', 'recurrence', 'TEXT');
  addColumnIfMissing('meetings', 'reminder_sent', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'avatar_path', 'TEXT');
  // v4: manager role, categories, drafts, minutes, attendance, email preference
  addColumnIfMissing('users', 'email_notifications', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('announcements', 'category', 'TEXT');
  addColumnIfMissing('announcements', 'is_draft', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('meetings', 'minutes', 'TEXT');
  addColumnIfMissing('meetings', 'minutes_updated_at', 'TEXT');
  addColumnIfMissing('meetings', 'checkin_code', 'TEXT');
  // The users table used to allow only admin/employee in its CHECK; SQLite can't change a CHECK, so rebuild the table.
  const usersSql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  if (!usersSql.includes("'manager'")) {
    sqlite.pragma('foreign_keys = OFF');
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')) DEFAULT 'employee',
          company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
          department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
          active INTEGER NOT NULL DEFAULT 1,
          avatar_path TEXT,
          email_notifications INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new (id, name, email, password_hash, role, company_id, department_id, active, avatar_path, email_notifications, created_at)
          SELECT id, name, email, password_hash, role, company_id, department_id, active, avatar_path, email_notifications, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    })();
    sqlite.pragma('foreign_keys = ON');
    console.log('Upgraded users table: added the manager role');
  }

  // Older databases had departments without a company: create a default company and attach everything to it.
  const hasUsers = sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  const hasCompanies = sqlite.prepare('SELECT COUNT(*) AS n FROM companies').get().n > 0;
  if (hasUsers && !hasCompanies) {
    const id = sqlite.prepare('INSERT INTO companies (name) VALUES (?)').run('Main Company').lastInsertRowid;
    sqlite.prepare('UPDATE departments SET company_id = ? WHERE company_id IS NULL').run(id);
    sqlite.prepare("UPDATE users SET company_id = ? WHERE company_id IS NULL AND role = 'employee'").run(id);
    console.log('Migrated existing data into a default company: "Main Company"');
  }
  // v1 databases declared departments.name UNIQUE on its own, which blocks two companies from both
  // having e.g. "HR". SQLite cannot drop an inline UNIQUE, so rebuild the table without it.
  const hasGlobalUnique = sqlite
    .prepare('PRAGMA index_list(departments)')
    .all()
    .filter((ix) => ix.unique)
    .some((ix) => {
      const cols = sqlite.prepare(`PRAGMA index_info(${ix.name})`).all().map((c) => c.name);
      return cols.length === 1 && cols[0] === 'name';
    });
  if (hasGlobalUnique) {
    sqlite.pragma('foreign_keys = OFF');
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE departments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
        );
        INSERT INTO departments_new (id, name, company_id) SELECT id, name, company_id FROM departments;
        DROP TABLE departments;
        ALTER TABLE departments_new RENAME TO departments;
      `);
    })();
    sqlite.pragma('foreign_keys = ON');
    console.log('Upgraded departments table: names are now unique per company');
  }
}

// ---------- shared query helpers ----------

/**
 * Ids of active employees who should receive content:
 *  - companyId null  → every company
 *  - departmentIds empty → every department (within that company scope)
 * Admins are the senders, so they are not counted in the audience for read receipts / RSVP totals.
 */
export async function audienceUserIds(companyId, departmentIds, excludeUserId = null) {
  const { sql, params } = audienceWhere(companyId, departmentIds);
  const rows = await db.all(`SELECT id FROM users WHERE ${sql}`, params);
  return rows.map((r) => r.id).filter((id) => id !== excludeUserId);
}

/** The same audience rule as a WHERE fragment (+ params) for joining against the users table directly. */
export function audienceWhere(companyId, departmentIds, alias = '') {
  const a = alias ? `${alias}.` : '';
  const where = [`${a}active = 1`, `${a}role IN ('employee', 'manager')`];
  const params = [];
  if (companyId) {
    where.push(`${a}company_id = ?`);
    params.push(companyId);
  }
  if (departmentIds && departmentIds.length > 0) {
    where.push(`${a}department_id IN (${departmentIds.map(() => '?').join(',')})`);
    params.push(...departmentIds);
  }
  return { sql: where.join(' AND '), params };
}

/** SQL fragment: can the employee (@company, @dept params) see a row with company_id + targets in the given tables? */
export function visibilitySql(alias, targetTable, targetKey) {
  const live =
    targetTable === 'announcement_targets'
      ? `AND ${alias}.is_draft = 0 AND (${alias}.publish_at IS NULL OR ${alias}.publish_at <= @nowTs) AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > @nowTs)`
      : '';
  return `(${alias}.company_id IS NULL OR ${alias}.company_id = @company) ${live}
    AND (NOT EXISTS (SELECT 1 FROM ${targetTable} t WHERE t.${targetKey} = ${alias}.id)
         OR EXISTS (SELECT 1 FROM ${targetTable} t WHERE t.${targetKey} = ${alias}.id AND t.department_id = @dept))`;
}

/** True when the error is a unique-constraint violation (duplicate name / email) in either database. */
export function isUniqueViolation(err) {
  return err?.code === '23505' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err?.message || '');
}

/** Ids of the people who manage a company: all admins plus the managers of that company (or every manager when companyId is null). */
export async function staffIds(companyId = null) {
  const rows = companyId
    ? await db.all("SELECT id FROM users WHERE active = 1 AND (role = 'admin' OR (role = 'manager' AND company_id = ?))", [companyId])
    : await db.all("SELECT id FROM users WHERE active = 1 AND role IN ('admin', 'manager')");
  return rows.map((r) => r.id);
}

/** Random short code for meeting check-in (no confusing 0/O/1/I). */
export function shortCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Inserts many rows with a handful of multi-row INSERT statements instead of one statement per row
 * (10,000 notifications = 20 round trips instead of 10,000 — matters a lot with a cloud database).
 * `columns` is an array of column names, `rows` an array of arrays in the same order.
 */
export async function insertMany(table, columns, rows, chunkSize = 500) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const tuple = `(${columns.map(() => '?').join(',')})`;
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(',')}`;
    await db.run(sql, chunk.flat());
  }
}
