import type { NetworkPolicy } from '@vercel/sandbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const state = {
    marker: 'legacy-runtime',
    gatewayRunning: false,
    policies: [] as NetworkPolicy[],
    commands: [] as Array<{ command: unknown; args?: string[] }>,
  };
  const result = (exitCode = 0, stdout = '', stderr = '') => ({
    exitCode,
    stdout: async () => stdout,
    stderr: async () => stderr,
  });
  const sandbox = {
    status: 'running',
    domain: vi.fn(() => {
      throw new Error('No route for port 18789');
    }),
    updateNetworkPolicy: vi.fn(async (policy: NetworkPolicy) => {
      state.policies.push(policy);
    }),
    runCommand: vi.fn(async (command: unknown, args?: string[]) => {
      state.commands.push({ command, args });
      if (command === 'sh' && args?.[1]?.includes('cat /tmp/vercel-openclaw-runtime')) {
        return result(0, state.marker);
      }
      if (typeof command === 'object' && command) {
        const spec = command as {
          cmd?: string;
          args?: string[];
          env?: Record<string, string>;
        };
        if (spec.cmd === 'sh' && spec.args?.[1]?.includes('cat /tmp/vercel-openclaw-runtime')) {
          return result(0, state.marker);
        }
        if (spec.env?.OPENCLAW_RUNTIME_FINGERPRINT) {
          state.marker = spec.env.OPENCLAW_RUNTIME_FINGERPRINT;
          return result();
        }
        if (spec.cmd === 'bash' && spec.args?.[1]?.includes('exec 3<>')) {
          return result(state.gatewayRunning ? 0 : 1);
        }
        if (spec.cmd === 'bash' && spec.args?.[1]?.includes('mkdir /tmp/vercel-openclaw-runtime.lock')) {
          return result();
        }
        if (spec.cmd === 'bash' && spec.args?.[1]?.includes('seq 1')) {
          return result(state.gatewayRunning ? 0 : 1);
        }
        if (spec.cmd === 'sh' && spec.args?.[1]?.includes('pkill')) {
          state.gatewayRunning = false;
          return result();
        }
        if (spec.cmd === 'sh' && spec.args?.[1]?.includes('openclaw gateway run')) {
          state.gatewayRunning = true;
          return result();
        }
      }
      return result();
    }),
  };
  return { state, sandbox, getOrCreate: vi.fn(async () => sandbox) };
});

vi.mock('@vercel/sandbox', () => ({
  APIError: class APIError extends Error {
    json?: unknown;
  },
  Sandbox: { getOrCreate: harness.getOrCreate },
}));

import { ensureAwake } from './wake';

describe('ensureAwake', () => {
  beforeEach(() => {
    harness.state.marker = 'legacy-runtime';
    harness.state.gatewayRunning = false;
    harness.state.policies.length = 0;
    harness.state.commands.length = 0;
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
  });

  it('migrates existing config once and refreshes request OIDC only in the firewall', async () => {
    await ensureAwake('migration-test', {
      oidcToken: 'request-token-one',
      budget: { deadlineMs: Date.now() + 60_000, replyReserveMs: 15_000 },
    });
    await ensureAwake('migration-test', {
      oidcToken: 'request-token-two',
      budget: { deadlineMs: Date.now() + 60_000, replyReserveMs: 15_000 },
    });

    // First wake: steady policy, then npm opened for the plugin install, then
    // narrowed again. Second wake: steady policy only, since the plugins are
    // already on the snapshotted disk.
    expect(harness.state.policies).toHaveLength(4);
    const serializedPolicies = JSON.stringify(harness.state.policies);
    expect(serializedPolicies).toContain('Bearer request-token-one');
    expect(serializedPolicies).toContain('Bearer request-token-two');

    // The registry is reachable for exactly one window, and the sandbox is not
    // left in that state. Without this, an install failure could leave npm open
    // to agent code, which is the hole the policy exists to close.
    const npmWindows = harness.state.policies.filter((policy) =>
      JSON.stringify(policy).includes('npmjs.org'),
    );
    expect(npmWindows).toHaveLength(1);
    expect(JSON.stringify(harness.state.policies.at(-1))).not.toContain('npmjs.org');

    const serializedCommands = JSON.stringify(harness.state.commands);
    expect(serializedCommands).not.toContain('request-token-one');
    expect(serializedCommands).not.toContain('request-token-two');
    const configurationCommands = harness.state.commands.filter(({ command }) => {
      if (typeof command !== 'object' || command === null) return false;
      return (command as { args?: string[] }).args?.includes('--batch-json');
    });
    expect(configurationCommands).toHaveLength(1);
  });

  it('bounds every wake SDK operation by the shared budget', async () => {
    await ensureAwake('deadline-test', {
      oidcToken: 'request-token',
      budget: { deadlineMs: Date.now() + 60_000, replyReserveMs: 15_000 },
    });

    expect(harness.getOrCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ports: expect.anything() }),
    );
    expect(harness.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.sandbox.domain).not.toHaveBeenCalled();
    expect(harness.sandbox.updateNetworkPolicy).toHaveBeenCalledWith(
      expect.anything(),
      { signal: expect.any(AbortSignal) },
    );

    for (const [command] of harness.sandbox.runCommand.mock.calls) {
      expect(command).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
      if (!(command as { detached?: boolean }).detached) {
        expect(command).toEqual(expect.objectContaining({ timeoutMs: expect.any(Number) }));
      }
    }
  });
});
