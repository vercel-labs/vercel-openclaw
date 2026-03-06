import { buildSignoutResponse } from "@/server/auth/vercel-auth";

export async function GET(request: Request): Promise<Response> {
  return buildSignoutResponse(request);
}
