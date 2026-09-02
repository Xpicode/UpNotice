// Database setup: opens the SQLite file, creates tables on first run.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE
  ? path.resolve(process.cwd(), process.env.DB_FILE)
  : path.resolve(__dirname, '../data/teamannounce.db');

fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')) DEFAULT 'employee',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('normal', 'important', 'urgent')) DEFAULT 'normal',
  pinned INTEGER NOT NULL DEFAULT 0,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which departments an announcement targets. No rows = everyone.
CREATE TABLE IF NOT EXISTS announcement_targets (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, department_id)
);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled')) DEFAULT 'scheduled',
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  organizer_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  responded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('announcement', 'meeting')),
  ref_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_ref ON comments(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(starts_at);
`);

// ---------- Migrations for databases created by older versions ----------
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function addColumnIfMissing(table, column, definition) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('departments', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
addColumnIfMissing('users', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE SET NULL');
addColumnIfMissing('announcements', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
addColumnIfMissing('meetings', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
addColumnIfMissing('meeting_rsvps', 'note', "TEXT NOT NULL DEFAULT ''");
// v3: scheduling / expiry / acknowledgements / polls / recurring meetings / avatars
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

// Older databases had departments without a company: create a default company and attach everything to it.
{
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  const hasCompanies = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n > 0;
  if (hasUsers && !hasCompanies) {
    const id = db.prepare('INSERT INTO companies (name) VALUES (?)').run('Main Company').lastInsertRowid;
    db.prepare('UPDATE departments SET company_id = ? WHERE company_id IS NULL').run(id);
    db.prepare("UPDATE users SET company_id = ? WHERE company_id IS NULL AND role = 'employee'").run(id);
    console.log('Migrated existing data into a default company: "Main Company"');
  }
}
// v1 databases declared departments.name UNIQUE on its own, which blocks two companies from both
// having e.g. "HR". SQLite cannot drop an inline UNIQUE, so rebuild the table without it.
{
  const hasGlobalUnique = db
    .prepare('PRAGMA index_list(departments)')
    .all()
    .filter((ix) => ix.unique)
    .some((ix) => {
      const cols = db.prepare(`PRAGMA index_info(${ix.name})`).all().map((c) => c.name);
      return cols.length === 1 && cols[0] === 'name';
    });
  if (hasGlobalUnique) {
    // Foreign keys must be OFF while the table is swapped, otherwise DROP TABLE cascades into users/targets.
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
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
    db.pragma('foreign_keys = ON');
    console.log('Upgraded departments table: names are now unique per company');
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_company_name ON departments(company_id, name)');

/**
 * Ids of active employees who should receive content:
 *  - companyId null  → every company
 *  - departmentIds empty → every department (within that company scope)
 * Admins are the senders, so they are not counted in the audience for read receipts / RSVP totals.
 */
export function audienceUserIds(companyId, departmentIds, excludeUserId = null) {
  const where = ["active = 1", "role = 'employee'"];
  const params = [];
  if (companyId) {
    where.push('company_id = ?');
    params.push(companyId);
  }
  if (departmentIds && departmentIds.length > 0) {
    where.push(`department_id IN (${departmentIds.map(() => '?').join(',')})`);
    params.push(...departmentIds);
  }
  const rows = db.prepare(`SELECT id FROM users WHERE ${where.join(' AND ')}`).all(...params);
  return rows.map((r) => r.id).filter((id) => id !== excludeUserId);
}

/** SQL fragment: can the employee (@company, @dept params) see a row with company_id + targets in the given tables? */
export function visibilitySql(alias, targetTable, targetKey) {
  const live = targetTable === 'announcement_targets'
    ? `AND (${alias}.publish_at IS NULL OR ${alias}.publish_at <= @nowTs) AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > @nowTs)`
    : '';
  return `(${alias}.company_id IS NULL OR ${alias}.company_id = @company) ${live}
    AND (NOT EXISTS (SELECT 1 FROM ${targetTable} t WHERE t.${targetKey} = ${alias}.id)
         OR EXISTS (SELECT 1 FROM ${targetTable} t WHERE t.${targetKey} = ${alias}.id AND t.department_id = @dept))`;
}

/** Current time in the same ISO format we store (UTC). */
export function nowIso() {
  return new Date().toISOString();
}
