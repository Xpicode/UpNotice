import { describe, it, expect } from 'vitest';
import { parse, ValidationError, loginBody, userCreate, announcementCreate, announcementsQuery, meetingCreate, ticketBody, rsvpBody, checkinBody } from '../../src/validate.js';

describe('parse', () => {
  it('throws a ValidationError with a readable message', () => {
    expect(() => parse(loginBody, {})).toThrow(ValidationError);
    expect(() => parse(loginBody, {})).toThrow(/Email and password are required/);
  });
  it('returns the cleaned data', () => {
    expect(parse(loginBody, { email: '  A@B.com ', password: 'x' })).toEqual({ email: 'A@B.com', password: 'x' });
  });
});

describe('userCreate', () => {
  it('lower-cases and validates the email, defaults the role', () => {
    const u = parse(userCreate, { name: ' Ana ', email: 'ANA@Company.com', password: 'Long-enough-1', company_id: '3' });
    expect(u).toMatchObject({ name: 'Ana', email: 'ana@company.com', role: 'employee', company_id: 3, department_id: null });
  });
  it('rejects a bad email, a short password and an unknown role', () => {
    expect(() => parse(userCreate, { name: 'x', email: 'nope', password: 'Long-enough-1' })).toThrow(/valid email/);
    expect(() => parse(userCreate, { name: 'x', email: 'a@b.co', password: 'short' })).toThrow(/at least 8/);
    expect(() => parse(userCreate, { name: 'x', email: 'a@b.co', password: 'Long-enough-1', role: 'god' })).toThrow(/Invalid role/);
  });
});

describe('announcementCreate (multipart strings)', () => {
  it('coerces flags, ids and JSON-encoded arrays the way a form sends them', () => {
    const a = parse(announcementCreate, {
      title: 'Hi',
      body: 'There',
      pinned: 'true',
      ack_required: '1',
      draft: 'false',
      company_id: '2',
      department_ids: '[1,"2",0]',
      poll_options: '["A","B",""]',
      publish_at: '',
      expires_at: '2030-01-01',
    });
    expect(a).toMatchObject({
      title: 'Hi',
      pinned: true,
      ack_required: true,
      draft: false,
      company_id: 2,
      department_ids: [1, 2],
      poll_options: ['A', 'B'],
      publish_at: null,
      priority: 'normal',
    });
    expect(a.expires_at).toBe('2030-01-01T00:00:00.000Z');
  });
  it('rejects garbage dates and unknown priorities', () => {
    expect(() => parse(announcementCreate, { title: 'x', body: 'y', publish_at: 'not a date' })).toThrow(/Invalid date/);
    expect(() => parse(announcementCreate, { title: 'x', body: 'y', priority: 'loud' })).toThrow(/Invalid priority/);
  });
  it('caps the title length', () => {
    expect(() => parse(announcementCreate, { title: 'x'.repeat(201), body: 'y' })).toThrow(/too long/);
  });
});

describe('list queries', () => {
  it('ignores unknown status/limit values instead of failing', () => {
    const q = parse(announcementsQuery, { status: 'bogus', limit: '9999', unread: '1', q: 'hello' });
    expect(q.status).toBeUndefined();
    expect(q.limit).toBeUndefined();
    expect(q.unread).toBe(true);
    expect(q.q).toBe('hello');
  });
});

describe('meetings and check-in', () => {
  it('normalises dates to ISO and validates recurrence', () => {
    const m = parse(meetingCreate, { title: 'Sync', starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T11:00:00Z', recurrence: 'weekly', occurrences: '4' });
    expect(m.recurrence).toBe('weekly');
    expect(m.occurrences).toBe(4);
    expect(() => parse(meetingCreate, { title: 'Sync', starts_at: 'x', ends_at: 'y' })).toThrow(/Invalid date/);
    expect(() => parse(meetingCreate, { title: 'Sync', starts_at: '2030-01-01', ends_at: '2030-01-02', recurrence: 'daily' })).toThrow(/repeat/);
  });
  it('upper-cases check-in codes and limits RSVP notes', () => {
    expect(parse(checkinBody, { code: ' ab12cd ' }).code).toBe('AB12CD');
    expect(() => parse(rsvpBody, { status: 'maybe', note: 'x'.repeat(301) })).toThrow(/too long/);
    expect(() => parse(rsvpBody, { status: 'perhaps' })).toThrow(/Invalid RSVP/);
  });
});

describe('ticketBody', () => {
  it('only accepts API paths', () => {
    expect(parse(ticketBody, { path: '/api/announcements/3/files/9?download=1' }).path).toBe('/api/announcements/3/files/9?download=1');
    expect(() => parse(ticketBody, { path: 'https://evil.example/x' })).toThrow(/Invalid path/);
    expect(() => parse(ticketBody, { path: '/etc/passwd' })).toThrow(/Invalid path/);
    expect(() => parse(ticketBody, { path: '/api/x/../../y' })).toThrow(/Invalid path/);
  });
});
