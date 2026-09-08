// Audience rules as SQL, so reports and the dashboard can aggregate in one query instead of
// looping over every announcement / meeting in JavaScript (the old N+1 pattern).
//
// An announcement (or meeting) reaches a user when:
//   - the user is active and an employee or manager (admins send, they are not counted),
//   - the item is for every company (company_id NULL) or for the user's company,
//   - the item has no department targets, or one of them is the user's department,
//   - the user is not the item's author / organizer.
// The same rule lives in audienceUserIds() / visibilitySql() in db.js; keep them in step.
//
// Everything here is portable SQL: it runs on SQLite (better-sqlite3) and PostgreSQL. No casts,
// no FILTER, booleans are 0/1 integers, timestamps are ISO-8601 text compared lexically.
import { db, nowIso } from './db.js';

const KINDS = {
  announcement: { table: 'announcements', targets: 'announcement_targets', key: 'announcement_id', sender: 'author_id' },
  meeting: { table: 'meetings', targets: 'meeting_targets', key: 'meeting_id', sender: 'organizer_id' },
};

function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unknown audience kind: ${kind}`);
  return k;
}

/** The "user u is in the audience of item i" condition (no scope, no date rules). */
export function audienceMemberSql(kind, itemAlias = 'i', userAlias = 'u') {
  const k = kindOf(kind);
  const i = itemAlias;
  const u = userAlias;
  return `${u}.active = 1 AND ${u}.role IN ('employee', 'manager')
    AND (${i}.company_id IS NULL OR ${i}.company_id = ${u}.company_id)
    AND ${u}.id <> ${i}.${k.sender}
    AND (NOT EXISTS (SELECT 1 FROM ${k.targets} t WHERE t.${k.key} = ${i}.id)
         OR EXISTS (SELECT 1 FROM ${k.targets} t WHERE t.${k.key} = ${i}.id AND t.department_id = ${u}.department_id))`;
}

/**
 * WHERE fragment (+ params) selecting the items a report covers:
 *  - announcements that are not drafts / meetings that are scheduled,
 *  - within the manager's company scope (that company's items plus company-wide ones),
 *  - whose date (publish_at, else created_at / starts_at) lies in [from, to].
 * The scope and range clauses are only emitted when needed, so no parameter is ever compared against NULL
 * (PostgreSQL cannot infer the type of a bare "$1 IS NULL").
 */
export function reportItemsSql(kind, { scope = null, from = null, to = null } = {}, itemAlias = 'i') {
  const k = kindOf(kind);
  const i = itemAlias;
  const where = [kind === 'announcement' ? `${i}.is_draft = 0` : `${i}.status = 'scheduled'`];
  const params = {};
  if (scope !== null && scope !== undefined) {
    where.push(`(${i}.company_id = @scope OR ${i}.company_id IS NULL)`);
    params.scope = scope;
  }
  // SQLite's datetime('now') default writes "YYYY-MM-DD HH:MM:SS"; the range bounds are ISO with a "T".
  const date = kind === 'announcement' ? `REPLACE(COALESCE(${i}.publish_at, ${i}.created_at), ' ', 'T')` : `${i}.starts_at`;
  if (from) {
    where.push(`${date} >= @from`);
    params.from = from;
  }
  if (to) {
    where.push(`${date} <= @to`);
    params.to = to;
  }
  return { sql: where.join(' AND '), params, table: k.table };
}

/**
 * SELECT producing one row (item_id, user_id) per (item, audience member) pair, for use as a subquery / CTE.
 *   kind: 'announcement' | 'meeting'
 *   opts: { scope, from, to } — scope limits both the items (see reportItemsSql) and the users (u.company_id = scope).
 * Returns { sql, params } with @name parameters.
 */
export function audiencePairsSql(kind, opts = {}) {
  const items = reportItemsSql(kind, opts, 'i');
  const userScope = items.params.scope !== undefined ? ' AND u.company_id = @scope' : '';
  const sql = `SELECT i.id AS item_id, u.id AS user_id
    FROM ${items.table} i
    JOIN users u ON ${audienceMemberSql(kind, 'i', 'u')}${userScope}
    WHERE ${items.sql}`;
  return { sql, params: items.params };
}

/**
 * How many LIVE announcements (published, not expired, not drafts; only the scoped company's when scope is set)
 * still have at least one audience member who has not read them. One query; used by the dashboard.
 */
export async function announcementsAwaitingReadsCount(scope = null) {
  const scoped = scope !== null && scope !== undefined;
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM announcements a
     WHERE a.is_draft = 0
       AND (a.publish_at IS NULL OR a.publish_at <= @nowTs)
       AND (a.expires_at IS NULL OR a.expires_at > @nowTs)
       ${scoped ? 'AND a.company_id = @scope' : ''}
       AND EXISTS (
         SELECT 1 FROM users u
         WHERE ${audienceMemberSql('announcement', 'a', 'u')}
           AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = u.id)
       )`,
    scoped ? { nowTs: nowIso(), scope } : { nowTs: nowIso() }
  );
  return row.n;
}
