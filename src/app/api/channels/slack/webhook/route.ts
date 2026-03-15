import { after } from "next/server";

import { getPublicOrigin } from "@/server/public-url";
import { enqueueChannelJob } from "@/server/channels/driver";
import { channelDedupKey } from "@/server/channels/keys";
import {
  drainSlackQueue,
} from "@/server/channels/slack/runtime";
import {
  getSlackUrlVerificationChallenge,
  isValidSlackSignature,
} from "@/server/channels/slack/adapter";
import { getInitializedMeta, getStore } from "@/server/store/store";

function unauthorizedResponse() {
  return Response.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

function extractSlackDedupId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as {
    event_id?: unknown;
    event?: { channel?: unknown; ts?: unknown };
  };
  if (typeof raw.event_id === "string" && raw.event_id.length > 0) {
    return raw.event_id;
  }

  if (
    typeof raw.event?.channel === "string" &&
    typeof raw.event?.ts === "string"
  ) {
    return `${raw.event.channel}:${raw.event.ts}`;
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text().catch(() => "");
  const signatureHeader = request.headers.get("x-slack-signature");
  const timestampHeader = request.headers.get("x-slack-request-timestamp");

  if (!signatureHeader || !timestampHeader) {
    return unauthorizedResponse();
  }

  const meta = await getInitializedMeta();
  const config = meta.channels.slack;
  if (!config) {
    return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  }

  const signatureValid = isValidSlackSignature({
    signingSecret: config.signingSecret,
    signatureHeader,
    timestampHeader,
    rawBody,
  });
  if (!signatureValid) {
    return unauthorizedResponse();
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    return Response.json({ ok: true });
  }

  const challenge = getSlackUrlVerificationChallenge(payload);
  if (challenge !== null) {
    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const dedupId = extractSlackDedupId(payload);
  if (dedupId) {
    const accepted = await getStore().acquireLock(channelDedupKey("slack", dedupId), 24 * 60 * 60);
    if (!accepted) {
      return Response.json({ ok: true });
    }
  }

  await enqueueChannelJob("slack", {
    payload,
    receivedAt: Date.now(),
    origin: getPublicOrigin(request),
  });

  after(async () => {
    await drainSlackQueue();
  });

  return Response.json({ ok: true });
}
