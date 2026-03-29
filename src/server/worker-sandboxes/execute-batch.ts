import { getAiGatewayBearerTokenOptional } from "@/server/env";
import type {
  WorkerSandboxBatchExecuteRequest,
  WorkerSandboxBatchExecuteResponse,
  WorkerSandboxBatchJobResult,
} from "@/shared/worker-sandbox";
import { executeWorkerSandbox } from "@/server/worker-sandboxes/execute";

const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_BATCH_CONCURRENCY = 4;

export function clampBatchConcurrency(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.min(value, MAX_BATCH_CONCURRENCY);
}

function buildBatchConfigErrorResult(
  request: WorkerSandboxBatchExecuteRequest,
  message: string,
): WorkerSandboxBatchExecuteResponse {
  const results: WorkerSandboxBatchJobResult[] = request.jobs.map((job) => ({
    id: job.id,
    result: {
      ok: false,
      task: job.request.task,
      sandboxId: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      capturedFiles: [],
      error: message,
    },
  }));
  return {
    ok: false,
    task: request.task,
    totalJobs: request.jobs.length,
    succeeded: 0,
    failed: results.length,
    results,
  };
}

export async function executeWorkerSandboxBatch(
  request: WorkerSandboxBatchExecuteRequest,
): Promise<WorkerSandboxBatchExecuteResponse> {
  const maxConcurrency = clampBatchConcurrency(request.maxConcurrency);
  const queue = [...request.jobs];
  const results: WorkerSandboxBatchJobResult[] = [];
  let failed = 0;

  const aiGatewayApiKey = request.passAiGatewayKey
    ? await getAiGatewayBearerTokenOptional()
    : undefined;

  if (request.passAiGatewayKey && !aiGatewayApiKey) {
    return buildBatchConfigErrorResult(
      request,
      "AI Gateway credential unavailable on host. Set AI_GATEWAY_API_KEY or enable Vercel OIDC before using passAiGatewayKey=true.",
    );
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, queue.length) },
    async () => {
      while (queue.length > 0) {
        if (!request.continueOnError && failed > 0) {
          return;
        }
        const job = queue.shift();
        if (!job) {
          return;
        }
        const result = await executeWorkerSandbox(job.request, {
          aiGatewayApiKey,
        });
        results.push({ id: job.id, result });
        if (!result.ok) {
          failed += 1;
        }
      }
    },
  );

  await Promise.all(workers);

  const succeeded = results.filter((entry) => entry.result.ok).length;

  return {
    ok: failed === 0,
    task: request.task,
    totalJobs: request.jobs.length,
    succeeded,
    failed,
    results,
  };
}
