import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ get: vi.fn(), snapshot: vi.fn() }));
vi.mock('@vercel/sandbox', () => ({ Sandbox: { get: sdk.get }, Snapshot: { get: sdk.snapshot } }));
import { codexHostPolicy, codexRegistryEnvironment, codexRuntimeWindow, finishCodexLifecycle, parseCodexReceipt, runCodexLifecycle, stopCodexSession, type CodexTurnReceipt } from './codex-lifecycle';

const receipt: CodexTurnReceipt = { reply: 'done', sessionId: 'session', worktree: '/workspace', workerName: 'worker', runId: 'run', gatewayStopped: true, suspension: { status: 'ready', suspensionId: 'suspension', expiresAtMs: 5000 } };

describe('Codex host startup', () => {
  const digest = 'a'.repeat(64);
  const options = { name: 'owned', eventId: 'EvTest', sessionKey: 'session', message: 'private message', oidcToken: 'private-oidc', publish: vi.fn() };
  let command: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let running: Record<string, unknown>;
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(process.env, { OPENCLAW_GATEWAY_TOKEN: 'private-gateway', OPENCLAW_CODEX_RUNTIME_DIGEST: digest, VERCEL_PROJECT_ID: 'project', VERCEL_TEAM_ID: 'team', AI_GATEWAY_API_KEY: 'private-model', OPENCLAW_CODEX_SLEEP_URL: 'https://host.example.org/api/codex/sleep' });
    const fresh = { ...receipt, suspension: { ...receipt.suspension, expiresAtMs: Date.now() + 120000 } };
    command = vi.fn(async (params: {cmd: string}) => ({ exitCode: 0, stdout: async () => params.cmd === 'node' ? `OPENCLAW_HOST_RESULT=${JSON.stringify(fresh)}` : '' }));
    stop = vi.fn(async () => {});
    const base = { persistent: true, currentSnapshotId: 'snapshot', tags: { owner: 'openclaw-connect-codex-v1', runtime: digest }, domain: () => 'https://owned.test', update: vi.fn(async () => {}), stop };
    running = { ...base, status: 'running', currentSession: () => ({ sessionId: 'new-session', runCommand: command }) };
    const stopped = { ...base, status: 'stopped', currentSession: () => ({ sessionId: 'old-session', runCommand: command }) };
    sdk.get.mockReset().mockImplementation(async ({resume}: {resume: boolean}) => resume ? running : stopped);
    sdk.snapshot.mockReset().mockResolvedValue({ snapshotId: 'snapshot', status: 'created', sourceSessionId: 'new-session' });
  });
  it('retries only a transient readiness probe, then launches exactly one runtime', async () => {
    command.mockRejectedValueOnce(new DOMException('private-signal-data', 'TimeoutError'));
    await runCodexLifecycle(options);
    expect(command.mock.calls.map(([p]) => p.cmd)).toEqual(['true', 'true', 'node']);
    expect(sdk.get).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('retries a transient resume timeout once without replaying the task', async () => {
    sdk.get.mockImplementationOnce(async () => ({ ...running, status: 'stopped', currentSession: () => ({ sessionId: 'old-session' }), update: vi.fn() }))
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
      .mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running, status: 'stopped' });
    await runCodexLifecycle(options);
    expect(sdk.get.mock.calls.filter(([p]) => p.resume)).toHaveLength(2);
    expect(command.mock.calls.map(([p]) => p.cmd)).toEqual(['true', 'node']);
  });
  it('stops only its newly woken empty session after readiness retries are exhausted', async () => {
    command.mockRejectedValue(new DOMException('private-signal-data', 'TimeoutError'));
    sdk.get.mockImplementationOnce(async () => ({ ...running, status: 'stopped', currentSession: () => ({ sessionId: 'old-session' }), update: vi.fn() }))
      .mockResolvedValueOnce(running).mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, status: 'stopped' });
    await expect(runCodexLifecycle(options)).rejects.toThrow(/readiness/);
    expect(command.mock.calls.map(([p]) => p.cmd)).toEqual(['true', 'true']);
    expect(stop).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).toContain('TimeoutError');
    expect(logs).toContain('EvTest');
    expect(logs).not.toContain('private-');
  });
  it('does not start the runtime on a nonzero readiness exit', async () => {
    command.mockResolvedValueOnce({ exitCode: 7, stdout: async () => '' });
    await expect(runCodexLifecycle(options)).rejects.toThrow(/readiness/);
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('confirms an empty startup stop even when its acknowledgement times out', async () => {
    command.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    stop.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    sdk.get.mockImplementationOnce(async () => ({ ...running, status: 'stopped', currentSession: () => ({ sessionId: 'old-session' }), update: vi.fn() }))
      .mockResolvedValueOnce(running).mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, status: 'stopped' });
    await expect(runCodexLifecycle(options)).rejects.toThrow(/readiness/);
    const logs = vi.mocked(console.info).mock.calls.map(([, data]) => JSON.parse(String(data)));
    expect(logs).toContainEqual(expect.objectContaining({ phase: 'startup-cleanup', outcome: 'completed' }));
    expect(logs).toContainEqual(expect.objectContaining({ phase: 'stop', outcome: 'failed', error: expect.objectContaining({ name: 'TimeoutError' }) }));
  });
  it('does not retry a readiness authorization failure', async () => {
    command.mockRejectedValueOnce(Object.assign(new Error('private-auth'), { response: { status: 403 } }));
    await expect(runCodexLifecycle(options)).rejects.toThrow(/readiness/);
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('leaves cleanup time inside the host command budget after a slow wake', async () => {
    await runCodexLifecycle({ ...options, budget: { deadlineMs: Date.now() + 150000, replyReserveMs: 15000 } });
    const params = command.mock.calls.find(([p]) => p.cmd === 'node')![0] as { timeoutMs: number; env: Record<string, string> };
    expect(params.timeoutMs).toBeLessThanOrEqual(135000);
    expect(JSON.parse(params.env.OPENCLAW_HOST_INPUT).executionDeadlineMs).toBeLessThanOrEqual(Date.now() + 55000);
  });
  it('uses the full stop and confirmation reserve after a slow publication', async () => {
    let now = Date.now();
    const deadlineMs = now + 100000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timers = vi.spyOn(AbortSignal, 'timeout');
    const execute = command.getMockImplementation()!;
    command.mockImplementation(async params => {
      if (params.cmd === 'node') now = deadlineMs - 80000;
      return execute(params);
    });
    stop.mockImplementation(async () => { now += 45000; });
    try {
      await runCodexLifecycle({ ...options, budget: { deadlineMs, replyReserveMs: 15000 }, publish: async () => { now += 15000; } });
      const stopSignal = (stop.mock.calls[0] as unknown as [{signal: AbortSignal}])[0].signal;
      expect(timers.mock.calls[timers.mock.results.findIndex(r => r.value === stopSignal)][0]).toBe(45000);
      expect(timers.mock.calls.at(-1)![0]).toBeLessThanOrEqual(10000);
    } finally { clock.mockRestore(); timers.mockRestore(); }
  });
  it('allows the documented server snapshot wait during resume', async () => {
    const timers = vi.spyOn(AbortSignal, 'timeout');
    try {
      await runCodexLifecycle(options);
      const signal = sdk.get.mock.calls.find(([p]) => p.resume)![0].signal;
      expect(timers.mock.calls[timers.mock.results.findIndex(r => r.value === signal)][0]).toBe(60000);
    } finally { timers.mockRestore(); }
  });
  it('does not call a stopped VM saved until its snapshot belongs to the completed session', async () => {
    sdk.snapshot.mockResolvedValueOnce({ status: 'created', sourceSessionId: 'old-session' });
    await expect(runCodexLifecycle(options)).rejects.toThrow(/confirm/);
  });
  it('updates the existing VM retention before executing a turn and rejects an expiring checkpoint', async () => {
    sdk.snapshot.mockResolvedValueOnce({ snapshotId: 'snapshot', status: 'created', sourceSessionId: 'new-session', expiresAt: new Date(Date.now() + 7 * 86400000) });
    await expect(runCodexLifecycle(options)).rejects.toThrow(/confirm/);
    const update = running.update as ReturnType<typeof vi.fn>;
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0, deleteEvicted: true } }), expect.anything());
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(command.mock.invocationCallOrder[0]);
  });
  it('does not replay or normal-stop an ambiguously submitted runtime', async () => {
    command.mockResolvedValueOnce({ exitCode: 0, stdout: async () => '' }).mockRejectedValueOnce(new DOMException('secret', 'TimeoutError'));
    await expect(runCodexLifecycle(options)).rejects.toThrow(/runtime/);
    expect(command.mock.calls.map(([p]) => p.cmd)).toEqual(['true', 'node']);
    expect(stop).not.toHaveBeenCalled();
  });
  it('reuses a running VM without wake, stop or snapshot', async () => {
    sdk.get.mockResolvedValue(running);
    const warm = { ...receipt, gatewayStopped: false, suspension: undefined, platformSessionId: 'new-session', gatewayPid: 42, idleTimeoutMs: 2700000 };
    command.mockImplementation(async params => ({ exitCode: 0, stdout: async () => params.cmd === 'node' ? `OPENCLAW_HOST_RESULT=${JSON.stringify(warm)}` : '' }));
    expect((await runCodexLifecycle(options)).gatewayStopped).toBe(false);
    expect(command.mock.calls.map(([p]) => p.cmd)).toEqual(['true', 'node']);
    expect(sdk.get.mock.calls.every(([p]) => p.resume === false)).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(sdk.snapshot).not.toHaveBeenCalled();
  });
  it('retries a stopped gateway with a permanent resident fence after its old lease expires', async () => {
    const sleep = { action: 'sleep', reason: 'idle', platformSessionId: 'new-session', runtimeDigest: digest, gatewayStopped: true, residentFenced: true, workerStopped: true, suspension: { status: 'ready', suspensionId: 'old-lease', expiresAtMs: 1 } };
    command.mockResolvedValue({ exitCode: 0, stdout: async () => `OPENCLAW_HOST_RESULT=${JSON.stringify(sleep)}` });
    sdk.get.mockReset().mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running, status: 'stopped' });
    const result = await stopCodexSession({ name: 'owned', platformSessionId: 'new-session', oidcToken: 'fresh' });
    expect(result.action).toBe('sleep');
    expect(stop).toHaveBeenCalledOnce();
    expect(sdk.get.mock.calls.every(([p]) => p.resume === false)).toBe(true);
  });
  it('a stale sleep request cannot execute commands or stop a freshly resumed session', async () => {
    sdk.get.mockResolvedValue(running);
    expect((await stopCodexSession({ name: 'owned', platformSessionId: 'old-session', oidcToken: 'fresh' })).action).toBe('stale');
    expect(command).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it('confirms retention on a sleep checkpoint and never claims success for an expiring one', async () => {
    const sleep = { action: 'sleep', platformSessionId: 'new-session', runtimeDigest: digest, gatewayStopped: true, residentFenced: true, workerStopped: true, suspension: { status: 'ready', suspensionId: 'lease' } };
    command.mockResolvedValue({ exitCode: 0, stdout: async () => `OPENCLAW_HOST_RESULT=${JSON.stringify(sleep)}` });
    sdk.get.mockReset().mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running, status: 'stopped' });
    sdk.snapshot.mockResolvedValueOnce({ snapshotId: 'snapshot', status: 'created', sourceSessionId: 'new-session', expiresAt: new Date(Date.now() + 7 * 86400000) });
    await expect(stopCodexSession({ name: 'owned', platformSessionId: 'new-session', oidcToken: 'fresh' })).rejects.toThrow('retention');
    const update = running.update as ReturnType<typeof vi.fn>;
    expect(update).toHaveBeenCalledWith({ snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0, deleteEvicted: true } }, expect.anything());
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);
  });
  it('does not accept expired gateway leases without the permanent resident fence', async () => {
    sdk.get.mockResolvedValue(running);
    const sleep = { action: 'sleep', platformSessionId: 'new-session', runtimeDigest: digest, gatewayStopped: true, suspension: { status: 'ready', suspensionId: 'lease', expiresAtMs: 1 } };
    command.mockResolvedValue({ exitCode: 0, stdout: async () => `OPENCLAW_HOST_RESULT=${JSON.stringify(sleep)}` });
    await expect(stopCodexSession({ name: 'owned', platformSessionId: 'new-session', oidcToken: 'fresh' })).rejects.toThrow('fence');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('Codex sleep/wake receipt', () => {
  it('a 130s setup plus 100s execution cannot outrun a 200s host command', () => {
    const { executionDeadlineMs } = codexRuntimeWindow(200000, 0);
    expect(executionDeadlineMs).toBe(120000);
    expect(130000 + 100000).toBeGreaterThan(executionDeadlineMs);
    expect(executionDeadlineMs + 80000).toBe(200000);
    expect(() => codexRuntimeWindow(80000)).toThrow();
  });
  it('does not post a duplicate after native Slack delivery', async () => {
    let published = false;
    await finishCodexLifecycle({ execute: async () => ({ ...receipt, nativeSlackDelivered: true }), publish: async () => { published = true; }, stop: async () => {}, isStopped: async () => true });
    expect(published).toBe(false);
  });
  it.each(['stop', 'confirmation'])('records native delivery before a %s failure', async failure => {
    const events: string[] = [];
    const steps = {
      execute: async () => ({ ...receipt, nativeSlackDelivered: true as const }),
      onNativeDelivered: () => { events.push('delivered'); },
      publish: async () => { events.push('duplicate'); },
      stop: async () => { events.push('stop'); if (failure === 'stop') throw new Error('stop failed'); },
      isStopped: async () => false,
    };
    await expect(finishCodexLifecycle(steps)).rejects.toThrow(failure === 'stop' ? 'stop failed' : 'not confirmed');
    expect(events).toEqual(['delivered', 'stop']);
  });
  it('injects native Slack credentials only on Slack API egress', () => {
    const policy = codexHostPolicy('model', 'slack-token');
    expect(JSON.stringify(policy)).toContain('slack.com');
    expect(JSON.stringify(policy)).toContain('/api/');
    expect(JSON.stringify(policy)).not.toContain('api.slack.com');
  });
  it('passes an explicitly scoped install credential to the trusted controller only', () => {
    const pair = { OPENCLAW_NPM_AUTHORIZATION: 'synthetic', OPENCLAW_NPM_AUTH_REGISTRY: 'https://registry.example.test/npm/' };
    expect(codexRegistryEnvironment({ ...pair, AI_GATEWAY_API_KEY: 'private', SLACK_TOKEN: 'private' })).toEqual(pair);
    expect(codexRegistryEnvironment({})).toEqual({});
    expect(() => codexRegistryEnvironment({ OPENCLAW_NPM_AUTHORIZATION: 'synthetic' })).toThrow();
  });
  it('accepts only a complete, unexpired lifecycle receipt', () => {
    const output = `log line\nOPENCLAW_HOST_RESULT=${JSON.stringify(receipt)}\n`;
    expect(parseCodexReceipt(output, 1000)).toEqual(receipt);
    expect(() => parseCodexReceipt(output, 5000)).toThrow();
    expect(() => parseCodexReceipt(output + output, 1000)).toThrow();
    expect(() => parseCodexReceipt('done', 1000)).toThrow();
    expect(() => parseCodexReceipt(`OPENCLAW_HOST_RESULT=${JSON.stringify({ ...receipt, gatewayStopped: false })}`, 1000)).toThrow();
  });
  it('publishes after reclaim and fences, then stops and independently checks VM1', async () => {
    const events: string[] = [];
    await finishCodexLifecycle({ execute: async () => { events.push('reclaim-and-fence'); return receipt; }, publish: async () => { events.push('reply'); }, stop: async () => { events.push('snapshot-stop'); }, isStopped: async () => { events.push('inspect'); return true; } });
    expect(events).toEqual(['reclaim-and-fence', 'reply', 'snapshot-stop', 'inspect']);
  });
  it('still saves the prepared state when Slack posting fails', async () => {
    let stopped = false;
    await expect(finishCodexLifecycle({ execute: async () => receipt, publish: async () => { throw new Error('Slack unavailable'); }, stop: async () => { stopped = true; }, isStopped: async () => true })).rejects.toThrow('Slack unavailable');
    expect(stopped).toBe(true);
  });
  it('does not claim a stop when the platform disagrees', async () => {
    await expect(finishCodexLifecycle({ execute: async () => receipt, publish: async () => {}, stop: async () => {}, isStopped: async () => false })).rejects.toThrow('not confirmed');
  });
  it('does not normal-stop a runtime with no successful fence', async () => {
    let stopped = false;
    await expect(finishCodexLifecycle({ execute: async () => { throw new Error('busy'); }, publish: async () => {}, stop: async () => { stopped = true; }, isStopped: async () => true })).rejects.toThrow('busy');
    expect(stopped).toBe(false);
  });
  it('brokers only AI Gateway credentials, never a direct OpenAI key', () => {
    const policy = codexHostPolicy('test-key');
    expect(JSON.stringify(policy)).toContain('ai-gateway.vercel.sh');
    expect(JSON.stringify(policy)).not.toContain('api.openai.com');
    expect(() => codexHostPolicy('')).toThrow();
  });
});
