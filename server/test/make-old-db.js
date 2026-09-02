// Creates a database in the ORIGINAL v1 layout (no companies) so the upgrade path can be tested.
//   node test/make-old-db.js data/teamannounce.db
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || 'data/teamannounce.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.rmSync(file, { force: true });
const db = new Database(file);
db.exec(`
CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee',
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal', pinned INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE announcement_targets (announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE, PRIMARY KEY (announcement_id, department_id));
CREATE TABLE announcement_reads (announcement_id INTEGER NOT NULL, user_id INTEGER NOT NULL, read_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (announcement_id, user_id));
CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled', organizer_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE meeting_targets (meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE, PRIMARY KEY (meeting_id, department_id));
CREATE TABLE meeting_rsvps (meeting_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL, responded_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (meeting_id, user_id));
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', ref_type TEXT, ref_id INTEGER, read_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
const d = db.prepare('INSERT INTO departments (name) VALUES (?)');
const hr = d.run('HR').lastInsertRowid, ops = d.run('Operations').lastInsertRowid, sales = d.run('Sales').lastInsertRowid;
const u = db.prepare('INSERT INTO users (name, email, password_hash, role, department_id) VALUES (?, ?, ?, ?, ?)');
const admin = u.run('Admin', 'admin@company.com', bcrypt.hashSync('admin123', 10), 'admin', hr).lastInsertRowid;
const maria = u.run('Maria Santos', 'maria@company.com', bcrypt.hashSync('password', 10), 'employee', ops).lastInsertRowid;
u.run('Jose Reyes', 'jose@company.com', bcrypt.hashSync('password', 10), 'employee', ops);
u.run('Ana Cruz', 'ana@company.com', bcrypt.hashSync('password', 10), 'employee', sales);
const a = db.prepare('INSERT INTO announcements (title, body, author_id) VALUES (?, ?, ?)').run('Old announcement', 'From v1', admin).lastInsertRowid;
db.prepare('INSERT INTO announcement_targets VALUES (?, ?)').run(a, ops);
db.prepare('INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)').run(a, maria);
db.close();
console.log('Old-layout database written to', file);
