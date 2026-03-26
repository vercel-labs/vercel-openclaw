/**
 * Fake sandbox controller and handle for scenario tests.
 *
 * Extracted from harness.ts so tests that only need the controller
 * can import it directly without pulling in the full harness.
 */

import type { NetworkPolicy } from "@vercel/sandbox";

import type {
  CommandResult,
  CreateParams,
  RunCommandOptions,
  SandboxController,
  SandboxHandle,
  SandboxStatus,
  SnapshotResult,
} from "@/server/sandbox/controller";
import {
  OPENCLAW_FAST_RESTORE_SCRIPT_PATH,
} from "@/server/openclaw/config";

// ---------------------------------------------------------------------------
// Event log types
// ---------------------------------------------------------------------------

export type SandboxEventKind =
  | "create"
  | "snapshot"
  | "restore"
  | "stop"
  | "command"
  | "write_files"
  | "extend_timeout"
  | "update_network_policy";

export type SandboxEvent = {
  kind: SandboxEventKind;
  sandboxId: string;
  timestamp: number;
  detail?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// FakeSandboxHandle
// ---------------------------------------------------------------------------

/**
 * A scripted response for `runCommand`.
 * Return `undefined` from the callback to fall through to the default behaviour.
 */
export type CommandResponder = (
  command: string,
  args?: string[],
) => CommandResult | undefined;

export class FakeSandboxHandle implements SandboxHandle {
  sandboxId: string;
  commands: Array<{ cmd: string; args?: string[]; env?: Record<string, string> }> = [];
  writtenFiles: Array<{ path: string; content: Buffer }> = [];
  networkPolicies: NetworkPolicy[] = [];
  extendedTimeouts: number[] = [];
  snapshotCalled = false;
  stopCalled = false;
  createTimeNetworkPolicy?: import("@vercel/sandbox").NetworkPolicy;
  private portDomain: string;
  private eventLog: SandboxEvent[];

  /**
   * Optional responders checked in order for each `runCommand` call.
   * The first one that returns a non-undefined value wins.
   */
  responders: CommandResponder[] = [];

  /** Optional hook called before writeFiles completes.  Throw to simulate failure. */
  writeFilesHook?: (files: { path: string; content: Buffer }[]) => void;

  /** Optional hook to override `updateNetworkPolicy` behavior (e.g. to simulate failure). */
  networkPolicyHandler?: (policy: NetworkPolicy) => Promise<NetworkPolicy> | NetworkPolicy;

  private timeoutMs: number;
  private _status: SandboxStatus;

  constructor(sandboxId: string, eventLog: SandboxEvent[], timeoutMs = 5 * 60 * 1000) {
    this.sandboxId = sandboxId;
    this.portDomain = `https://${sandboxId}`;
    this.eventLog = eventLog;
    this.timeoutMs = timeoutMs;
    this._status = "running";
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  /** Override the sandbox status (e.g. to simulate platform timeout). */
  setStatus(status: SandboxStatus): void {
    this._status = status;
  }

  async runCommand(
    commandOrOpts: string | RunCommandOptions,
    args?: string[],
    _opts?: { signal?: AbortSignal },
  ): Promise<CommandResult> {
    const cmd = typeof commandOrOpts === "string" ? commandOrOpts : commandOrOpts.cmd;
    const cmdArgs = typeof commandOrOpts === "string" ? args : commandOrOpts.args;
    const cmdEnv = typeof commandOrOpts === "object" ? commandOrOpts.env : undefined;
    this.commands.push({ cmd, args: cmdArgs, env: cmdEnv });
    this.eventLog.push({
      kind: "command",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { command: cmd, args: cmdArgs },
    });

    // Check scripted responders first
    for (const responder of this.responders) {
      const result = responder(cmd, cmdArgs);
      if (result !== undefined) {
        return result;
      }
    }

    // Default: fast-restore script with stream-aware output
    if (cmd === "bash" && cmdArgs?.[0] === OPENCLAW_FAST_RESTORE_SCRIPT_PATH) {
      const stdoutJson = '{"ready":true,"attempts":3,"readyMs":150}';
      const stderrEvents = '{"event":"fast_restore.complete"}';
      return {
        exitCode: 0,
        output: async (stream?: "stdout" | "stderr" | "both") => {
          if (stream === "stdout") return stdoutJson;
          if (stream === "stderr") return stderrEvents;
          return `${stdoutJson}\n${stderrEvents}`;
        },
      };
    }
    // Default: recognize the curl readiness probe used by waitForGatewayReady
    if (
      cmd === "curl" &&
      cmdArgs?.some((a) => a.includes("localhost:3000"))
    ) {
      return {
        exitCode: 0,
        output: async () =>
          '<html><body><div id="openclaw-app">ready</div></body></html>',
      };
    }
    return { exitCode: 0, output: async () => "" };
  }

  async writeFiles(files: { path: string; content: Buffer }[]): Promise<void> {
    if (this.writeFilesHook) {
      this.writeFilesHook(files);
    }
    this.writtenFiles.push(...files);
    this.eventLog.push({
      kind: "write_files",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { paths: files.map((f) => f.path) },
    });
  }

  async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
    for (let i = this.writtenFiles.length - 1; i >= 0; i--) {
      if (this.writtenFiles[i].path === file.path) {
        return this.writtenFiles[i].content;
      }
    }
    return null;
  }

  domain(port: number): string {
    return `${this.portDomain}-${port}.fake.vercel.run`;
  }

  async snapshot(): Promise<SnapshotResult> {
    this.snapshotCalled = true;
    this.eventLog.push({
      kind: "snapshot",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
    });
    return { snapshotId: `snap-${this.sandboxId}` };
  }

  async stop(_options?: { blocking?: boolean }): Promise<void> {
    this.stopCalled = true;
    this._status = "stopped";
    this.eventLog.push({
      kind: "stop",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
    });
  }

  async extendTimeout(duration: number): Promise<void> {
    this.timeoutMs += duration;
    this.extendedTimeouts.push(duration);
    this.eventLog.push({
      kind: "extend_timeout",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { duration, timeoutMs: this.timeoutMs },
    });
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<NetworkPolicy> {
    this.networkPolicies.push(policy);
    this.eventLog.push({
      kind: "update_network_policy",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { policy },
    });
    if (this.networkPolicyHandler) {
      return await this.networkPolicyHandler(policy);
    }
    return policy;
  }
}

// ---------------------------------------------------------------------------
// FakeSandboxController
// ---------------------------------------------------------------------------

export class FakeSandboxController implements SandboxController {
  created: FakeSandboxHandle[] = [];
  retrieved: string[] = [];
  handlesByIds = new Map<string, FakeSandboxHandle>();

  /** Ordered event log shared across all handles. */
  events: SandboxEvent[] = [];

  /** Default responders copied to every handle created by `create()`. */
  defaultResponders: CommandResponder[] = [];

  /** Optional hook called before writeFiles completes.  Throw to simulate failure. */
  onWriteFiles?: (files: { path: string; content: Buffer }[]) => void;

  /** Optional hook to override `updateNetworkPolicy` on newly created handles. */
  onNetworkPolicy?: (policy: NetworkPolicy) => Promise<NetworkPolicy> | NetworkPolicy;

  private counter = 0;
  private delay: number;
  private _createFailure: Error | null = null;

  constructor(options?: { delay?: number }) {
    this.delay = options?.delay ?? 0;
  }

  /** Make the next `create()` call throw (one-shot: resets after firing). */
  setCreateFailure(error: Error | null): void {
    this._createFailure = error;
  }

  async create(params: CreateParams): Promise<SandboxHandle> {
    if (this._createFailure) {
      const err = this._createFailure;
      this._createFailure = null;
      throw err;
    }
    if (this.delay > 0) {
      await sleep(this.delay);
    }
    this.counter += 1;
    const id = `sbx-fake-${this.counter}`;
    const isRestore = params.source?.type === "snapshot";
    const handle = new FakeSandboxHandle(id, this.events, params.timeout);
    handle.responders.push(...this.defaultResponders);
    if (params.networkPolicy) {
      handle.createTimeNetworkPolicy = params.networkPolicy;
    }
    if (this.onWriteFiles) {
      handle.writeFilesHook = this.onWriteFiles;
    }
    if (this.onNetworkPolicy) {
      handle.networkPolicyHandler = this.onNetworkPolicy;
    }
    this.created.push(handle);
    this.handlesByIds.set(id, handle);
    this.events.push({
      kind: isRestore ? "restore" : "create",
      sandboxId: id,
      timestamp: Date.now(),
      detail: isRestore ? { snapshotId: params.source!.snapshotId } : undefined,
    });
    return handle;
  }

  async get(params: { sandboxId: string }): Promise<SandboxHandle> {
    this.retrieved.push(params.sandboxId);
    const existing = this.handlesByIds.get(params.sandboxId);
    if (existing) {
      return existing;
    }
    const handle = new FakeSandboxHandle(params.sandboxId, this.events);
    this.handlesByIds.set(params.sandboxId, handle);
    return handle;
  }

  /** Get a handle by sandbox ID (returns undefined if not tracked). */
  getHandle(sandboxId: string): FakeSandboxHandle | undefined {
    return this.handlesByIds.get(sandboxId);
  }

  /** Get the most recently created handle. */
  lastCreated(): FakeSandboxHandle | undefined {
    return this.created[this.created.length - 1];
  }

  /** Filter events by kind. */
  eventsOfKind(kind: SandboxEventKind): SandboxEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
