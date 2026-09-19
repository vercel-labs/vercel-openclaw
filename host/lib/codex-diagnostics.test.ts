import { describe, expect, it } from 'vitest';
import { retryableReadinessError, safeCodexError } from './codex-diagnostics';

describe('credential-safe lifecycle diagnostics', () => {
  it('retains known diagnostic messages verbatim and hashes arbitrary messages', () => {
    expect(safeCodexError(new Error('Readiness command failed'))).toMatchObject({ message: 'Readiness command failed' });
    expect(safeCodexError(new Error('Readiness command failed: private-key'))).not.toHaveProperty('message');
  });
  it('retains timeout, transport cause and HTTP status without copying arbitrary values', () => {
    const error = Object.assign(new TypeError('Bearer private-key request-body'), {
      cause: Object.assign(new Error('private-dns-host'), { code: 'ECONNRESET' }),
      response: { status: 503, headers: { authorization: 'private-key' } },
      json: { error: { code: 'private-code', message: 'private-body' } },
    });
    const safe = safeCodexError(error);
    expect(safe).toMatchObject({ name: 'TypeError', status: 503, cause: { code: 'ECONNRESET' } });
    expect(JSON.stringify(safe)).not.toContain('private');
    expect(safe.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(retryableReadinessError(error)).toBe(true);
  });
  it('bounds cyclic causes and excludes credential-shaped names and codes', () => {
    const error: Record<string, unknown> = { name: 'private-name', code: 'private-code', message: 'private-message' };
    error.cause = error;
    expect(JSON.stringify(safeCodexError(error))).not.toContain('private');
    expect(retryableReadinessError(error)).toBe(false);
  });
  it.each([401, 403, 404, 410, 422])('does not retry permanent HTTP %s errors', status => {
    expect(retryableReadinessError({ name: 'Error', response: { status } })).toBe(false);
  });
});
