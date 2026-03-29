import { authorizeWorkerSandboxRequest } from "@/server/worker-sandboxes/auth";
import {
  executeWorkerSandbox,
  validateExecuteRequest,
} from "@/server/worker-sandboxes/execute";

export const maxDuration = 300;

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

  const validation = validateExecuteRequest(parsedBody);
  if (!validation.ok) {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: validation.message,
        },
      },
      { status: 400 },
    );
  }

  const result = await executeWorkerSandbox(validation.value);
  return Response.json(result, { status: result.error ? 500 : 200 });
}
