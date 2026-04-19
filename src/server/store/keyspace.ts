import type { ChannelName } from "@/shared/channels";
import { getOpenclawInstanceId } from "@/server/env";
import { resolveOpenclawInstanceId } from "@/shared/types";

export function instanceKeyPrefix(): string {
  return `${getOpenclawInstanceId()}:`;
}

export function assertScopedRedisKey(key: string): void {
  const prefix = instanceKeyPrefix();
  if (!key.startsWith(prefix)) {
    throw new Error(
      `Refusing to access Redis key "${key}" outside instance prefix "${prefix}".`,
    );
  }
}

function buildKey(suffix: string): string {
  return `${instanceKeyPrefix()}${suffix}`;
}

function buildKeyForInstance(instanceId: string, suffix: string): string {
  return `${resolveOpenclawInstanceId(instanceId)}:${suffix}`;
}

export function metaKey(): string {
  return buildKey("meta");
}

export function initLockKey(): string {
  return buildKey("lock:init");
}

export function lifecycleLockKey(): string {
  return buildKey("lock:lifecycle");
}

export function startLockKey(): string {
  return buildKey("lock:start");
}

export function tokenRefreshLockKey(): string {
  return buildKey("lock:token-refresh");
}

export function cronNextWakeKey(): string {
  return buildKey("cron-next-wake-ms");
}

export function cronJobsKey(): string {
  return buildKey("cron-jobs-json");
}

export function adminSecretKey(): string {
  return buildKey("admin-secret");
}

export function sessionSecretKey(): string {
  return buildKey("session-secret");
}

export function learningLockKey(): string {
  return buildKey("lock:learning-refresh");
}

export function debugLockKey(): string {
  return buildKey("lock:debug-timing");
}

export function setupProgressKey(instanceId = "openclaw-single"): string {
  return buildKeyForInstance(instanceId, "setup-progress");
}

export function channelQueueKey(channel: ChannelName): string {
  return buildKey(`channels:${channel}:queue`);
}

export function channelProcessingKey(channel: ChannelName): string {
  return buildKey(`channels:${channel}:processing`);
}

export function channelFailedKey(
  channel: ChannelName,
  deliveryId?: string,
): string {
  const base = `channels:${channel}:failed`;
  return buildKey(deliveryId ? `${base}:${deliveryId}` : base);
}

export function channelDrainLockKey(channel: ChannelName): string {
  return buildKey(`channels:${channel}:drain-lock`);
}

export function channelSessionHistoryKey(
  channel: ChannelName,
  sessionKey: string,
): string {
  return buildKey(`channels:${channel}:history:${sessionKey}`);
}

export function channelDedupKey(channel: ChannelName, dedupId: string): string {
  return buildKey(`channels:${channel}:dedup:${dedupId}`);
}

export function channelUserMessageDedupKey(
  channel: ChannelName,
  channelId: string,
  ts: string,
): string {
  return buildKey(`channels:${channel}:user-message-dedup:${channelId}:${ts}`);
}

export function channelPendingBootMessageKey(
  channel: ChannelName,
  channelId: string,
): string {
  return buildKey(`channels:${channel}:pending-boot:${channelId}`);
}

export function watchdogReportKey(): string {
  return buildKey("watchdog:latest");
}

export function launchVerifyReadinessKey(): string {
  return buildKey("launch-verify:channel-readiness");
}

export function launchVerifyQueueResultKey(probeId: string): string {
  return buildKey(`launch-verify:queue-result:${probeId}`);
}

export function discordReconcileKey(): string {
  return buildKey("discord:integration:last-reconciled-at");
}

export function channelForwardDiagnosticKey(): string {
  return buildKey("diag:channel-forward-latest");
}

export function slackAppConfigKey(): string {
  return buildKey("slack:app-config");
}

export function slackInstallTokenKey(token: string): string {
  return buildKey(`slack:install-token:${token}`);
}
