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
  SandboxController,
  SandboxHandle,
  SnapshotResult,
} from "@/server/sandbox/controller";

// ---------------------------------------------------------------------------
// Event log types
// ---------------------------------------------------------------------------

export type SandboxEventKind =
  | "create"
  | "snapshot"
  | "restore"
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
  commands: Array<{ cmd: string; args?: string[] }> = [];
  writtenFiles: Array<{ path: string; content: Buffer }> = [];
  networkPolicies: NetworkPolicy[] = [];
  extendedTimeouts: number[] = [];
  snapshotCalled = false;
  private portDomain: string;
  private eventLog: SandboxEvent[];

  /**
   * Optional responders checked in order for each `runCommand` call.
   * The first one that returns a non-undefined value wins.
   */
  responders: CommandResponder[] = [];

  constructor(sandboxId: string, eventLog: SandboxEvent[]) {
    this.sandboxId = sandboxId;
    this.portDomain = `https://${sandboxId}`;
    this.eventLog = eventLog;
  }

  async runCommand(command: string, args?: string[]): Promise<CommandResult> {
    this.commands.push({ cmd: command, args });
    this.eventLog.push({
      kind: "command",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { command, args },
    });

    // Check scripted responders first
    for (const responder of this.responders) {
      const result = responder(command, args);
      if (result !== undefined) {
        return result;
      }
    }

    // Default: recognize the curl readiness probe used by waitForGatewayReady
    if (
      command === "curl" &&
      args?.some((a) => a.includes("localhost:3000"))
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
    this.writtenFiles.push(...files);
    this.eventLog.push({
      kind: "write_files",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { paths: files.map((f) => f.path) },
    });
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

  async extendTimeout(duration: number): Promise<void> {
    this.extendedTimeouts.push(duration);
    this.eventLog.push({
      kind: "extend_timeout",
      sandboxId: this.sandboxId,
      timestamp: Date.now(),
      detail: { duration },
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
    const handle = new FakeSandboxHandle(id, this.events);
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
