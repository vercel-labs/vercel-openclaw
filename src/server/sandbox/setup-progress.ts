import { Writable } from "node:stream";

import { setupProgressKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

export type SetupPhase =
  | "creating-sandbox"
  | "resuming-sandbox"
  | "downloading-bundle"
  | "installing-openclaw"
  | "installing-bun"
  | "cleaning-cache"
  | "installing-peer-deps"
  | "patching-openclaw"
  | "installing-plugin"
  | "writing-config"
  | "checking-version"
  | "starting-gateway"
  | "waiting-for-gateway"
  | "pairing-device"
  | "applying-firewall"
  | "ready"
  | "failed";

export type SetupProgressLine = {
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
};

export type SetupProgress = {
  attemptId: string;
  active: boolean;
  phase: SetupPhase;
  phaseLabel: string;
  startedAt: number;
  updatedAt: number;
  preview: string | null;
  lines: SetupProgressLine[];
};

const MAX_LINES = 40;
const MAX_LINE_LENGTH = 220;
const FLUSH_INTERVAL_MS = 350;
const TTL_SECONDS = 30 * 60;
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

const PHASE_LABELS: Record<SetupPhase, string> = {
  "creating-sandbox": "Creating sandbox",
  "resuming-sandbox": "Resuming sandbox",
  "downloading-bundle": "Downloading bundle",
  "installing-openclaw": "Installing OpenClaw",
  "installing-bun": "Installing Bun",
  "cleaning-cache": "Cleaning cache",
  "installing-peer-deps": "Installing peer dependencies",
  "patching-openclaw": "Patching OpenClaw",
  "installing-plugin": "Installing plugin",
  "writing-config": "Writing config",
  "checking-version": "Checking version",
  "starting-gateway": "Starting gateway",
  "waiting-for-gateway": "Waiting for gateway",
  "pairing-device": "Pairing device",
  "applying-firewall": "Applying firewall",
  ready: "Ready",
  failed: "Failed",
};

function timestamp(): number {
  return Date.now();
}

function cloneProgress(progress: SetupProgress): SetupProgress {
  return {
    ...progress,
    lines: progress.lines.map((line) => ({ ...line })),
  };
}

function sanitizeLine(text: string): string | null {
  const stripped = text
    .replace(ANSI_PATTERN, "")
    .replace(/\r/g, "")
    .replace(
      /(gatewayToken|apiKey|signingSecret|webhookSecret)(["'=:\s]+)([^"\s,]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[redacted]")
    .trim();

  if (!stripped) {
    return null;
  }

  return stripped.length <= MAX_LINE_LENGTH
    ? stripped
    : `${stripped.slice(0, MAX_LINE_LENGTH - 1)}…`;
}

function appendBoundedLine(
  lines: SetupProgressLine[],
  line: SetupProgressLine,
): SetupProgressLine[] {
  const next = [...lines, line];
  return next.length <= MAX_LINES ? next : next.slice(next.length - MAX_LINES);
}

function buildProgress(
  progress: SetupProgress,
  update: Partial<SetupProgress>,
): SetupProgress {
  return {
    ...progress,
    ...update,
    updatedAt: timestamp(),
  };
}

export async function beginSetupProgress(options: {
  attemptId: string;
  instanceId?: string;
  phase?: SetupPhase;
}): Promise<SetupProgress> {
  const startedAt = timestamp();
  const phase = options.phase ?? "creating-sandbox";
  const progress: SetupProgress = {
    attemptId: options.attemptId,
    active: true,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    startedAt,
    updatedAt: startedAt,
    preview: null,
    lines: [],
  };

  await getStore().setValue(setupProgressKey(options.instanceId), progress, TTL_SECONDS);
  return cloneProgress(progress);
}

export async function readSetupProgress(
  instanceId = "openclaw-single",
  attemptId?: string | null,
): Promise<SetupProgress | null> {
  const progress = await getStore().getValue<SetupProgress>(setupProgressKey(instanceId));
  if (!progress) {
    return null;
  }
  if (attemptId && progress.attemptId !== attemptId) {
    return null;
  }
  return cloneProgress(progress);
}

export async function clearSetupProgress(instanceId = "openclaw-single"): Promise<void> {
  await getStore().deleteValue(setupProgressKey(instanceId));
}

export class SetupProgressWriter {
  private progress: SetupProgress;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly key: string;
  private readonly partials = new Map<"stdout" | "stderr", string>();

  constructor(progress: SetupProgress, instanceId = "openclaw-single") {
    this.progress = cloneProgress(progress);
    this.key = setupProgressKey(instanceId);
  }

  setPhase(phase: SetupPhase, preview?: string | null): void {
    this.progress = buildProgress(this.progress, {
      phase,
      phaseLabel: PHASE_LABELS[phase],
      preview: preview === undefined ? this.progress.preview : preview,
    });
    this.scheduleFlush();
  }

  setPreview(preview: string | null): void {
    this.progress = buildProgress(this.progress, { preview });
    this.scheduleFlush();
  }

  appendLine(stream: "stdout" | "stderr" | "system", text: string): void {
    let next = this.progress;
    for (const rawLine of text.split("\n")) {
      const normalized = sanitizeLine(rawLine);
      if (!normalized) {
        continue;
      }
      next = buildProgress(next, {
        preview: normalized,
        lines: appendBoundedLine(next.lines, {
          ts: timestamp(),
          stream,
          text: normalized,
        }),
      });
    }
    this.progress = next;
    this.scheduleFlush();
  }

  makeWritable(stream: "stdout" | "stderr"): Writable {
    return new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          this.consumeChunk(stream, value);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
      final: (callback) => {
        try {
          this.flushPartial(stream);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  async completeSetupProgress(preview = "Sandbox ready"): Promise<void> {
    this.flushPartials();
    this.progress = buildProgress(this.progress, {
      active: false,
      phase: "ready",
      phaseLabel: PHASE_LABELS.ready,
      preview,
    });
    await this.flushNow();
  }

  async failSetupProgress(error: string): Promise<void> {
    this.flushPartials();
    const normalized = sanitizeLine(error);
    this.progress = buildProgress(this.progress, {
      active: false,
      phase: "failed",
      phaseLabel: PHASE_LABELS.failed,
      preview: normalized ?? "Setup failed",
      lines: normalized
        ? appendBoundedLine(this.progress.lines, {
            ts: timestamp(),
            stream: "system",
            text: normalized,
          })
        : this.progress.lines,
    });
    await this.flushNow();
  }

  private consumeChunk(stream: "stdout" | "stderr", chunk: string): void {
    const combined = `${this.partials.get(stream) ?? ""}${chunk}`;
    const lines = combined.split("\n");
    const tail = lines.pop() ?? "";
    this.partials.set(stream, tail);
    for (const line of lines) {
      this.appendLine(stream, line);
    }
  }

  private flushPartial(stream: "stdout" | "stderr"): void {
    const tail = this.partials.get(stream);
    if (!tail) {
      return;
    }
    this.partials.delete(stream);
    this.appendLine(stream, tail);
  }

  private flushPartials(): void {
    this.flushPartial("stdout");
    this.flushPartial("stderr");
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_INTERVAL_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }

    const snapshot = cloneProgress(this.progress);
    this.flushPromise = getStore().setValue(this.key, snapshot, TTL_SECONDS);
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }
}
