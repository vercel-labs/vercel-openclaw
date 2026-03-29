import type { SandboxHandle } from "@/server/sandbox/controller";
import { getSandboxController } from "@/server/sandbox/controller";
import { MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS } from "@/server/sandbox/timeout";
import type {
  WorkerSandboxExecuteRequest,
  WorkerSandboxExecuteResponse,
  WorkerSandboxVcpus,
} from "@/shared/worker-sandbox";

const DEFAULT_CHILD_SANDBOX_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_VCPUS: readonly WorkerSandboxVcpus[] = [1, 2, 4, 8];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspacePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/workspace/");
}

export function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) {
    return DEFAULT_CHILD_SANDBOX_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_PORTABLE_SANDBOX_SLEEP_AFTER_MS);
}

export function validateExecuteRequest(body: unknown): { ok: true; value: WorkerSandboxExecuteRequest } | {
  ok: false;
  message: string;
} {
  if (!isRecord(body)) {
    return { ok: false, message: "Body must be a JSON object." };
  }

  if (typeof body.task !== "string" || body.task.trim() === "") {
    return { ok: false, message: "`task` must be a non-empty string." };
  }

  if (!isRecord(body.command) || typeof body.command.cmd !== "string" || body.command.cmd.trim() === "") {
    return { ok: false, message: "`command.cmd` must be a non-empty string." };
  }

  if (
    body.command.args !== undefined &&
    (!Array.isArray(body.command.args) || body.command.args.some((arg) => typeof arg !== "string"))
  ) {
    return { ok: false, message: "`command.args` must be an array of strings." };
  }

  if (
    body.command.env !== undefined &&
    (!isRecord(body.command.env) || Object.values(body.command.env).some((value) => typeof value !== "string"))
  ) {
    return { ok: false, message: "`command.env` must be a string map." };
  }

  if (
    body.files !== undefined &&
    (!Array.isArray(body.files) ||
      body.files.some(
        (file) =>
          !isRecord(file) ||
          !isWorkspacePath(file.path) ||
          typeof file.contentBase64 !== "string",
      ))
  ) {
    return {
      ok: false,
      message: "`files` must contain `/workspace/` paths and base64 content.",
    };
  }

  if (
    body.capturePaths !== undefined &&
    (!Array.isArray(body.capturePaths) || body.capturePaths.some((path) => !isWorkspacePath(path)))
  ) {
    return { ok: false, message: "`capturePaths` must contain only `/workspace/` paths." };
  }

  if (
    body.vcpus !== undefined &&
    (!Number.isInteger(body.vcpus) || !ALLOWED_VCPUS.includes(body.vcpus as WorkerSandboxVcpus))
  ) {
    return { ok: false, message: "`vcpus` must be one of 1, 2, 4, or 8." };
  }

  if (
    body.sandboxTimeoutMs !== undefined &&
    (!Number.isFinite(body.sandboxTimeoutMs) || (body.sandboxTimeoutMs as number) <= 0)
  ) {
    return { ok: false, message: "`sandboxTimeoutMs` must be a positive number." };
  }

  return { ok: true, value: body as WorkerSandboxExecuteRequest };
}

// ---------------------------------------------------------------------------
// AI Gateway env injection
// ---------------------------------------------------------------------------

export type ExecuteWorkerSandboxOptions = {
  aiGatewayApiKey?: string;
};

function buildChildCommandEnv(
  requestEnv: Record<string, string> | undefined,
  aiGatewayApiKey?: string,
): Record<string, string> | undefined {
  const env: Record<string, string> = { ...(requestEnv ?? {}) };
  if (aiGatewayApiKey) {
    env.AI_GATEWAY_API_KEY = aiGatewayApiKey;
    env.OPENAI_API_KEY = aiGatewayApiKey;
    env.OPENAI_BASE_URL = "https://ai-gateway.vercel.sh/v1";
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

export async function executeWorkerSandbox(
  request: WorkerSandboxExecuteRequest,
  options: ExecuteWorkerSandboxOptions = {},
): Promise<WorkerSandboxExecuteResponse> {
  let sandbox: SandboxHandle | null = null;

  try {
    sandbox = await getSandboxController().create({
      timeout: clampTimeoutMs(request.sandboxTimeoutMs),
      resources: { vcpus: request.vcpus ?? 1 },
    });

    if (request.files?.length) {
      await sandbox.writeFiles(
        request.files.map((file) => ({
          path: file.path,
          content: Buffer.from(file.contentBase64, "base64"),
        })),
      );
    }

    const commandEnv = buildChildCommandEnv(request.command.env, options.aiGatewayApiKey);

    const result = await sandbox.runCommand({
      cmd: request.command.cmd,
      args: request.command.args ?? [],
      env: commandEnv,
    });

    const stdout = await result.output("stdout");
    const stderr = await result.output("stderr");

    const capturedFiles: WorkerSandboxExecuteResponse["capturedFiles"] = [];
    for (const path of request.capturePaths ?? []) {
      const buffer = await sandbox.readFileToBuffer({ path });
      if (buffer) {
        capturedFiles.push({
          path,
          contentBase64: buffer.toString("base64"),
        });
      }
    }

    return {
      ok: result.exitCode === 0,
      task: request.task,
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      stdout,
      stderr,
      capturedFiles,
    };
  } catch (error) {
    return {
      ok: false,
      task: request.task,
      sandboxId: sandbox?.sandboxId ?? null,
      exitCode: null,
      stdout: "",
      stderr: "",
      capturedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await sandbox?.stop({ blocking: true }).catch(() => undefined);
  }
}
