import type { ChannelName } from "@/shared/channels";

const PREFIX = "openclaw-single";

export function channelQueueKey(channel: ChannelName): string {
  return `${PREFIX}:channels:${channel}:queue`;
}

export function channelProcessingKey(channel: ChannelName): string {
  return `${PREFIX}:channels:${channel}:processing`;
}

export function channelDeadLetterKey(channel: ChannelName): string {
  return `${PREFIX}:channels:${channel}:deadletter`;
}

export function channelDrainLockKey(channel: ChannelName): string {
  return `${PREFIX}:channels:${channel}:drain-lock`;
}

export function channelSessionHistoryKey(
  channel: ChannelName,
  sessionKey: string,
): string {
  return `${PREFIX}:channels:${channel}:history:${sessionKey}`;
}

export function channelDedupKey(channel: ChannelName, dedupId: string): string {
  return `${PREFIX}:channels:${channel}:dedup:${dedupId}`;
}
