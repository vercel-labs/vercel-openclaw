import { ApiError, jsonError, jsonOk } from "@/shared/http";
import { drainDiscordQueue } from "@/server/channels/discord/runtime";
import { drainSlackQueue } from "@/server/channels/slack/runtime";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { getCronSecret } from "@/server/env";

function isAuthorized(request: Request): boolean {
  const configured = getCronSecret();
  if (!configured) {
    return process.env.NODE_ENV !== "production";
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const headerSecret = request.headers.get("x-cron-secret")?.trim() ?? "";
  return bearer === configured || headerSecret === configured;
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return jsonError(new ApiError(401, "UNAUTHORIZED", "Unauthorized"));
  }

  const results = await Promise.allSettled([
    drainSlackQueue(),
    drainTelegramQueue(),
    drainDiscordQueue(),
  ]);

  return jsonOk({
    ok: results.every((result) => result.status === "fulfilled"),
    results: {
      slack: results[0]?.status ?? "rejected",
      telegram: results[1]?.status ?? "rejected",
      discord: results[2]?.status ?? "rejected",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
