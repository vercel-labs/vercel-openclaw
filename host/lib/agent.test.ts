import type { Sandbox } from '@vercel/sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  didUseGateway,
  parseTurnOutput,
  runAgentTurn,
  slackSessionKey,
} from './agent';

afterEach(() => vi.restoreAllMocks());

/**
 * Fixtures are trimmed from output observed live against OpenClaw 2026.7.1 on
 * 2026-08-14 (scripts/probe-agent-turn.ts), not invented. The `meta` block in
 * the real payload is ~10KB of diagnostics; only the fields this module reads
 * are kept.
 */
/** Embedded-fallback shape: payloads and meta at the top level. */
const OBSERVED_PAYLOAD = JSON.stringify(
  {
    payloads: [{ text: 'bridge works', mediaUrl: null }],
    meta: {
      durationMs: 5453,
      finalAssistantVisibleText: 'bridge works',
      transport: 'embedded',
      fallbackFrom: 'gateway',
      executionTrace: { winnerProvider: 'openai', winnerModel: 'gpt-5.6-sol' },
    },
  },
  null,
  2,
);

/** Gateway-served shape: the same result inside a run envelope. */
const OBSERVED_GATEWAY_PAYLOAD = JSON.stringify(
  {
    runId: '81032697-ea37-41d1-ae61-bf45361ba9ac',
    status: 'ok',
    summary: 'completed',
    result: {
      payloads: [{ text: 'bridge works', mediaUrl: null }],
      meta: {
        durationMs: 4906,
        finalAssistantVisibleText: 'bridge works',
        agentMeta: { provider: 'openai', model: 'gpt-5.6-sol' },
      },
    },
  },
  null,
  2,
);

describe('parseTurnOutput', () => {
  it('reads the reply from payloads, not from the diagnostic meta block', () => {
    const { reply, raw } = parseTurnOutput(OBSERVED_PAYLOAD);
    expect(reply).toBe('bridge works');
    // The caller must get structured output back for logging.
    expect((raw as { meta: { durationMs: number } }).meta.durationMs).toBe(5453);
  });

  it('unwraps the run envelope the gateway path returns', () => {
    // Regression: the gateway nests the result under `result` with a runId and
    // status wrapper, so a parser written for the flat embedded shape returned
    // the whole blob as the reply text.
    const { reply, status } = parseTurnOutput(OBSERVED_GATEWAY_PAYLOAD);
    expect(reply).toBe('bridge works');
    expect(status).toBe('ok');
  });

  it('surfaces no status for the flat embedded shape', () => {
    expect(parseTurnOutput(OBSERVED_PAYLOAD).status).toBeUndefined();
  });

  it('handles the pretty-printed multi-line payload OpenClaw actually emits', () => {
    // Regression: an earlier implementation scanned for a single line starting
    // with "{" and so returned the whole blob as the reply text.
    expect(OBSERVED_PAYLOAD.split('\n').length).toBeGreaterThan(1);
    expect(parseTurnOutput(OBSERVED_PAYLOAD).reply).not.toContain('"meta"');
  });

  it('joins multiple payloads in order', () => {
    const stdout = JSON.stringify({
      payloads: [{ text: 'first' }, { text: '' }, { text: 'second' }],
    });
    expect(parseTurnOutput(stdout).reply).toBe('first\n\nsecond');
  });

  it('falls back to meta.finalAssistantVisibleText when payloads carry no text', () => {
    const stdout = JSON.stringify({
      payloads: [{ text: '', mediaUrl: null }],
      meta: { finalAssistantVisibleText: 'from meta' },
    });
    expect(parseTurnOutput(stdout).reply).toBe('from meta');
  });

  it('tolerates log lines printed before the payload', () => {
    const stdout = `[gateway] pre-warmed plugins\n${OBSERVED_PAYLOAD}`;
    expect(parseTurnOutput(stdout).reply).toBe('bridge works');
  });

  it('degrades to raw text rather than throwing on unparseable output', () => {
    const { reply, raw } = parseTurnOutput('not json at all');
    expect(reply).toBe('not json at all');
    expect(raw).toBeUndefined();
  });

  it('returns empty for empty output', () => {
    expect(parseTurnOutput('   ')).toEqual({ reply: '', raw: undefined });
  });

  it('never exposes parsed diagnostic output as a channel reply', () => {
    const stdout = JSON.stringify({ somethingElse: true });
    const { reply } = parseTurnOutput(stdout);
    expect(reply).toBe('');
  });
});

describe('didUseGateway', () => {
  it('detects the embedded fallback that bypasses the managed gateway', () => {
    // Both fields taken from a real fallback payload, 2026-08-14.
    expect(didUseGateway({ meta: { transport: 'embedded', fallbackFrom: 'gateway' } })).toBe(false);
  });

  it('detects a fallback even when only fallbackFrom is present', () => {
    expect(didUseGateway({ meta: { fallbackFrom: 'gateway' } })).toBe(false);
  });

  it('reads through the run envelope, not just the flat shape', () => {
    expect(didUseGateway(JSON.parse(OBSERVED_GATEWAY_PAYLOAD))).toBe(true);
    expect(didUseGateway(JSON.parse(OBSERVED_PAYLOAD))).toBe(false);
    // A fallback nested inside an envelope must still be caught.
    expect(didUseGateway({ status: 'ok', result: { meta: { transport: 'embedded' } } })).toBe(false);
  });

  it('fails closed unless the managed gateway run envelope is positively identified', () => {
    expect(didUseGateway({ meta: { transport: 'gateway' } })).toBe(false);
    expect(didUseGateway({ status: 'ok', result: { payloads: [] } })).toBe(false);
    expect(didUseGateway({})).toBe(false);
    expect(didUseGateway(undefined)).toBe(false);
  });
});

describe('runAgentTurn', () => {
  it('rejects a successful-looking reply produced by the embedded fallback', async () => {
    const sandbox = {
      runCommand: async () => ({
        exitCode: 0,
        stdout: async () => OBSERVED_PAYLOAD,
        stderr: async () => '',
      }),
    } as unknown as Sandbox;

    await expect(
      runAgentTurn({
        sandbox,
        message: 'hello',
        sessionKey: 'agent:main:test',
        gatewayToken: 'gateway-token',
      }),
    ).rejects.toThrow(/did not use the managed gateway/);
  });

  it('rejects a gateway envelope whose run did not complete successfully', async () => {
    const failed = JSON.stringify({
      ...JSON.parse(OBSERVED_GATEWAY_PAYLOAD),
      status: 'error',
    });
    const sandbox = {
      runCommand: async () => ({
        exitCode: 0,
        stdout: async () => failed,
        stderr: async () => '',
      }),
    } as unknown as Sandbox;

    await expect(
      runAgentTurn({
        sandbox,
        message: 'hello',
        sessionKey: 'agent:main:test',
        gatewayToken: 'gateway-token',
      }),
    ).rejects.toThrow(/reported status error/);
  });

  it('rejects a successful envelope without channel-visible text', async () => {
    const diagnosticOnly = JSON.stringify({
      runId: '81032697-ea37-41d1-ae61-bf45361ba9ac',
      status: 'ok',
      result: {
        payloads: [{ mediaUrl: 'https://example.com/image.png' }],
        meta: { systemPromptReport: { huge: 'diagnostic block' } },
      },
    });
    const sandbox = {
      runCommand: async () => ({
        exitCode: 0,
        stdout: async () => diagnosticOnly,
        stderr: async () => '',
      }),
    } as unknown as Sandbox;

    await expect(
      runAgentTurn({
        sandbox,
        message: 'hello',
        sessionKey: 'agent:main:test',
        gatewayToken: 'gateway-token',
      }),
    ).rejects.toThrow(/no channel-visible reply/);
  });

  it('bounds both the OpenClaw timeout and SDK command by the shared budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => OBSERVED_GATEWAY_PAYLOAD,
      stderr: async () => '',
    }));
    const sandbox = { runCommand } as unknown as Sandbox;

    await runAgentTurn({
      sandbox,
      message: 'hello',
      sessionKey: 'agent:main:test',
      gatewayToken: 'gateway-token',
      budget: { deadlineMs: 1_180_000, replyReserveMs: 15_000 },
    });

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--timeout', '165']),
        timeoutMs: 165_000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('bounds command output collection by the same shared budget', async () => {
    const sandbox = {
      runCommand: async () => ({
        exitCode: 0,
        stdout: async () => new Promise<string>(() => undefined),
        stderr: async () => '',
      }),
    } as unknown as Sandbox;

    await expect(
      runAgentTurn({
        sandbox,
        message: 'hello',
        sessionKey: 'agent:main:test',
        gatewayToken: 'gateway-token',
        budget: { deadlineMs: Date.now() + 20, replyReserveMs: 0 },
      }),
    ).rejects.toThrow(/execution deadline reached before agent command output/);
  });
});

describe('slackSessionKey', () => {
  it('maps one user in one channel onto a durable OpenClaw session', () => {
    expect(slackSessionKey('C123', 'U123')).toBe(
      'agent:main:slack-C123-U123',
    );
  });

  it('isolates different users and different channels', () => {
    expect(slackSessionKey('C123', 'U1')).not.toBe(slackSessionKey('C123', 'U2'));
    expect(slackSessionKey('C1', 'U1')).not.toBe(slackSessionKey('C2', 'U1'));
  });

  it('supports a non-default agent id', () => {
    expect(slackSessionKey('C123', 'U1', 'ops')).toBe('agent:ops:slack-C123-U1');
  });
});
