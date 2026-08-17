import { describe, expect, it } from 'vitest';
import { decideAccess, parseAllowlist } from './access';

/**
 * This policy is the only thing gating who can drive the agent, because the
 * Connect front door bypasses OpenClaw's own DM allowlists and mention gates.
 * The fail-closed cases matter more than the happy path.
 */
describe('decideAccess', () => {
  it('denies everyone when the allowlist is unset', () => {
    expect(decideAccess('U123', undefined)).toEqual({
      allowed: false,
      reason: 'not_configured',
    });
  });

  it('denies everyone when the allowlist is empty or whitespace', () => {
    expect(decideAccess('U123', '').reason).toBe('not_configured');
    expect(decideAccess('U123', '   ').reason).toBe('not_configured');
    expect(decideAccess('U123', ' , , ').reason).toBe('not_configured');
  });

  it('allows a listed user', () => {
    expect(decideAccess('U123', 'U123,U456')).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('denies an unlisted user', () => {
    expect(decideAccess('U999', 'U123,U456')).toEqual({
      allowed: false,
      reason: 'user_not_allowed',
    });
  });

  it('denies an event with no user id', () => {
    expect(decideAccess(undefined, 'U123')).toEqual({ allowed: false, reason: 'no_user' });
  });

  it('compares ids exactly, since Slack ids are case-sensitive', () => {
    expect(decideAccess('u123', 'U123').allowed).toBe(false);
  });

  it('does not treat a partial id as a match', () => {
    expect(decideAccess('U12', 'U123').allowed).toBe(false);
    expect(decideAccess('U1234', 'U123').allowed).toBe(false);
  });
});

describe('parseAllowlist', () => {
  it('accepts commas, spaces and newlines', () => {
    expect(parseAllowlist('U1, U2\nU3\tU4')).toEqual(['U1', 'U2', 'U3', 'U4']);
  });

  it('returns an empty list for nothing usable', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist(',,  ,')).toEqual([]);
  });
});
