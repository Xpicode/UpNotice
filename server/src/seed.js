// Creates the first accounts when the database is empty.
//
//   development (npm run dev)          demo companies + admin@company.com / admin123 and four employees
//   Docker / production with SEED_DEMO=1  the same demo data, but everyone must choose a new password at first sign-in
//   production without SEED_DEMO       one admin account with a random password printed ONCE in the log
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, initDb } from './db.js';
import { log, isProduction } from './log.js';
import { generatePassword } from './passwords.js';

export async function ensureSeed() {
  const count = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  if (count > 0) return false;
  const demo = !isProduction || process.env.SEED_DEMO === '1' || process.env.SEED_DEMO === 'true';
  if (demo) await seedDemo({ forceChange: isProduction });
  else await seedProduction();
  return true;
}

async function seedProduction() {
  const email = String(process.env.ADMIN_EMAIL || 'admin@company.com')
    .trim()
    .toLowerCase();
  const password = process.env.ADMIN_PASSWORD || generatePassword(14);
  await db.run('INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)', ['Admin', email, bcrypt.hashSync(password, 10), 'admin']);
  log.warn('==========================================================================');
  log.warn(`First start: created the admin account ${email}`);
  log.warn(process.env.ADMIN_PASSWORD ? 'Password: the ADMIN_PASSWORD you configured' : `Temporary password: ${password}`);
  log.warn('You will be asked to choose a new password at the first sign-in. This message is not shown again.');
  log.warn('==========================================================================');
}

async function seedDemo({ forceChange }) {
  const flag = forceChange ? 1 : 0;
  await db.tx(async () => {
    const insert = async (sql, params) => (await db.run(sql + ' RETURNING id', params)).id;

    const upright = await insert('INSERT INTO companies (name) VALUES (?)', ['Upright Solutions']);
    const sixth = await insert('INSERT INTO companies (name) VALUES (?)', ['SixthGear']);

    const deptSql = 'INSERT INTO departments (name, company_id) VALUES (?, ?)';
    const ops = await insert(deptSql, ['Operations', upright]);
    const sales = await insert(deptSql, ['Sales', upright]);
    await insert(deptSql, ['HR', upright]);
    const shop = await insert(deptSql, ['Shop', sixth]);

    const userSql = 'INSERT INTO users (name, email, password_hash, role, company_id, department_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const hash = (p) => bcrypt.hashSync(p, 10);
    // The admin (boss) is not tied to one company — they manage all of them.
    const admin = await insert(userSql, ['Admin', 'admin@company.com', hash('admin123'), 'admin', null, null, flag]);
    const maria = await insert(userSql, ['Maria Santos', 'maria@company.com', hash('password'), 'employee', upright, ops, flag]);
    const jose = await insert(userSql, ['Jose Reyes', 'jose@company.com', hash('password'), 'employee', upright, ops, flag]);
    const ana = await insert(userSql, ['Ana Cruz', 'ana@company.com', hash('password'), 'employee', upright, sales, flag]);
    const ben = await insert(userSql, ['Ben Lim', 'ben@company.com', hash('password'), 'employee', sixth, shop, flag]);

    const annSql = 'INSERT INTO announcements (title, body, priority, pinned, company_id, author_id) VALUES (?, ?, ?, ?, ?, ?)';
    const a1 = await insert(annSql, [
      'Welcome to UpNotice',
      'This is where you will see company announcements and meeting invites. Tap an announcement to mark it as read so management knows you saw it.',
      'important',
      1,
      null,
      admin,
    ]);
    await insert(annSql, ['Office closed on Monday', 'The Upright office will be closed on Monday for the holiday. Regular hours resume Tuesday.', 'normal', 0, upright, admin]);
    const a3 = await insert(annSql, [
      'Operations: new shift schedule',
      'The new shift schedule for next month has been posted at the front desk. Please check your assigned shifts.',
      'urgent',
      0,
      upright,
      admin,
    ]);
    await db.run('INSERT INTO announcement_targets (announcement_id, department_id) VALUES (?, ?)', [a3, ops]);
    await insert(annSql, ['Shop inventory count this Saturday', 'All shop staff please be in by 8 AM for the quarterly inventory count.', 'important', 0, sixth, admin]);
    await db.run('INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)', [a1, maria]);

    const start = new Date();
    start.setDate(start.getDate() + 2);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const m1 = await insert('INSERT INTO meetings (title, description, starts_at, ends_at, location, link, company_id, organizer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      'Monthly all-hands meeting',
      'Company updates, Q3 results and plans for next quarter. Attendance is required.',
      start.toISOString(),
      end.toISOString(),
      'Main conference room',
      '',
      upright,
      admin,
    ]);
    await db.run('INSERT INTO meeting_rsvps (meeting_id, user_id, status) VALUES (?, ?, ?)', [m1, maria, 'going']);

    const notifSql = 'INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?)';
    for (const uid of [maria, jose, ana, ben]) {
      await db.run(notifSql, [uid, 'announcement', 'Important announcement: Welcome to UpNotice', 'This is where you will see company announcements...', 'announcement', a1]);
    }
    for (const uid of [maria, jose, ana]) {
      await db.run(notifSql, [uid, 'meeting', 'Meeting invite: Monthly all-hands meeting', 'Main conference room', 'meeting', m1]);
    }
  });
  log.info(
    `Seeded demo data. Sign in with admin@company.com / admin123 (employee: maria@company.com / password)${forceChange ? ' — everyone must choose a new password at the first sign-in' : ''}`
  );
}

// Allow `npm run seed` to run it directly.
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  await initDb();
  const did = await ensureSeed();
  if (!did) log.info('Database already has users — nothing to seed.');
  await db.close();
}
