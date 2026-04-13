import { connection } from "next/server";

import { jsonError } from "@/shared/http";
import { buildCallbackResponse } from "@/server/auth/vercel-auth";

export async function GET(request: Request): Promise<Response> {
  try {
    await connection();
    return await buildCallbackResponse(request);
  } catch (error) {
    return jsonError(error);
  }
}
