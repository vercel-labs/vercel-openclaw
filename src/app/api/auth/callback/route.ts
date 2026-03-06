import { jsonError } from "@/shared/http";
import { buildCallbackResponse } from "@/server/auth/vercel-auth";

export async function GET(request: Request): Promise<Response> {
  try {
    return await buildCallbackResponse(request);
  } catch (error) {
    return jsonError(error);
  }
}
