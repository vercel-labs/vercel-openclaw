import { describe, expect, it, vi } from 'vitest';
import { authorizeSleep, sleepCapability, sleepUrl } from './codex-sleep-auth';

describe('sleep authorization', () => {
  it('binds the capability to this runtime, VM and platform session', () => {
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'test-key');
    try {
      const digest = 'a'.repeat(64);
      const authorization = `Bearer ${sleepCapability('name', 'session', digest)}`;
      expect(authorizeSleep(authorization, 'name', 'session', digest)).toBe(true);
      expect(authorizeSleep(authorization, 'name', 'new-session', digest)).toBe(false);
      expect(authorizeSleep(authorization, 'other', 'session', digest)).toBe(false);
      expect(authorizeSleep(authorization, 'name', 'session', 'b'.repeat(64))).toBe(false);
      expect(authorizeSleep('test-key', 'name', 'session', digest)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('requires a configured public callback with no credentials in the URL', () => {
    expect(sleepUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'host.example.org' })).toBe('https://host.example.org/api/codex/sleep');
    expect(() => sleepUrl({})).toThrow();
    expect(() => sleepUrl({ OPENCLAW_CODEX_SLEEP_URL: 'https://secret@example.org/api/codex/sleep' })).toThrow();
    expect(() => sleepUrl({ OPENCLAW_CODEX_SLEEP_URL: 'http://example.org/api/codex/sleep' })).toThrow();
  });
});
