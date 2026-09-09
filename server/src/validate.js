// Request validation with zod. Each route declares the shape it accepts; anything else is a 400 with a
// plain-English message. Multipart forms send every field as a string, so the schemas coerce where needed.
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './passwords.js';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/** Parses `data` with `schema`; throws a ValidationError (→ 400) with the first problem. */
export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw new ValidationError(`${where}${issue.message}`);
}

// ---------- reusable pieces ----------
const trimmed = (max, label = 'Text') =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .max(max, `${label} is too long (max ${max} characters)`);
export const idParam = z.coerce.number().int().positive();
export const optionalId = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().int().positive().nullable());
export const email = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Enter a valid email address' }));
export const password = z
  .string({ error: 'Password is required' })
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
/** "true"/"1"/true → true, everything else → false. */
export const flag = z.preprocess((v) => v === true || v === 1 || v === '1' || v === 'true', z.boolean());
/** Optional flag: undefined stays undefined (so PATCH can leave a field alone). */
export const optFlag = z.preprocess((v) => (v === undefined ? undefined : v === true || v === 1 || v === '1' || v === 'true'), z.boolean().optional());
/** ISO date or empty → null; garbage → error. */
export const dateOrNull = z
  .preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.string().nullable())
  .refine((v) => v === null || !Number.isNaN(Date.parse(v)), { message: 'Invalid date' })
  .transform((v) => (v === null ? null : new Date(v).toISOString()));
export const isoDate = z
  .string({ error: 'Date is required' })
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Invalid date' })
  .transform((v) => new Date(v).toISOString());
/** Arrays that may arrive JSON-encoded inside a multipart form. */
const maybeJsonArray = (inner) =>
  z.preprocess((v) => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return v.split('\n');
      }
    }
    return v;
  }, z.array(inner).optional());
// Ids that arrive as strings or with empty/zero entries (an unpicked <select>) are cleaned, not rejected.
export const idList = maybeJsonArray(z.coerce.number().int()).transform((a) => (a || []).filter((n) => n > 0));
export const role = z.enum(['admin', 'manager', 'employee'], { error: 'Invalid role' });
export const priority = z.enum(['normal', 'important', 'urgent'], { error: 'Invalid priority' });

// ---------- auth ----------
export const loginBody = z.object({
  email: z.string({ error: 'Email and password are required' }).trim().min(1, 'Email and password are required').max(254),
  password: z.string({ error: 'Email and password are required' }).min(1, 'Email and password are required').max(MAX_PASSWORD_LENGTH),
});
export const refreshBody = z.object({ refresh_token: z.string().min(20).max(500) });
export const forgotBody = z.object({ email: z.string({ error: 'Enter your email address' }).trim().min(1, 'Enter your email address').max(254) });
export const resetBody = z.object({ token: z.string({ error: 'Missing reset token' }).trim().min(1, 'Missing reset token').max(200), password });
export const changePasswordBody = z.object({ currentPassword: z.string().max(MAX_PASSWORD_LENGTH).default(''), newPassword: password });
export const meBody = z.object({ email_notifications: optFlag });
export const ticketBody = z.object({
  path: z
    .string()
    .max(500)
    .regex(/^\/api\/[A-Za-z0-9\-._~/]+(\?[A-Za-z0-9\-._~&=%]*)?$/, 'Invalid path')
    .refine((p) => !p.includes('..') && !p.includes('//'), 'Invalid path'),
});

// ---------- people ----------
export const companyBody = z.object({ name: trimmed(80, 'Company name').min(1, 'Company name is required') });
export const departmentBody = z.object({ name: trimmed(80, 'Department name').min(1, 'Department name is required'), company_id: optionalId });
export const departmentRename = z.object({ name: trimmed(80, 'Department name').min(1, 'Department name is required') });
export const userCreate = z.object({
  name: trimmed(120, 'Name').min(1, 'Name, email and password are required'),
  email,
  password,
  role: role.default('employee'),
  company_id: optionalId.default(null),
  department_id: optionalId.default(null),
});
export const userPatch = z.object({
  name: trimmed(120, 'Name').min(1, 'Name cannot be empty').optional(),
  email: email.optional(),
  password: password.optional(),
  role: role.optional(),
  company_id: optionalId.optional(),
  department_id: optionalId.optional(),
  active: optFlag,
});
export const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  company_id: optionalId.optional(),
  role: role.optional().catch(undefined),
  limit: z.coerce.number().int().min(0).max(500).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).optional().catch(undefined),
});

// ---------- announcements ----------
const listCommon = {
  q: z.string().trim().max(100).optional(),
  company_id: optionalId.optional().catch(undefined),
  department_id: optionalId.optional().catch(undefined),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).optional().catch(undefined),
};
export const announcementsQuery = z.object({
  ...listCommon,
  category: z.string().trim().max(40).optional(),
  status: z.enum(['live', 'scheduled', 'expired', 'draft']).optional().catch(undefined),
  unread: optFlag,
});
export const meetingsQuery = z.object({ ...listCommon, scope: z.enum(['upcoming', 'past', 'all']).default('upcoming').catch('upcoming') });
export const announcementCreate = z.object({
  title: trimmed(200, 'Title').min(1, 'Title and message are required'),
  body: trimmed(20000, 'Message').default(''),
  priority: priority.default('normal'),
  pinned: flag.default(false),
  category: trimmed(40, 'Category').default(''),
  draft: flag.default(false),
  company_id: optionalId.default(null),
  department_ids: idList.default([]),
  publish_at: dateOrNull.default(null),
  expires_at: dateOrNull.default(null),
  ack_required: flag.default(false),
  poll_question: trimmed(200, 'Poll question').default(''),
  poll_options: maybeJsonArray(z.string().trim().max(120))
    .transform((a) =>
      (a || [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 10)
    )
    .default([]),
});
export const announcementPatch = z.object({
  title: trimmed(200, 'Title').min(1, 'Title cannot be empty').optional(),
  body: trimmed(20000, 'Message').optional(),
  priority: priority.optional(),
  pinned: optFlag,
  category: trimmed(40, 'Category').optional(),
  draft: optFlag,
  company_id: optionalId.optional(),
  department_ids: idList.optional(),
  publish_at: dateOrNull.optional(),
  expires_at: dateOrNull.optional(),
  ack_required: optFlag,
  poll_question: trimmed(200, 'Poll question').optional(),
  poll_options: maybeJsonArray(z.string().trim().max(120))
    .transform((a) =>
      a === undefined
        ? undefined
        : a
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, 10)
    )
    .optional(),
  remove_attachment_ids: idList.optional(),
});
export const voteBody = z.object({ option_id: z.coerce.number({ error: 'Choose one of the options' }).int().positive('Choose one of the options') });

// ---------- meetings ----------
export const meetingCreate = z.object({
  title: trimmed(200, 'Title').min(1, 'Title is required'),
  description: trimmed(20000, 'Description').default(''),
  starts_at: isoDate,
  ends_at: isoDate,
  location: trimmed(200, 'Location').default(''),
  link: trimmed(500, 'Link').default(''),
  company_id: optionalId.default(null),
  department_ids: idList.default([]),
  recurrence: z.enum(['weekly', 'biweekly', 'monthly'], { error: 'Invalid repeat option' }).nullable().optional().default(null),
  occurrences: z.coerce.number().int().min(2).max(52).optional().catch(undefined),
});
export const meetingPatch = z.object({
  title: trimmed(200, 'Title').min(1, 'Title cannot be empty').optional(),
  description: trimmed(20000, 'Description').optional(),
  starts_at: isoDate.optional(),
  ends_at: isoDate.optional(),
  location: trimmed(200, 'Location').optional(),
  link: trimmed(500, 'Link').optional(),
  status: z.enum(['scheduled', 'cancelled'], { error: 'Invalid status' }).optional(),
  company_id: optionalId.optional(),
  department_ids: idList.optional(),
});
export const rsvpBody = z.object({ status: z.enum(['going', 'maybe', 'declined'], { error: 'Invalid RSVP' }), note: trimmed(300, 'Reason').default('') });
export const attendanceBody = z.object({ user_id: z.coerce.number().int().positive(), present: flag.default(true) });
export const checkinBody = z.object({
  code: z
    .string({ error: 'Enter the check-in code' })
    .trim()
    .min(1, 'Enter the check-in code')
    .max(12)
    .transform((s) => s.toUpperCase()),
});
export const minutesBody = z.object({ minutes: trimmed(20000, 'Minutes').default(''), notify: optFlag });

// ---------- misc ----------
export const commentBody = z.object({ body: trimmed(2000, 'Comment').min(1, 'Write something first') });
export const commentRef = z.object({ refType: z.enum(['announcement', 'meeting']), refId: idParam });
export const templateBody = z.object({
  name: trimmed(80, 'Template name').min(1, 'Give the template a name'),
  title: trimmed(200, 'Title').default(''),
  body: trimmed(20000, 'Message').default(''),
  priority: priority.default('normal').catch('normal'),
  category: z.preprocess((v) => v ?? '', trimmed(40, 'Category')).default(''),
  ack_required: flag.default(false),
  poll_question: z.preprocess((v) => v ?? '', trimmed(200, 'Poll question')).default(''),
  poll_options: z
    .array(z.string().trim().max(120))
    .default([])
    .transform((a) => a.filter(Boolean).slice(0, 10)),
  company_id: optionalId.default(null),
});
export const deviceBody = z.object({
  token: z.string({ error: 'token required' }).trim().min(1, 'token required').max(4096),
  platform: z.string().trim().max(20).default('unknown'),
});
export const deviceUnregister = z.object({ token: z.string().trim().max(4096).default('') });
export const notificationsDelete = z.object({ ids: z.array(z.coerce.number().int().positive()).max(1000).optional(), all: optFlag, read: optFlag });
export const activityDelete = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1, 'Nothing selected').max(1000) });
export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100).catch(100),
  before: z.coerce.number().int().positive().optional().catch(undefined),
  action: z.string().trim().max(60).optional(),
  user_id: z.coerce.number().int().positive().optional().catch(undefined),
  q: z.string().trim().max(100).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
export const importBody = z.object({ create_missing: z.preprocess((v) => v !== 'false' && v !== false, z.boolean()).default(true) });
