import type { ChannelName } from "@/shared/channels";
import type { OpenClawMessage } from "@/server/channels/core/types";
import { channelSessionHistoryKey } from "@/server/channels/keys";
import { getStore } from "@/server/store/store";

const SESSION_HISTORY_MAX_ENTRIES = 20;
const SESSION_HISTORY_TTL_SECONDS = 24 * 60 * 60;

export async function readSessionHistory(
  channel: ChannelName,
  sessionKey: string,
): Promise<OpenClawMessage[]> {
  const store = getStore();
  const key = channelSessionHistoryKey(channel, sessionKey);
  const entries = await store.getValue<OpenClawMessage[]>(key);
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.filter(
    (entry): entry is OpenClawMessage =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { role?: unknown }).role !== undefined &&
      (entry as { content?: unknown }).content !== undefined &&
      (((entry as { role?: unknown }).role === "user") ||
        ((entry as { role?: unknown }).role === "assistant")) &&
      typeof (entry as { content?: unknown }).content === "string",
  );
}

export async function appendSessionHistory(
  channel: ChannelName,
  sessionKey: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  const store = getStore();
  const key = channelSessionHistoryKey(channel, sessionKey);
  const current = await readSessionHistory(channel, sessionKey);
  const next = current.concat(
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantMessage },
  );
  const trimmed = next.slice(-SESSION_HISTORY_MAX_ENTRIES);
  await store.setValue(key, trimmed, SESSION_HISTORY_TTL_SECONDS);
}
