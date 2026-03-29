import { authorizeWorkerSandboxRequest } from "@/server/worker-sandboxes/auth";
import { validateExecuteRequest } from "@/server/worker-sandboxes/execute";
import { executeWorkerSandboxBatch } from "@/server/worker-sandboxes/execute-batch";
import type { WorkerSandboxBatchExecuteRequest } from "@/shared/worker-sandbox";

export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBatchExecuteRequest(
  body: unknown,
): { ok: true; value: WorkerSandboxBatchExecuteRequest } | { ok: false; message: string } {
  if (!isRecord(body)) {
    return { ok: false, message: "Body must be a JSON object." };
  }

  if (typeof body.task !== "string" || body.task.trim() === "") {
    return { ok: false, message: "`task` must be a non-empty string." };
  }

  if (!Array.isArray(body.jobs) || body.jobs.length === 0) {
    return { ok: false, message: "`jobs` must be a non-empty array." };
  }

  const seenJobIds = new Set<string>();
  const jobs: WorkerSandboxBatchExecuteRequest["jobs"] = [];

  for (const rawJob of body.jobs) {
    if (
      !isRecord(rawJob) ||
      typeof rawJob.id !== "string" ||
      (rawJob.id as string).trim() === "" ||
      !isRecord(rawJob.request)
    ) {
      return { ok: false, message: "Each job must have `id` and `request`." };
    }

    const id = (rawJob.id as string).trim();
    if (seenJobIds.has(id)) {
      return {
        ok: false,
        message: `Job ids must be unique. Duplicate id "${id}".`,
      };
    }
    seenJobIds.add(id);

    const requestValidation = validateExecuteRequest(rawJob.request);
    if (!requestValidation.ok) {
      return {
        ok: false,
        message: `Job "${id}" has invalid request: ${requestValidation.message}`,
      };
    }

    jobs.push({ id, request: requestValidation.value });
  }

  if (
    body.maxConcurrency !== undefined &&
    (!Number.isInteger(body.maxConcurrency) || (body.maxConcurrency as number) <= 0)
  ) {
    return { ok: false, message: "`maxConcurrency` must be a positive integer." };
  }

  if (
    body.continueOnError !== undefined &&
    typeof body.continueOnError !== "boolean"
  ) {
    return { ok: false, message: "`continueOnError` must be boolean." };
  }

  if (
    body.passAiGatewayKey !== undefined &&
    typeof body.passAiGatewayKey !== "boolean"
  ) {
    return { ok: false, message: "`passAiGatewayKey` must be boolean." };
  }

  return {
    ok: true,
    value: {
      task: (body.task as string).trim(),
      jobs,
      maxConcurrency: body.maxConcurrency as number | undefined,
      continueOnError: body.continueOnError as boolean | undefined,
      passAiGatewayKey: body.passAiGatewayKey as boolean | undefined,
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!(await authorizeWorkerSandboxRequest(request))) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid worker sandbox token." } },
      { status: 401 },
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Body must be valid JSON." } },
      { status: 400 },
    );
  }

  const validation = validateBatchExecuteRequest(parsedBody);
  if (!validation.ok) {
    return Response.json(
      { error: { code: "INVALID_REQUEST", message: validation.message } },
      { status: 400 },
    );
  }

  const response = await executeWorkerSandboxBatch(validation.value);
  return Response.json(response, { status: 200 });
}
