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
