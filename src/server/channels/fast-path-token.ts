import { logInfo, logWarn } from "@/server/log";
import { withOperationContext } from "@/server/observability/operation-context";
import { ensureUsableAiGatewayCredential } from "@/server/sandbox/lifecycle";
import type { OperationContext } from "@/shared/types";

const CHANNEL_FAST_PATH_MIN_TOKEN_REMAINING_MS = 10 * 60 * 1000;

export type FastPathTokenChannel = "slack" | "telegram" | "whatsapp";

export async function refreshChannelFastPathGatewayToken(options: {
  channel: FastPathTokenChannel;
  sandboxId: string;
  requestId: string | null;
  op: OperationContext;
}): Promise<void> {
  const { channel, sandboxId, requestId, op } = options;
  try {
    const result = await ensureUsableAiGatewayCredential({
      minRemainingMs: CHANNEL_FAST_PATH_MIN_TOKEN_REMAINING_MS,
      reason: `channel:${channel}:fast-path-pre-forward`,
    });
    logInfo("channels.fast_path_token_refresh", withOperationContext(op, {
      channel,
      requestId,
      sandboxId,
      refreshed: result.refreshed,
      reason: result.reason,
      source: result.credential?.source ?? null,
      expiresAt: result.credential?.expiresAt ?? null,
      retryAfterMs: result.retryAfterMs ?? null,
    }));
  } catch (error) {
    logWarn("channels.fast_path_token_refresh_failed", withOperationContext(op, {
      channel,
      requestId,
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
