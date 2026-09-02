// Creates a first admin account (and demo data) when the database is empty.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

export function ensureSeed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;

  const seed = db.transaction(() => {
    const company = db.prepare('INSERT INTO companies (name) VALUES (?)');
    const upright = company.run('Upright Solutions').lastInsertRowid;
    const sixth = company.run('SixthGear').lastInsertRowid;

    const dept = db.prepare('INSERT INTO departments (name, company_id) VALUES (?, ?)');
    const ops = dept.run('Operations', upright).lastInsertRowid;
    const sales = dept.run('Sales', upright).lastInsertRowid;
    dept.run('HR', upright);
    const shop = dept.run('Shop', sixth).lastInsertRowid;

    const user = db.prepare(
      'INSERT INTO users (name, email, password_hash, role, company_id, department_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const hash = (p) => bcrypt.hashSync(p, 10);
    // The admin (boss) is not tied to one company — they manage all of them.
    const admin = user.run('Admin', 'admin@company.com', hash('admin123'), 'admin', null, null).lastInsertRowid;
    const maria = user.run('Maria Santos', 'maria@company.com', hash('password'), 'employee', upright, ops).lastInsertRowid;
    const jose = user.run('Jose Reyes', 'jose@company.com', hash('password'), 'employee', upright, ops).lastInsertRowid;
    const ana = user.run('Ana Cruz', 'ana@company.com', hash('password'), 'employee', upright, sales).lastInsertRowid;
    const ben = user.run('Ben Lim', 'ben@company.com', hash('password'), 'employee', sixth, shop).lastInsertRowid;

    const ann = db.prepare(
      'INSERT INTO announcements (title, body, priority, pinned, company_id, author_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const a1 = ann.run(
      'Welcome to TeamAnnounce',
      'This is where you will see company announcements and meeting invites. Tap an announcement to mark it as read so management knows you saw it.',
      'important', 1, null, admin
    ).lastInsertRowid;
    ann.run(
      'Office closed on Monday',
      'The Upright office will be closed on Monday for the holiday. Regular hours resume Tuesday.',
      'normal', 0, upright, admin
    );
    const a3 = ann.run(
      'Operations: new shift schedule',
      'The new shift schedule for next month has been posted at the front desk. Please check your assigned shifts.',
      'urgent', 0, upright, admin
    ).lastInsertRowid;
    db.prepare('INSERT INTO announcement_targets (announcement_id, department_id) VALUES (?, ?)').run(a3, ops);
    ann.run('Shop inventory count this Saturday', 'All shop staff please be in by 8 AM for the quarterly inventory count.', 'important', 0, sixth, admin);
    db.prepare('INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)').run(a1, maria);

    const start = new Date();
    start.setDate(start.getDate() + 2);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const m1 = db
      .prepare(
        'INSERT INTO meetings (title, description, starts_at, ends_at, location, link, company_id, organizer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'Monthly all-hands meeting',
        'Company updates, Q3 results and plans for next quarter. Attendance is required.',
        start.toISOString(), end.toISOString(), 'Main conference room', '', upright, admin
      ).lastInsertRowid;
    db.prepare('INSERT INTO meeting_rsvps (meeting_id, user_id, status) VALUES (?, ?, ?)').run(m1, maria, 'going');

    const notif = db.prepare(
      'INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const uid of [maria, jose, ana, ben]) {
      notif.run(uid, 'announcement', 'Important announcement: Welcome to TeamAnnounce', 'This is where you will see company announcements...', 'announcement', a1);
    }
    for (const uid of [maria, jose, ana]) {
      notif.run(uid, 'meeting', 'Meeting invite: Monthly all-hands meeting', 'Main conference room', 'meeting', m1);
    }
  });
  seed();
  console.log('Seeded demo data. Sign in with admin@company.com / admin123 (employee: maria@company.com / password)');
  return true;
}

// Allow `npm run seed` to run it directly.
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const did = ensureSeed();
  if (!did) console.log('Database already has users — nothing to seed.');
}
