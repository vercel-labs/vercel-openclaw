import { buildAuthorizeResponse } from "@/server/auth/vercel-auth";

export async function GET(request: Request): Promise<Response> {
  return buildAuthorizeResponse(request);
}
