import { after } from "next/server";

import { getBaseOrigin } from "@/server/env";
import { enqueueChannelJob } from "@/server/channels/driver";
import { channelDedupKey } from "@/server/channels/keys";
import { drainTelegramQueue } from "@/server/channels/telegram/runtime";
import { isTelegramWebhookSecretValid } from "@/server/channels/telegram/adapter";
import { getInitializedMeta, getStore } from "@/server/store/store";

function extractUpdateId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as { update_id?: unknown };
  if (typeof raw.update_id === "number") {
    return String(raw.update_id);
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const meta = await getInitializedMeta();
  const config = meta.channels.telegram;
  if (!config) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secretHeader || !isTelegramWebhookSecretValid(config, secretHeader)) {
    return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: true });
  }

  const updateId = extractUpdateId(payload);
  if (updateId) {
    const accepted = await getStore().acquireLock(channelDedupKey("telegram", updateId), 24 * 60 * 60);
    if (!accepted) {
      return Response.json({ ok: true });
    }
  }

  await enqueueChannelJob("telegram", {
    payload,
    receivedAt: Date.now(),
    origin: getBaseOrigin(request),
  });

  after(async () => {
    await drainTelegramQueue();
  });

  return Response.json({ ok: true });
}
