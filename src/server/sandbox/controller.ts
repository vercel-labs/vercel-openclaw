/**
 * SandboxController — injectable interface over @vercel/sandbox.
 *
 * Production code uses the real Sandbox SDK.  Tests swap in
 * FakeSandboxController via `_setSandboxControllerForTesting()`.
 */
import type { Writable } from "node:stream";

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
  name?: string;
  persistent?: boolean;
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
  detached?: boolean;
  signal?: AbortSignal;
  stdout?: Writable;
  stderr?: Writable;
};

export type SandboxStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "aborted"
  | "snapshotting";

export interface SandboxHandle {
  sandboxId: string;
  readonly timeout: number;
  readonly status: SandboxStatus;
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
  stop(options?: { blocking?: boolean }): Promise<void>;
  delete(options?: { signal?: AbortSignal }): Promise<void>;
  extendTimeout(duration: number): Promise<void>;
  updateNetworkPolicy(policy: NetworkPolicy): Promise<NetworkPolicy>;
  runDetachedCommand(options: RunCommandOptions): Promise<{ cmdId: string }>;
  getCommand(cmdId: string): Promise<{ kill(signal?: string): Promise<void> }>;
}

// ---------------------------------------------------------------------------
// SandboxController — the static-level surface (create / get)
// ---------------------------------------------------------------------------

export interface SandboxController {
  create(params: CreateParams): Promise<SandboxHandle>;
  get(params: { sandboxId: string; resume?: boolean }): Promise<SandboxHandle>;
}

// ---------------------------------------------------------------------------
// Real implementation — wraps @vercel/sandbox
// ---------------------------------------------------------------------------

function wrapSandbox(sandbox: Sandbox): SandboxHandle {
  return {
    sandboxId: sandbox.name,
    get timeout() {
      return sandbox.timeout ?? 0;
    },
    get status() {
      return sandbox.status;
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
          stdout: commandOrOpts.stdout,
          stderr: commandOrOpts.stderr,
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
    async stop(options) {
      await sandbox.stop(options);
    },
    async delete(options) {
      await sandbox.delete(options);
    },
    async extendTimeout(duration) {
      await sandbox.extendTimeout(duration);
    },
    async updateNetworkPolicy(policy) {
      await sandbox.update({ networkPolicy: policy });
      return policy;
    },
    async runDetachedCommand(options) {
      const cmd = await sandbox.runCommand({
        cmd: options.cmd,
        args: options.args ?? [],
        env: options.env,
        detached: true,
      });
      return { cmdId: (cmd as unknown as { cmdId: string }).cmdId };
    },
    async getCommand(cmdId) {
      const cmd = await sandbox.getCommand(cmdId);
      return {
        async kill(signal?: string) {
          await cmd.kill(signal as Parameters<typeof cmd.kill>[0]);
        },
      };
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
    const sandbox = await SandboxClass.get({ name: params.sandboxId, resume: params.resume });
    return wrapSandbox(sandbox);
  },
};

// ---------------------------------------------------------------------------
// Module-level singleton with test override
// ---------------------------------------------------------------------------

const SANDBOX_CONTROLLER_TEST_GUARD_ERROR =
  "Sandbox controller not initialized for testing. Call _setSandboxControllerForTesting() first.";

let activeController: SandboxController | null = null;

export function getSandboxController(): SandboxController {
  if (process.env.NODE_ENV === "test") {
    if (activeController) {
      return activeController;
    }

    throw new Error(SANDBOX_CONTROLLER_TEST_GUARD_ERROR);
  }

  return realController;
}

export function _setSandboxControllerForTesting(
  controller: SandboxController | null,
): void {
  if (process.env.NODE_ENV !== "test" && controller !== null) {
    throw new Error("test-only helper called outside tests");
  }

  activeController = controller;
}
