/**
 * SandboxController — injectable interface over @vercel/sandbox.
 *
 * Production code uses the real Sandbox SDK.  Tests swap in
 * FakeSandboxController via `_setSandboxControllerForTesting()`.
 */
import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";

// ---------------------------------------------------------------------------
// Minimal result types that mirror what lifecycle.ts actually reads
// ---------------------------------------------------------------------------

export type CommandResult = {
  exitCode: number;
  output(stream?: "stdout" | "stderr" | "both"): Promise<string>;
};

export type SnapshotResult = {
  snapshotId: string;
};

export type CreateParams = {
  ports?: number[];
  timeout?: number;
  resources?: { vcpus: number };
  source?: { type: "snapshot"; snapshotId: string };
  env?: Record<string, string>;
  networkPolicy?: NetworkPolicy;
};

// ---------------------------------------------------------------------------
// SandboxHandle — the instance-level surface lifecycle.ts touches
// ---------------------------------------------------------------------------

export type RunCommandOptions = {
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
};

export interface SandboxHandle {
  sandboxId: string;
  readonly timeout: number;
  runCommand(
    commandOrOptions: string | RunCommandOptions,
    args?: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<CommandResult>;
  writeFiles(
    files: { path: string; content: Buffer }[],
  ): Promise<void>;
  readFileToBuffer(file: { path: string; cwd?: string }): Promise<Buffer | null>;
  domain(port: number): string;
  snapshot(): Promise<SnapshotResult>;
  extendTimeout(duration: number): Promise<void>;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<NetworkPolicy>;
}

// ---------------------------------------------------------------------------
// SandboxController — the static-level surface (create / get)
// ---------------------------------------------------------------------------

export interface SandboxController {
  create(params: CreateParams): Promise<SandboxHandle>;
  get(params: { sandboxId: string }): Promise<SandboxHandle>;
}

// ---------------------------------------------------------------------------
// Real implementation — wraps @vercel/sandbox
// ---------------------------------------------------------------------------

function wrapSandbox(sandbox: Sandbox): SandboxHandle {
  return {
    sandboxId: sandbox.sandboxId,
    get timeout() {
      return sandbox.timeout;
    },
    async runCommand(
      commandOrOpts: string | RunCommandOptions,
      args?: string[],
      opts?: { signal?: AbortSignal },
    ) {
      if (typeof commandOrOpts === "object") {
        const result = await sandbox.runCommand({
          cmd: commandOrOpts.cmd,
          args: commandOrOpts.args ?? [],
          env: commandOrOpts.env,
          signal: commandOrOpts.signal,
        });
        return {
          exitCode: result.exitCode,
          output: (stream?: "stdout" | "stderr" | "both") => result.output(stream),
        };
      }
      const result = await sandbox.runCommand(commandOrOpts, args ?? [], opts);
      return {
        exitCode: result.exitCode,
        output: (stream?: "stdout" | "stderr" | "both") => result.output(stream),
      };
    },
    async writeFiles(files) {
      await sandbox.writeFiles(files);
    },
    async readFileToBuffer(file) {
      try {
        return await sandbox.readFileToBuffer(file);
      } catch {
        return null;
      }
    },
    domain(port) {
      return sandbox.domain(port);
    },
    async snapshot() {
      const snap = await sandbox.snapshot();
      return { snapshotId: snap.snapshotId };
    },
    async extendTimeout(duration) {
      await sandbox.extendTimeout(duration);
    },
    async updateNetworkPolicy(policy) {
      return sandbox.updateNetworkPolicy(policy);
    },
  };
}

const realController: SandboxController = {
  async create(params) {
    const { Sandbox: SandboxClass } = await import("@vercel/sandbox");
    // CreateParams is a simplified subset — cast to satisfy the SDK's union type.
    const sandbox = await SandboxClass.create(params as Parameters<typeof SandboxClass.create>[0]);
    return wrapSandbox(sandbox);
  },
  async get(params) {
    const { Sandbox: SandboxClass } = await import("@vercel/sandbox");
    const sandbox = await SandboxClass.get(params);
    return wrapSandbox(sandbox);
  },
};

// ---------------------------------------------------------------------------
// Module-level singleton with test override
// ---------------------------------------------------------------------------

let activeController: SandboxController = realController;

export function getSandboxController(): SandboxController {
  return activeController;
}

export function _setSandboxControllerForTesting(
  controller: SandboxController | null,
): void {
  activeController = controller ?? realController;
}
