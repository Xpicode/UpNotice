import { describe, it, expect } from 'vitest';
import { lockedFor, recordFailure, clearFailures, MAX_FAILURES } from '../../src/limits.js';

describe('sign-in lockout', () => {
  it('locks an account after MAX_FAILURES wrong passwords and counts down before that', () => {
    const email = `lock-${Date.now()}@example.com`;
    expect(lockedFor(email)).toBe(0);
    let left = MAX_FAILURES;
    for (let i = 1; i < MAX_FAILURES; i++) {
      left = recordFailure(email);
      expect(left).toBe(MAX_FAILURES - i);
      expect(lockedFor(email)).toBe(0);
    }
    expect(recordFailure(email)).toBe(0);
    expect(lockedFor(email)).toBeGreaterThan(0);
    expect(lockedFor(email)).toBeLessThanOrEqual(15 * 60);
  });
  it('is case-insensitive on the email and clears after a successful sign-in', () => {
    const email = `case-${Date.now()}@example.com`;
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(email.toUpperCase());
    expect(lockedFor(email)).toBeGreaterThan(0);
    clearFailures(email);
    expect(lockedFor(email)).toBe(0);
  });
});
