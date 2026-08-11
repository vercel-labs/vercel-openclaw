import { describe, it, expect } from 'vitest';
import {
  normalizePrepareResponse,
  decideSuspendAction,
  attemptSuspend,
  IDLE_REARM_MS,
  type SuspendReady,
  type SuspendBusy,
} from './suspend';

const NOW = 1_700_000_000_000;

const ready: SuspendReady = {
  status: 'ready',
  suspensionId: 'sus-1',
  expiresAtMs: NOW + 120_000,
  activeCount: 0,
  blockers: [],
};

const busy: SuspendBusy = {
  status: 'busy',
  reason: 'active-work',
  retryAfterMs: 20_000,
  activeCount: 2,
  blockers: ['chat-run'],
};

describe('normalizePrepareResponse', () => {
  it('passes through a well-formed ready', () => {
    expect(normalizePrepareResponse(ready)).toEqual(ready);
  });

  it('rejects a ready missing suspensionId/expiresAtMs (must never stop on it)', () => {
    expect(() => normalizePrepareResponse({ status: 'ready' })).toThrow(/malformed ready/);
    expect(() =>
      normalizePrepareResponse({ status: 'ready', suspensionId: 'x' }),
    ).toThrow(/malformed ready/);
  });

  it('defaults busy blockers and retryAfterMs when absent', () => {
    const result = normalizePrepareResponse({ status: 'busy' });
    expect(result).toMatchObject({
      status: 'busy',
      reason: 'active-work',
      retryAfterMs: 20_000,
      blockers: [],
    });
  });

  it('preserves a legitimate retryAfterMs of 0', () => {
    const result = normalizePrepareResponse({ status: 'busy', retryAfterMs: 0 });
    expect(result).toMatchObject({ retryAfterMs: 0 });
  });

  it('maps the conflict error shape (UNAVAILABLE with details.reason)', () => {
    const result = normalizePrepareResponse({
      error: {
        details: { reason: 'gateway-suspension-conflict', expiresAtMs: NOW + 60_000 },
      },
    });
    expect(result).toEqual({ status: 'conflict', expiresAtMs: NOW + 60_000 });
  });

  it('defaults a conflict without expiresAtMs to now + 30s (injected clock)', () => {
    const result = normalizePrepareResponse(
      { error: { details: { reason: 'gateway-suspension-conflict' } } },
      NOW,
    );
    expect(result).toEqual({ status: 'conflict', expiresAtMs: NOW + 30_000 });
  });

  it('maps scheduler recovery arriving as an error', () => {
    const result = normalizePrepareResponse({
      error: { details: { reason: 'scheduler-resume-failed' }, retryAfterMs: 1_000 },
    });
    expect(result).toMatchObject({ status: 'recovering' });
  });

  it('throws on unrecognized shapes', () => {
    expect(() => normalizePrepareResponse({ ok: true })).toThrow(/unrecognized/);
    expect(() => normalizePrepareResponse(null)).toThrow(/unrecognized/);
  });
});

describe('decideSuspendAction', () => {
  it('ready -> stop, carrying the lease identifiers', () => {
    expect(decideSuspendAction(ready, NOW)).toEqual({
      action: 'stop',
      suspensionId: 'sus-1',
      leaseExpiresAtMs: ready.expiresAtMs,
    });
  });

  it('busy on the idle path -> rearm +15 min, nothing held', () => {
    const decision = decideSuspendAction(busy, NOW);
    expect(decision).toEqual({
      action: 'rearm',
      nextCheckAtMs: NOW + IDLE_REARM_MS,
      blockers: ['chat-run'],
    });
  });

  it('busy on the ceiling path before force-stop time -> retry at retryAfterMs', () => {
    const decision = decideSuspendAction(busy, NOW, {
      ceiling: { forceStopAtMs: NOW + 4 * 60_000 },
    });
    expect(decision).toEqual({
      action: 'retry',
      nextRetryAtMs: NOW + 20_000,
      reason: 'busy: active-work',
    });
  });

  it('busy at or past the ceiling force-stop time -> force-stop', () => {
    const decision = decideSuspendAction(busy, NOW, {
      ceiling: { forceStopAtMs: NOW },
    });
    expect(decision.action).toBe('force-stop');
  });

  it('conflict -> retry no earlier than now, no later than +30s', () => {
    const past = decideSuspendAction({ status: 'conflict', expiresAtMs: NOW - 5_000 }, NOW);
    expect(past).toMatchObject({ action: 'retry', nextRetryAtMs: NOW });
    const future = decideSuspendAction(
      { status: 'conflict', expiresAtMs: NOW + 90_000 },
      NOW,
    );
    expect(future).toMatchObject({ action: 'retry', nextRetryAtMs: NOW + 30_000 });
  });

  it('recovering -> retry after retryAfterMs', () => {
    const decision = decideSuspendAction({ status: 'recovering', retryAfterMs: 1_000 }, NOW);
    expect(decision).toMatchObject({ action: 'retry', nextRetryAtMs: NOW + 1_000 });
  });
});

describe('attemptSuspend', () => {
  it('stops on ready and reports the decision', async () => {
    const calls: string[] = [];
    const decision = await attemptSuspend({
      call: async (method) => {
        calls.push(method);
        return ready;
      },
      stop: async () => {
        calls.push('stop');
      },
      requestId: 'req-1',
      now: () => NOW,
    });
    expect(decision.action).toBe('stop');
    expect(calls).toEqual(['gateway.suspend.prepare', 'stop']);
  });

  it('does not stop on busy', async () => {
    let stopped = false;
    const decision = await attemptSuspend({
      call: async () => busy,
      stop: async () => {
        stopped = true;
      },
      requestId: 'req-1',
      now: () => NOW,
    });
    expect(decision.action).toBe('rearm');
    expect(stopped).toBe(false);
  });

  it('releases the held lease when stop() fails', async () => {
    const calls: Array<[string, unknown]> = [];
    await expect(
      attemptSuspend({
        call: async (method, params) => {
          calls.push([method, params]);
          if (method === 'gateway.suspend.prepare') return ready;
          return { ok: true };
        },
        stop: async () => {
          throw new Error('network blip');
        },
        requestId: 'req-1',
        now: () => NOW,
      }),
    ).rejects.toThrow('network blip');
    expect(calls[1][0]).toBe('gateway.suspend.resume');
    expect(calls[1][1]).toEqual({ suspensionId: 'sus-1' });
  });
});
