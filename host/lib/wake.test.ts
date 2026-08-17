import type { NetworkPolicy } from '@vercel/sandbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const state = {
    marker: 'legacy-runtime',
    gatewayRunning: false,
    policies: [] as NetworkPolicy[],
    commands: [] as Array<{ command: unknown; args?: string[] }>,
    // Single ordered log across both policy changes and commands. `policies` and
    // `commands` cannot be interleaved, and the npm-window invariant is purely
    // about their relative order.
    events: [] as string[],
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
      state.events.push(
        JSON.stringify(policy).includes('npmjs.org') ? 'policy:npm-open' : 'policy:restricted',
      );
    }),
    runCommand: vi.fn(async (command: unknown, args?: string[]) => {
      state.commands.push({ command, args });
      {
        // Commands arrive in two shapes: (cmd, args) and a single spec object.
        // Flatten both so a match does not depend on argument position.
        const spec = command as { cmd?: string; args?: string[] } | string;
        const line =
          typeof spec === 'object' && spec
            ? [spec.cmd, ...(spec.args ?? [])].join(' ')
            : [String(spec), ...(args ?? [])].join(' ');
        if (line.includes('pkill')) state.events.push('cmd:stop-gateway');
        else if (line.includes('plugins install')) state.events.push('cmd:plugins-install');
        else if (line.includes('openclaw gateway run')) state.events.push('cmd:start-gateway');
      }
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
    harness.state.events.length = 0;
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
  });

  it('stops the gateway before opening npm egress, even on a running sandbox', async () => {
    // The dangerous case, and the only one that was ever wrong: a sandbox that is
    // already running when the runtime fingerprint moves. That happens on any
    // deploy changing RUNTIME_CONFIG_VERSION or configOperations, a different
    // OPENCLAW_MODEL, or a rotated gateway token. If the plugin install ran first,
    // the old gateway would keep serving with registry.npmjs.org reachable for up
    // to the install timeout, breaking "no agent code ever runs with the registry
    // reachable" (lib/model-credentials.ts).
    harness.state.gatewayRunning = true;
    harness.state.marker = 'stale-fingerprint';

    await ensureAwake('npm-window-ordering', {
      oidcToken: 'request-token',
      budget: { deadlineMs: Date.now() + 60_000, replyReserveMs: 15_000 },
    });

    const { events } = harness.state;
    const stopped = events.indexOf('cmd:stop-gateway');
    const npmOpened = events.indexOf('policy:npm-open');
    const installed = events.indexOf('cmd:plugins-install');

    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(npmOpened).toBeGreaterThanOrEqual(0);
    expect(installed).toBeGreaterThanOrEqual(0);
    // The whole point: the gateway is down first.
    expect(stopped).toBeLessThan(npmOpened);
    expect(stopped).toBeLessThan(installed);
    // And it is not restarted while the window is still open.
    const started = events.indexOf('cmd:start-gateway');
    const lastNpm = events.lastIndexOf('policy:npm-open');
    expect(started).toBeGreaterThan(lastNpm);
    expect(JSON.stringify(harness.state.policies.at(-1))).not.toContain('npmjs.org');
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
