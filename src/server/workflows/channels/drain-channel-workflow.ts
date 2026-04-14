import {
  hasWhatsAppBusinessCredentials,
  type ChannelName,
  type TelegramChannelConfig,
} from "@/shared/channels";
import type { BootMessageHandle } from "@/server/channels/core/types";
import type { QueuedChannelJob } from "@/server/channels/driver";
import { extractTelegramChatId } from "@/server/channels/telegram/adapter";
import { deleteMessage, editMessageText } from "@/server/channels/telegram/bot-api";
import { deleteMessage as deleteWhatsAppMessage } from "@/server/channels/whatsapp/whatsapp-api";
import { logInfo, logWarn } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { getStore } from "@/server/store/store";
import { mutateMeta } from "@/server/store/store";
import { channelForwardDiagnosticKey } from "@/server/store/keyspace";

export type RetryingForwardResult = {
  ok: boolean;
  status: number;
  attempts: number;
  totalMs: number;
  transport?: "public" | "local" | null;
  retries: Array<{ attempt: number; reason: string; status?: number; error?: string }>;
  attemptsDetail?: ForwardAttemptDetail[];
};

export type DrainChannelWorkflowDependencies = {
  isRetryable: typeof import("@/server/channels/driver").isRetryable;
  createSlackAdapter: typeof import("@/server/channels/slack/adapter").createSlackAdapter;
  createTelegramAdapter: typeof import("@/server/channels/telegram/adapter").createTelegramAdapter;
  createDiscordAdapter: typeof import("@/server/channels/discord/adapter").createDiscordAdapter;
  createWhatsAppAdapter: typeof import("@/server/channels/whatsapp/adapter").createWhatsAppAdapter;
  reconcileDiscordIntegration: typeof import("@/server/channels/discord/reconcile").reconcileDiscordIntegration;
  runWithBootMessages: typeof import("@/server/channels/core/boot-messages").runWithBootMessages;
  ensureSandboxReady: typeof import("@/server/sandbox/lifecycle").ensureSandboxReady;
  getSandboxDomain: typeof import("@/server/sandbox/lifecycle").getSandboxDomain;
  forwardToNativeHandler: typeof forwardToNativeHandler;
  forwardTelegramToNativeHandlerLocally: typeof forwardTelegramToNativeHandlerLocally;
  forwardToNativeHandlerWithRetry: typeof forwardToNativeHandlerWithRetry;
  waitForTelegramNativeHandler: typeof waitForTelegramNativeHandler;
  probeTelegramNativeHandlerLocally: typeof probeTelegramNativeHandlerLocally;
  buildExistingBootHandle: typeof buildExistingBootHandle;
  RetryableError: typeof import("workflow").RetryableError;
  FatalError: typeof import("workflow").FatalError;
};

type DrainChannelErrorDependencies = Pick<
  DrainChannelWorkflowDependencies,
  "FatalError" | "RetryableError" | "isRetryable"
>;

export type ProcessChannelStepOptions = {
  receivedAtMs?: number | null;
  dependencies?: DrainChannelWorkflowDependencies;
  workflowHandoff?: ChannelWorkflowHandoff | null;
};

export type ChannelWorkflowHandoff = {
  fallbackTelegramConfig?: TelegramChannelConfig | null;
};

type TelegramRestoreContractAssessment = {
  status: "verified" | "not-expected" | "unverified";
  restoreMetricsRecordedAt: number | null;
  telegramExpected: boolean | null;
  telegramListenerReady: boolean | null;
  telegramListenerWaitMs: number | null;
};

function assessTelegramRestoreContract(
  meta: SingleMeta,
): TelegramRestoreContractAssessment {
  const restore = meta.lastRestoreMetrics;
  if (!restore) {
    return {
      status: "unverified",
      restoreMetricsRecordedAt: null,
      telegramExpected: null,
      telegramListenerReady: null,
      telegramListenerWaitMs: null,
    };
  }
  if (restore.telegramExpected !== true) {
    return {
      status: "not-expected",
      restoreMetricsRecordedAt: restore.recordedAt,
      telegramExpected: restore.telegramExpected ?? false,
      telegramListenerReady: restore.telegramListenerReady ?? null,
      telegramListenerWaitMs: restore.telegramListenerWaitMs ?? null,
    };
  }
  return {
    status: restore.telegramListenerReady === true ? "verified" : "unverified",
    restoreMetricsRecordedAt: restore.recordedAt,
    telegramExpected: true,
    telegramListenerReady: restore.telegramListenerReady ?? false,
    telegramListenerWaitMs: restore.telegramListenerWaitMs ?? null,
  };
}

export async function drainChannelWorkflow(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
  receivedAtMs?: number | null,
  workflowHandoff?: ChannelWorkflowHandoff | null,
): Promise<void> {
  "use workflow";

  await processChannelStep(channel, payload, origin, requestId, bootMessageId ?? null, {
    receivedAtMs: receivedAtMs ?? null,
    workflowHandoff: workflowHandoff ?? null,
  });
}

export async function processChannelStep(
  channel: string,
  payload: unknown,
  origin: string,
  requestId: string | null,
  bootMessageId?: number | string | null,
  options?: ProcessChannelStepOptions,
): Promise<void> {
  "use step";

  const receivedAtMs = options?.receivedAtMs ?? null;
  const workflowStartedAt = Date.now();
  const fallbackTelegramConfig =
    channel === "telegram"
      ? options?.workflowHandoff?.fallbackTelegramConfig ?? null
      : null;
  // Diagnostic trace — every phase appends here, written to store at the end.
  const diag: Record<string, unknown> = {
    channel,
    requestId,
    bootMessageId: bootMessageId ?? null,
    receivedAtMs,
    workflowStartedAt,
  };

  async function persistDiagSnapshot(
    phase: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await getStore().setValue(
        channelForwardDiagnosticKey(),
        {
          ...diag,
          ...extra,
          phase,
          phaseUpdatedAt: Date.now(),
        },
        3600,
      );
    } catch {
      // Best effort only. Do not interfere with delivery path.
    }
  }

  console.log(`[DIAG] processChannelStep START channel=${channel} requestId=${requestId} bootMessageId=${bootMessageId ?? "none"}`);
  await persistDiagSnapshot("workflow-step-started");

  const resolvedDependencies =
    options?.dependencies ?? (await loadDrainChannelWorkflowDependencies());
  const {
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    forwardToNativeHandler,
    forwardTelegramToNativeHandlerLocally,
    forwardToNativeHandlerWithRetry,
    waitForTelegramNativeHandler: waitForTgHandler,
    probeTelegramNativeHandlerLocally,
    buildExistingBootHandle,
  } = resolvedDependencies;

  if (channel === "discord") {
    try {
      await reconcileDiscordIntegration();
    } catch (err) {
      logWarn("channels.discord_integration_reconcile_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await restoreTelegramConfigFromWorkflowHandoff({
    requestId,
    fallbackTelegramConfig,
  });

  const existingBootHandle = await buildExistingBootHandle(channel, payload, bootMessageId);
  diag.hasExistingBootHandle = Boolean(existingBootHandle);

  try {
    // --- Phase 1: Wake the sandbox ---
    console.log(`[DIAG] Phase 1: runWithBootMessages starting`);
    const bootResult = await runWithBootMessages({
      channel: channel as ChannelName,
      adapter: buildMinimalBootAdapter(),
      message: { text: "", chatId: "", from: "" } as never,
      origin,
      reason: `channel:${channel}`,
      timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
      existingBootHandle,
    });

    diag.bootResultStatus = bootResult.meta.status;
    diag.bootResultSandboxId = bootResult.meta.sandboxId;
    diag.bootMessageSent = bootResult.bootMessageSent;
    diag.bootCompletedAt = Date.now();
    diag.bootDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] Phase 1 DONE: status=${bootResult.meta.status} sandboxId=${bootResult.meta.sandboxId} bootMessageSent=${bootResult.bootMessageSent} durationMs=${diag.bootDurationMs}`);
    await persistDiagSnapshot("boot-complete", {
      bootResultStatus: diag.bootResultStatus,
      bootResultSandboxId: diag.bootResultSandboxId,
      bootMessageSent: diag.bootMessageSent,
      bootDurationMs: diag.bootDurationMs,
    });

    const readyMeta = bootResult.meta.status === "running"
      ? bootResult.meta
      : await ensureSandboxReady({
          origin,
          reason: `channel:${channel}`,
          timeoutMs: WORKFLOW_SANDBOX_READY_TIMEOUT_MS,
        });
    const currentMeta = await getInitializedMeta();
    const effectiveReadyMeta = {
      ...readyMeta,
      channels: readyMeta.channels ?? currentMeta.channels,
    };
    const telegramRestoreContract =
      channel === "telegram"
        ? assessTelegramRestoreContract(effectiveReadyMeta)
        : null;

    const sandboxReadyAt = Date.now();
    diag.readyMetaStatus = effectiveReadyMeta.status;
    diag.readyMetaSandboxId = effectiveReadyMeta.sandboxId;
    diag.readyMetaPortUrlKeys = effectiveReadyMeta.portUrls ? Object.keys(effectiveReadyMeta.portUrls) : null;
    diag.readyMetaPortUrls = effectiveReadyMeta.portUrls;
    diag.readyMetaHasWebhookSecret = Boolean(effectiveReadyMeta.channels?.telegram?.webhookSecret);
    diag.usedBootMetaDirectly = bootResult.meta.status === "running";
    diag.telegramRestoreContractStatus = telegramRestoreContract?.status ?? null;
    diag.telegramRestoreContractRecordedAt =
      telegramRestoreContract?.restoreMetricsRecordedAt ?? null;
    diag.telegramRestoreExpected = telegramRestoreContract?.telegramExpected ?? null;
    diag.telegramRestoreListenerReady =
      telegramRestoreContract?.telegramListenerReady ?? null;
    diag.telegramRestoreListenerWaitMs =
      telegramRestoreContract?.telegramListenerWaitMs ?? null;
    diag.sandboxReadyAt = sandboxReadyAt;
    console.log(`[DIAG] Sandbox ready: status=${effectiveReadyMeta.status} sandboxId=${effectiveReadyMeta.sandboxId} portUrls=${JSON.stringify(effectiveReadyMeta.portUrls)} hasWebhookSecret=${diag.readyMetaHasWebhookSecret} usedBootMeta=${diag.usedBootMetaDirectly}`);
    await persistDiagSnapshot("sandbox-ready", {
      readyMetaStatus: diag.readyMetaStatus,
      readyMetaSandboxId: diag.readyMetaSandboxId,
      sandboxReadyAt,
      workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
      restoreMetrics: effectiveReadyMeta.lastRestoreMetrics ?? null,
      telegramRestoreContractStatus: diag.telegramRestoreContractStatus,
      telegramRestoreContractRecordedAt: diag.telegramRestoreContractRecordedAt,
      telegramRestoreExpected: diag.telegramRestoreExpected,
      telegramRestoreListenerReady: diag.telegramRestoreListenerReady,
      telegramRestoreListenerWaitMs: diag.telegramRestoreListenerWaitMs,
    });

    logInfo("channels.workflow_sandbox_ready", {
      channel,
      requestId,
      bootResultStatus: bootResult.meta.status,
      sandboxId: effectiveReadyMeta.sandboxId,
      portUrlKeys: effectiveReadyMeta.portUrls ? Object.keys(effectiveReadyMeta.portUrls) : null,
      telegramRestoreContractStatus: telegramRestoreContract?.status ?? null,
      telegramRestoreContractRecordedAt:
        telegramRestoreContract?.restoreMetricsRecordedAt ?? null,
      telegramRestoreExpected: telegramRestoreContract?.telegramExpected ?? null,
      telegramRestoreListenerReady:
        telegramRestoreContract?.telegramListenerReady ?? null,
      telegramRestoreListenerWaitMs:
        telegramRestoreContract?.telegramListenerWaitMs ?? null,
    });

    if (
      channel === "telegram"
      && diag.usedBootMetaDirectly === true
      && telegramRestoreContract?.status === "unverified"
    ) {
      logWarn("channels.telegram_restore_contract_unverified", {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        restoreMetricsRecordedAt: telegramRestoreContract.restoreMetricsRecordedAt,
        telegramExpected: telegramRestoreContract.telegramExpected,
        telegramListenerReady: telegramRestoreContract.telegramListenerReady,
        telegramListenerWaitMs: telegramRestoreContract.telegramListenerWaitMs,
      });
    }

    // --- Phase 2: Forward raw payload to native handler ---
    let forwardResult: { ok: boolean; status: number };
    let retryingResult: RetryingForwardResult | null = null;

    const forwardStartedAt = Date.now();
    console.log(`[DIAG] Phase 2: forwarding to native handler channel=${channel}`);

    // For Telegram, port 3000 readiness is not enough. The public 8787
    // surface can return generic empty 200s long before the real handler
    // is reachable. Use the in-sandbox 127.0.0.1 probe as the readiness
    // gate, and keep the public probe only for diagnostics.
    if (channel === "telegram") {
      const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");
      const webhookSecret = effectiveReadyMeta.channels?.telegram?.webhookSecret ?? null;
      let localProbeResult = effectiveReadyMeta.sandboxId
        ? await probeTelegramNativeHandlerLocally(
            effectiveReadyMeta.sandboxId,
            OPENCLAW_TELEGRAM_WEBHOOK_PORT,
            webhookSecret,
          )
        : null;
      const localProbeStartedAt = Date.now();
      while (
        effectiveReadyMeta.sandboxId
        && localProbeResult?.ready !== true
        && Date.now() - localProbeStartedAt < TELEGRAM_PROBE_TIMEOUT_MS
      ) {
        await new Promise((r) => setTimeout(r, TELEGRAM_PROBE_INTERVAL_MS));
        localProbeResult = await probeTelegramNativeHandlerLocally(
          effectiveReadyMeta.sandboxId,
          OPENCLAW_TELEGRAM_WEBHOOK_PORT,
          webhookSecret,
        );
      }
      const probeResult =
        effectiveReadyMeta.sandboxId && localProbeResult?.ready === true
          ? null
          : await waitForTgHandler(
              getSandboxDomain,
              OPENCLAW_TELEGRAM_WEBHOOK_PORT,
              webhookSecret,
            );

      diag.telegramProbeReady = probeResult?.ready ?? null;
      diag.telegramProbeAttempts = probeResult?.attempts ?? null;
      diag.telegramProbeWaitMs = probeResult?.waitMs ?? null;
      diag.telegramProbeLastStatus = probeResult?.lastStatus ?? null;
      diag.telegramProbePublicUrl = probeResult?.publicUrl ?? null;
      diag.telegramProbeTimeline = probeResult?.timeline ?? null;
      diag.telegramProbeSkippedReason =
        probeResult === null ? "local-handler-ready" : null;
      diag.telegramLocalProbeStatus = localProbeResult?.status ?? null;
      diag.telegramLocalProbeReady = localProbeResult?.ready ?? null;
      diag.telegramLocalProbeError = localProbeResult?.error ?? null;
      diag.telegramLocalProbeDetail = localProbeResult?.detail ?? null;
      diag.telegramLocalProbeDurationMs = localProbeResult?.durationMs ?? null;
      diag.telegramLocalProbeBodyLength = localProbeResult?.bodyLength ?? null;
      diag.telegramLocalProbeBodyHead = localProbeResult?.bodyHead ?? null;
      diag.telegramLocalProbeHeaders = localProbeResult?.headers ?? null;
      console.log(
        `[DIAG] Telegram native handler probe done: publicReady=${probeResult?.ready ?? "skipped"} attempts=${probeResult?.attempts ?? 0} waitMs=${probeResult?.waitMs ?? 0} lastStatus=${probeResult?.lastStatus ?? "n/a"} localStatus=${localProbeResult?.status ?? "n/a"} localError=${localProbeResult?.error ?? "none"} localDetail=${localProbeResult?.detail ?? "none"}`,
      );
      await persistDiagSnapshot("telegram-probe-complete", {
        telegramProbeReady: diag.telegramProbeReady ?? null,
        telegramProbeAttempts: diag.telegramProbeAttempts ?? null,
        telegramProbeWaitMs: diag.telegramProbeWaitMs ?? null,
        telegramProbeLastStatus: diag.telegramProbeLastStatus ?? null,
        telegramProbeSkippedReason: diag.telegramProbeSkippedReason ?? null,
        telegramLocalProbeStatus: diag.telegramLocalProbeStatus ?? null,
        telegramLocalProbeReady: diag.telegramLocalProbeReady ?? null,
        telegramLocalProbeError: diag.telegramLocalProbeError ?? null,
        telegramLocalProbeDetail: diag.telegramLocalProbeDetail ?? null,
        telegramLocalProbeDurationMs: diag.telegramLocalProbeDurationMs ?? null,
      });

      if (probeResult?.ready === true && localProbeResult?.ready !== true) {
        logWarn("channels.telegram_probe_local_mismatch", {
          channel,
          requestId,
          sandboxId: effectiveReadyMeta.sandboxId,
          publicLastStatus: probeResult.lastStatus,
          publicAttempts: probeResult.attempts,
          publicWaitMs: probeResult.waitMs,
          localStatus: localProbeResult?.status ?? null,
          localReady: localProbeResult?.ready ?? null,
          localError: localProbeResult?.error ?? null,
          localDetail: localProbeResult?.detail ?? null,
        });
      }

      retryingResult = await forwardToNativeHandlerWithRetry(
        channel as ChannelName,
        payload,
        effectiveReadyMeta,
        getSandboxDomain,
        forwardTelegramToNativeHandlerLocally,
        Boolean(effectiveReadyMeta.sandboxId),
      );
      forwardResult = { ok: retryingResult.ok, status: retryingResult.status };
    } else {
      forwardResult = await forwardToNativeHandler(
        channel as ChannelName,
        payload,
        effectiveReadyMeta,
        getSandboxDomain,
      );
    }

    const forwardCompletedAt = Date.now();
    diag.forwardOk = forwardResult.ok;
    diag.forwardStatus = forwardResult.status;
    diag.forwardDurationMs = forwardCompletedAt - forwardStartedAt;
    diag.forwardAttempts = retryingResult?.attempts ?? null;
    diag.forwardRetries = retryingResult?.retries ?? null;
    diag.forwardTotalMs = retryingResult?.totalMs ?? null;
    diag.forwardTransport =
      retryingResult?.transport ?? (channel === "telegram" ? "public" : null);
    diag.forwardAttemptTimeline = retryingResult?.attemptsDetail ?? null;
    console.log(`[DIAG] Phase 2 DONE: ok=${forwardResult.ok} status=${forwardResult.status} attempts=${retryingResult?.attempts ?? 1} retries=${JSON.stringify(retryingResult?.retries ?? [])} durationMs=${diag.forwardDurationMs}`);
    await persistDiagSnapshot("native-forward-complete", {
      forwardOk: diag.forwardOk,
      forwardStatus: diag.forwardStatus,
      forwardDurationMs: diag.forwardDurationMs,
      forwardAttempts: diag.forwardAttempts,
      forwardRetries: diag.forwardRetries,
      forwardTotalMs: diag.forwardTotalMs,
      forwardTransport: diag.forwardTransport,
      forwardAttemptTimeline: diag.forwardAttemptTimeline,
    });

    logInfo("channels.workflow_native_forward_result", {
      channel,
      requestId,
      sandboxId: effectiveReadyMeta.sandboxId,
      ok: forwardResult.ok,
      status: forwardResult.status,
      transport: retryingResult?.transport ?? (channel === "telegram" ? "public" : null),
      retryingForwardAttempts: retryingResult?.attempts ?? null,
      retryingForwardTotalMs: retryingResult?.totalMs ?? null,
      retryingForwardRetries: retryingResult?.retries?.length ?? null,
    });

    // Emit one end-to-end Telegram wake summary per request.
    if (channel === "telegram") {
      const restore = effectiveReadyMeta.lastRestoreMetrics;
      logInfo("channels.telegram_wake_summary", {
        channel,
        requestId,
        sandboxId: effectiveReadyMeta.sandboxId,
        bootResultStatus: bootResult.meta.status,
        webhookToWorkflowMs: typeof receivedAtMs === "number" ? Math.max(0, workflowStartedAt - receivedAtMs) : null,
        workflowToSandboxReadyMs: sandboxReadyAt - workflowStartedAt,
        forwardMs: forwardCompletedAt - forwardStartedAt,
        endToEndMs: typeof receivedAtMs === "number" ? Math.max(0, forwardCompletedAt - receivedAtMs) : null,
        restoreTotalMs: restore?.totalMs ?? null,
        sandboxCreateMs: restore?.sandboxCreateMs ?? null,
        assetSyncMs: restore?.assetSyncMs ?? null,
        startupScriptMs: restore?.startupScriptMs ?? null,
        localReadyMs: restore?.localReadyMs ?? null,
        postLocalReadyBlockingMs: restore?.postLocalReadyBlockingMs ?? null,
        publicReadyMs: restore?.publicReadyMs ?? null,
        bootOverlapMs: restore?.bootOverlapMs ?? null,
        skippedStaticAssetSync: restore?.skippedStaticAssetSync ?? null,
        skippedDynamicConfigSync: restore?.skippedDynamicConfigSync ?? null,
        dynamicConfigReason: restore?.dynamicConfigReason ?? null,
        telegramProbeReady: diag.telegramProbeReady ?? diag.telegramLocalProbeReady ?? null,
        telegramRestoreContractStatus: telegramRestoreContract?.status ?? null,
        telegramRestoreContractRecordedAt:
          telegramRestoreContract?.restoreMetricsRecordedAt ?? null,
        telegramRestoreExpected: telegramRestoreContract?.telegramExpected ?? null,
        telegramRestoreListenerReady:
          telegramRestoreContract?.telegramListenerReady ?? null,
        telegramRestoreListenerWaitMs:
          telegramRestoreContract?.telegramListenerWaitMs ?? null,
        telegramProbeLastStatus: diag.telegramProbeLastStatus ?? null,
        telegramProbePublicUrl: diag.telegramProbePublicUrl ?? null,
        telegramProbeSkippedReason:
          typeof diag.telegramProbeSkippedReason === "string"
            ? diag.telegramProbeSkippedReason
            : null,
        telegramLocalProbeStatus: diag.telegramLocalProbeStatus ?? null,
        telegramLocalProbeReady: diag.telegramLocalProbeReady ?? null,
        telegramLocalProbeError: diag.telegramLocalProbeError ?? null,
        telegramLocalProbeDetail: diag.telegramLocalProbeDetail ?? null,
        telegramLocalProbeDurationMs: diag.telegramLocalProbeDurationMs ?? null,
        telegramLocalProbeBodyLength: diag.telegramLocalProbeBodyLength ?? null,
        telegramLocalProbeBodyHead: diag.telegramLocalProbeBodyHead ?? null,
        telegramLocalProbeHeaders: diag.telegramLocalProbeHeaders ?? null,
        retryingForwardAttempts: retryingResult?.attempts ?? null,
        retryingForwardTotalMs: retryingResult?.totalMs ?? null,
        retryingForwardTransport: retryingResult?.transport ?? null,
        retryingForwardAttemptTimeline: retryingResult?.attemptsDetail ?? null,
        telegramReconcileBlocking: restore?.telegramReconcileBlocking ?? null,
        telegramReconcileMs: restore?.telegramReconcileMs ?? null,
        telegramSecretSyncBlocking: restore?.telegramSecretSyncBlocking ?? null,
        telegramSecretSyncMs: restore?.telegramSecretSyncMs ?? null,
        hotSpareHit: restore?.hotSpareHit ?? null,
        hotSparePromotionMs: restore?.hotSparePromotionMs ?? null,
        hotSpareRejectReason: restore?.hotSpareRejectReason ?? null,
      });
    }

    // Clean up the boot message after the native handler has processed.
    if (existingBootHandle) {
      await existingBootHandle.clear().catch(() => {});
    }

    diag.outcome = forwardResult.ok ? "success" : `failed:${forwardResult.status}`;
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] processChannelStep END outcome=${diag.outcome} totalMs=${diag.totalDurationMs}`);

    // Write diagnostic trace to store for admin retrieval
    try {
      await getStore().setValue(channelForwardDiagnosticKey(), diag, 3600);
    } catch { /* best effort */ }

    if (!forwardResult.ok) {
      throw new Error(
        `native_forward_failed status=${forwardResult.status}`,
      );
    }
  } catch (error) {
    diag.outcome = "error";
    diag.error = error instanceof Error ? error.message : String(error);
    diag.completedAt = Date.now();
    diag.totalDurationMs = Date.now() - workflowStartedAt;
    console.log(`[DIAG] processChannelStep ERROR: ${diag.error} totalMs=${diag.totalDurationMs}`);

    // Write diagnostic trace to store even on failure
    try {
      await getStore().setValue(channelForwardDiagnosticKey(), diag, 3600);
    } catch { /* best effort */ }

    throw toWorkflowProcessingError(channel, error, resolvedDependencies);
  }
}

async function restoreTelegramConfigFromWorkflowHandoff(input: {
  requestId: string | null;
  fallbackTelegramConfig: TelegramChannelConfig | null;
}): Promise<void> {
  if (!input.fallbackTelegramConfig) {
    return;
  }

  const current = await getInitializedMeta();
  if (current.channels.telegram) {
    return;
  }

  await mutateMeta((meta) => {
    if (!meta.channels.telegram) {
      meta.channels.telegram = structuredClone(input.fallbackTelegramConfig);
    }
  });

  logInfo("channels.telegram_workflow_handoff_restored_config", {
    requestId: input.requestId,
    configuredAt: input.fallbackTelegramConfig.configuredAt,
    botUsername: input.fallbackTelegramConfig.botUsername,
  });
}

const NATIVE_HANDLER_TIMEOUT_ERROR = "native_handler_timeout";

const TELEGRAM_PROBE_MAX_ATTEMPTS = 20;
const TELEGRAM_PROBE_INTERVAL_MS = 500;
const TELEGRAM_PROBE_TIMEOUT_MS = 15_000;

export type TelegramProbeResult = {
  ready: boolean;
  attempts: number;
  waitMs: number;
  lastStatus: number | null;
  publicUrl?: string | null;
  timeline?: TelegramProbeAttempt[];
};

export type TelegramProbeAttempt = {
  attempt: number;
  elapsedMs: number;
  durationMs?: number | null;
  status: number | null;
  bodyLength?: number | null;
  bodyHead?: string | null;
  headers?: DiagnosticHeaders | null;
  error?: string | null;
};

export type TelegramLocalProbeResult = {
  status: number | null;
  ready: boolean;
  durationMs?: number | null;
  bodyLength?: number | null;
  bodyHead?: string | null;
  headers?: DiagnosticHeaders | null;
  error: string | null;
  detail?: string | null;
};

export type DiagnosticHeaders = {
  server?: string | null;
  contentType?: string | null;
  contentLength?: string | null;
  xPoweredBy?: string | null;
  via?: string | null;
  cacheControl?: string | null;
};

type TelegramLocalProbeJson = {
  status?: number;
  durationMs?: number;
  bodyLength?: number;
  bodyHead?: string;
  headers?: DiagnosticHeaders | null;
  error?: string | null;
  detail?: string | null;
};

type TelegramForwardProbeJson = {
  ok?: boolean;
  status?: number;
  durationMs?: number;
  bodyLength?: number;
  bodyHead?: string;
  headers?: DiagnosticHeaders | null;
  error?: string | null;
  detail?: string | null;
};

function parseWorkflowJson<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export type ForwardAttemptDetail = {
  attempt: number;
  startedAtMs: number;
  elapsedMs: number;
  durationMs: number | null;
  status: number | null;
  ok: boolean | null;
  bodyLength: number | null;
  bodyHead: string | null;
  headers: DiagnosticHeaders | null;
  transport: "public" | "local";
  classification: string;
  error?: string | null;
};

function pickDiagnosticHeaders(headers: Headers): DiagnosticHeaders {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
    via: headers.get("via"),
    cacheControl: headers.get("cache-control"),
  };
}

/**
 * Poll the Telegram native handler on port 8787 until the webhook route
 * is registered.  The gateway starts a base HTTP server on 8787 immediately,
 * but the Telegram provider takes 2-4 seconds to register the
 * `/telegram-webhook` path.  During that window the base server returns
 * a generic 200 for POST requests, silently swallowing the payload.
 *
 * We send a GET to `/telegram-webhook` — the registered handler returns
 * 401 (missing secret header), while the base server returns 404.
 * When we see 401, the handler is ready and we can forward the real payload.
 */
async function waitForTelegramNativeHandler(
  getSandboxDomain: (port?: number) => Promise<string>,
  port: number,
  webhookSecret: string | null,
): Promise<TelegramProbeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + TELEGRAM_PROBE_TIMEOUT_MS;
  let lastStatus: number | null = null;
  let lastPublicUrl: string | null = null;
  const timeline: TelegramProbeAttempt[] = [];

  for (let attempt = 1; attempt <= TELEGRAM_PROBE_MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    try {
      const sandboxUrl = await getSandboxDomain(port);
      lastPublicUrl = sandboxUrl;
      const attemptStartedAt = Date.now();
      // Send a POST with an invalid secret — if the Telegram handler is
      // registered it returns 401 (secret mismatch).  The base server
      // returns 404 (path not found) or 200 (generic catch-all).
      const resp = await fetch(`${sandboxUrl}/telegram-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(webhookSecret ? { "x-telegram-bot-api-secret-token": "probe-invalid-secret" } : {}),
        },
        body: JSON.stringify({ probe: true }),
        signal: AbortSignal.timeout(3_000),
      });
      const probeBody = await resp.text().catch(() => "");
      lastStatus = resp.status;
      timeline.push({
        attempt,
        elapsedMs: Date.now() - startedAt,
        durationMs: Date.now() - attemptStartedAt,
        status: resp.status,
        bodyLength: probeBody.length,
        bodyHead: probeBody.slice(0, 200),
        headers: pickDiagnosticHeaders(resp.headers),
      });

      // 401 = Telegram handler is registered and rejecting our invalid secret.
      // This means the real forward with the correct secret will be accepted.
      if (resp.status === 401) {
        console.log(`[DIAG] telegram_probe: ready at attempt=${attempt} status=401 waitMs=${Date.now() - startedAt}`);
        return {
          ready: true,
          attempts: attempt,
          waitMs: Date.now() - startedAt,
          lastStatus: 401,
          publicUrl: lastPublicUrl,
          timeline,
        };
      }

      console.log(`[DIAG] telegram_probe: attempt=${attempt} status=${resp.status} (not ready)`);
    } catch (err) {
      timeline.push({
        attempt,
        elapsedMs: Date.now() - startedAt,
        durationMs: null,
        status: null,
        bodyLength: null,
        bodyHead: null,
        headers: null,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`[DIAG] telegram_probe: attempt=${attempt} error=${err instanceof Error ? err.message : String(err)}`);
    }

    if (attempt < TELEGRAM_PROBE_MAX_ATTEMPTS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, TELEGRAM_PROBE_INTERVAL_MS));
    }
  }

  console.log(`[DIAG] telegram_probe: TIMEOUT after ${Date.now() - startedAt}ms lastStatus=${lastStatus}`);
  // Timed out — proceed anyway and let the retrying forward handle it.
  return {
    ready: false,
    attempts: TELEGRAM_PROBE_MAX_ATTEMPTS,
    waitMs: Date.now() - startedAt,
    lastStatus,
    publicUrl: lastPublicUrl,
    timeline,
  };
}

async function probeTelegramNativeHandlerLocally(
  sandboxId: string,
  port: number,
  webhookSecret: string | null,
): Promise<TelegramLocalProbeResult> {
  try {
    const [{ getSandboxController }, { OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH }] = await Promise.all([
      import("@/server/sandbox/controller"),
      import("@/server/openclaw/config"),
    ]);
    const sandbox = await getSandboxController().get({ sandboxId });
    const script = `
const startedAt = Date.now();
const [port, path, useSecret] = process.argv.slice(1);
const url = \`http://127.0.0.1:\${port}\${path}\`;
const headers = { "content-type": "application/json" };
if (useSecret === "1") headers["x-telegram-bot-api-secret-token"] = "probe-invalid-secret";
function pick(headers) {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
    via: headers.get("via"),
    cacheControl: headers.get("cache-control"),
  };
}
fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ probe: true }),
  signal: AbortSignal.timeout(3000),
}).then(async (response) => {
  const text = await response.text().catch(() => "");
  process.stdout.write(JSON.stringify({
    status: response.status,
    durationMs: Date.now() - startedAt,
    bodyLength: text.length,
    bodyHead: text.slice(0, 200),
    headers: pick(response.headers),
    error: null,
  }));
}).catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 0,
    durationMs: Date.now() - startedAt,
    bodyLength: 0,
    bodyHead: "",
    headers: null,
    error: error instanceof Error ? error.message : String(error),
    detail: error instanceof Error && "cause" in error
      ? String((error as Error & { cause?: unknown }).cause ?? "")
      : null,
  }));
});
`.trim();
    const result = await sandbox.runCommand("node", [
      "-e",
      script,
      String(port),
      OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
      webhookSecret ? "1" : "0",
    ], {
      signal: AbortSignal.timeout(5_000),
    });
    const stdout = (await result.output("stdout")).trim();
    const parsed = parseWorkflowJson<TelegramLocalProbeJson>(stdout);
    const status = parsed && typeof parsed.status === "number" ? parsed.status : null;
    return {
      status,
      ready: status === 401,
      durationMs: parsed?.durationMs ?? null,
      bodyLength: parsed?.bodyLength ?? null,
      bodyHead: parsed?.bodyHead ?? null,
      headers: parsed?.headers ?? null,
      error: parsed?.error ?? null,
      detail: parsed?.detail ?? null,
    };
  } catch (error) {
    return {
      status: null,
      ready: false,
      durationMs: null,
      bodyLength: null,
      bodyHead: null,
      headers: null,
      error: error instanceof Error ? error.message : String(error),
      detail:
        error instanceof Error && "cause" in error
          ? String((error as Error & { cause?: unknown }).cause ?? "")
          : null,
    };
  }
}

async function forwardTelegramToNativeHandlerLocally(
  sandboxId: string,
  payload: unknown,
  webhookSecret: string | null,
): Promise<{
  ok: boolean;
  status: number;
  durationMs: number;
  bodyLength: number;
  bodyHead: string;
  headers: DiagnosticHeaders | null;
  error?: string | null;
  detail?: string | null;
}> {
  try {
    const [{ getSandboxController }, { OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH, OPENCLAW_TELEGRAM_WEBHOOK_PORT }] = await Promise.all([
      import("@/server/sandbox/controller"),
      import("@/server/openclaw/config"),
    ]);
    const sandbox = await getSandboxController().get({ sandboxId });
    const script = `
const startedAt = Date.now();
const [port, path, payloadJson, secret] = process.argv.slice(1);
const url = \`http://127.0.0.1:\${port}\${path}\`;
const headers = { "content-type": "application/json" };
if (secret) headers["x-telegram-bot-api-secret-token"] = secret;
function pick(headers) {
  return {
    server: headers.get("server"),
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
    xPoweredBy: headers.get("x-powered-by"),
    via: headers.get("via"),
    cacheControl: headers.get("cache-control"),
  };
}
fetch(url, {
  method: "POST",
  headers,
  body: payloadJson,
  signal: AbortSignal.timeout(5000),
}).then(async (response) => {
  const text = await response.text().catch(() => "");
  process.stdout.write(JSON.stringify({
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - startedAt,
    bodyLength: text.length,
    bodyHead: text.slice(0, 300),
    headers: pick(response.headers),
    error: null,
  }));
}).catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    status: 0,
    durationMs: Date.now() - startedAt,
    bodyLength: 0,
    bodyHead: "",
    headers: null,
    error: error instanceof Error ? error.message : String(error),
    detail: error instanceof Error && "cause" in error
      ? String((error as Error & { cause?: unknown }).cause ?? "")
      : null,
  }));
});
`.trim();
    const result = await sandbox.runCommand("node", [
      "-e",
      script,
      String(OPENCLAW_TELEGRAM_WEBHOOK_PORT),
      OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
      JSON.stringify(payload),
      webhookSecret ?? "",
    ], {
      signal: AbortSignal.timeout(8_000),
    });
    const stdout = (await result.output("stdout")).trim();
    const parsed = parseWorkflowJson<TelegramForwardProbeJson>(stdout);
    return {
      ok: parsed?.ok === true,
      status: parsed && typeof parsed.status === "number" ? parsed.status : 0,
      durationMs: parsed?.durationMs ?? 0,
      bodyLength: parsed?.bodyLength ?? 0,
      bodyHead: parsed?.bodyHead ?? "",
      headers: parsed?.headers ?? null,
      error: parsed?.error ?? null,
      detail: parsed?.detail ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: 0,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
      error: error instanceof Error ? error.message : String(error),
      detail:
        error instanceof Error && "cause" in error
          ? String((error as Error & { cause?: unknown }).cause ?? "")
          : null,
    };
  }
}

/**
 * Minimal adapter that satisfies runWithBootMessages type requirements.
 * Only the boot message handle matters — message extraction is unused
 * because we forward the raw payload to the native handler.
 */
function buildMinimalBootAdapter() {
  return {
    extractMessage: async () => ({ kind: "skip" as const, reason: "native-forward" }),
    sendReply: async () => {},
    // sendBootMessage MUST be present — without it, runWithBootMessages
    // exits immediately when there's no existingBootHandle, skipping
    // the entire sandbox-ready polling loop.
    sendBootMessage: async () => ({
      async update() {},
      async clear() {},
    }),
  };
}

/**
 * Forward the raw webhook payload to OpenClaw's native channel handler on
 * the sandbox, matching the fast-path forwarding used in webhook routes.
 */
async function forwardToNativeHandler(
  channel: ChannelName,
  payload: unknown,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
): Promise<{ ok: boolean; status: number; durationMs: number; bodyLength: number; bodyHead: string; headers: DiagnosticHeaders | null }> {
  const { OPENCLAW_TELEGRAM_WEBHOOK_PORT } = await import("@/server/openclaw/config");

  let forwardUrl: string;
  const headers: Record<string, string> = { "content-type": "application/json" };

  switch (channel) {
    case "telegram": {
      const sandboxUrl = await getSandboxDomain(OPENCLAW_TELEGRAM_WEBHOOK_PORT);
      forwardUrl = `${sandboxUrl}/telegram-webhook`;
      if (meta.channels.telegram?.webhookSecret) {
        headers["x-telegram-bot-api-secret-token"] = meta.channels.telegram.webhookSecret;
      }
      break;
    }
    case "slack": {
      const sandboxUrl = await getSandboxDomain();
      forwardUrl = `${sandboxUrl}/slack/events`;
      break;
    }
    case "whatsapp": {
      const sandboxUrl = await getSandboxDomain();
      forwardUrl = `${sandboxUrl}/whatsapp-webhook`;
      break;
    }
    case "discord": {
      const sandboxUrl = await getSandboxDomain();
      forwardUrl = `${sandboxUrl}/discord-webhook`;
      break;
    }
    default:
      throw new Error(`unsupported_native_forward_channel:${channel}`);
  }

  console.log(`[DIAG] native_forward_attempt url=${forwardUrl} channel=${channel} sandboxId=${meta.sandboxId} hasSecret=${Boolean(headers["x-telegram-bot-api-secret-token"])}`);

  const t0 = Date.now();
  const response = await fetch(forwardUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const durationMs = Date.now() - t0;

  // Always capture response body for diagnostics.
  let responseBody: string | null = null;
  try {
    responseBody = await response.text();
  } catch { /* best effort */ }

  const bodyLength = responseBody?.length ?? 0;
  const bodyHead = (responseBody ?? "").slice(0, 300);
  const headersSnapshot = pickDiagnosticHeaders(response.headers);
  console.log(`[DIAG] native_forward_response status=${response.status} ok=${response.ok} durationMs=${durationMs} bodyLength=${bodyLength} body=${bodyHead} headers=${JSON.stringify(headersSnapshot)}`);

  if (!response.ok) {
    logWarn("channels.native_forward_error_response", {
      channel,
      status: response.status,
      forwardUrl,
      sandboxId: meta.sandboxId,
      responseBody: responseBody?.slice(0, 500) ?? null,
      responseHeaders: headersSnapshot,
    });
  }

  return { ok: response.ok, status: response.status, durationMs, bodyLength, bodyHead, headers: headersSnapshot };
}

const RETRYING_FORWARD_MAX_ATTEMPTS = 20;
const RETRYING_FORWARD_RETRY_INTERVAL_MS = 2_000;
const RETRYING_FORWARD_TIMEOUT_MS = 45_000;

/**
 * Collapsed probe + forward: sends the real payload directly to the native
 * handler, retrying on proxy-level failures (502/503/504), fetch exceptions,
 * and handler-not-ready responses (401/404).
 *
 * 401/404 are retried because the native handler (e.g. Telegram on port 8787)
 * may be listening at the TCP level but not yet have its webhook routes and
 * secret validation fully initialized.  The gateway boots port 3000 first;
 * the Telegram webhook listener on 8787 registers its path a few seconds
 * later.  During that window the handler returns 401 (secret check against
 * an uninitialized route) or 404 (path not yet registered).
 *
 * Duplicate-safety: retries ONLY happen when the handler definitely did not
 * process the request. Any response that is 2xx, 3xx, or 4xx (other than
 * 401/404) is treated as "handler received the request" and is never retried.
 */
async function forwardToNativeHandlerWithRetry(
  channel: ChannelName,
  payload: unknown,
  meta: import("@/shared/types").SingleMeta,
  getSandboxDomain: (port?: number) => Promise<string>,
  forwardTelegramToNativeHandlerLocally: ((
    sandboxId: string,
    payload: unknown,
    webhookSecret: string | null,
  ) => Promise<{
    ok: boolean;
    status: number;
    durationMs: number;
    bodyLength: number;
    bodyHead: string;
    headers: DiagnosticHeaders | null;
    error?: string | null;
  }>) | null,
  preferLocalTelegramForward = false,
): Promise<RetryingForwardResult> {
  const startedAt = Date.now();
  const deadline = startedAt + RETRYING_FORWARD_TIMEOUT_MS;
  const retries: Array<{ attempt: number; reason: string; status?: number; error?: string }> = [];
  const attemptsDetail: ForwardAttemptDetail[] = [];

  for (let attempt = 1; attempt <= RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const useLocalForward =
        channel === "telegram"
        && meta.sandboxId != null
        && forwardTelegramToNativeHandlerLocally != null
        && preferLocalTelegramForward;
      const transport: "public" | "local" = useLocalForward ? "local" : "public";
      const result = useLocalForward
        ? await forwardTelegramToNativeHandlerLocally(
            meta.sandboxId as string,
            payload,
            meta.channels.telegram?.webhookSecret ?? null,
          )
        : await forwardToNativeHandler(channel, payload, meta, getSandboxDomain);

      // Proxy-level failures (502/503/504): handler not listening yet. Safe to retry.
      // Handler-not-ready (401/404): native handler is listening at TCP level
      // but webhook route or secret validation is not yet initialized.
      //
      // Swallowed by base server (200 with empty body in <100ms): some OpenClaw
      // versions return a generic 200 from the base HTTP server on port 8787
      // before the Telegram webhook handler registers its route.  The real
      // handler processes the AI request (takes seconds) and returns a body.
      // A near-instant 200 with no body means the payload was silently
      // discarded.  Safe to retry — the handler never saw it.
      const swallowed = channel === "telegram"
        && transport === "public"
        && result.status === 200
        && result.bodyLength === 0
        && (
          result.headers?.server === "Vercel"
          || result.headers?.cacheControl === "public, max-age=0, must-revalidate"
          || result.durationMs < 100
        );
      const classification = swallowed
        ? "swallowed-by-base-server"
        : result.status >= 502
          ? "proxy-error"
          : result.status === 401 || result.status === 404
            ? "handler-not-ready"
            : result.ok
              ? "accepted"
              : "handler-error";
      attemptsDetail.push({
        attempt,
        startedAtMs: attemptStartedAt,
        elapsedMs: Date.now() - startedAt,
        durationMs: result.durationMs,
        status: result.status,
        ok: result.ok,
        bodyLength: result.bodyLength,
        bodyHead: result.bodyHead,
        headers: result.headers,
        transport,
        classification,
      });
      if (result.status >= 502 || result.status === 401 || result.status === 404 || swallowed) {
        const reason = classification;
        const entry = { attempt, reason, status: result.status };
        retries.push(entry);
        logInfo("channels.native_forward_retry", {
          channel,
          attempt,
          status: result.status,
          reason,
          durationMs: result.durationMs,
          bodyLength: result.bodyLength,
          bodyHead: result.bodyHead,
          transport,
          responseHeaders: result.headers,
          retryElapsedMs: Date.now() - startedAt,
        });
        if (attempt < RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, RETRYING_FORWARD_RETRY_INTERVAL_MS));
        }
        continue;
      }

      // Any other direct handler response: do NOT retry regardless of status.
      // This includes 200 (success), other 4xx (client error), 500 (server error).
      const totalMs = Date.now() - startedAt;
      logInfo("channels.retrying_forward_complete", {
        channel,
        ok: result.ok,
        status: result.status,
        attempts: attempt,
        totalMs,
        transport,
        retryCount: retries.length,
        attemptsDetail,
      });
      return {
        ok: result.ok,
        status: result.status,
        attempts: attempt,
        totalMs,
        transport,
        retries,
        attemptsDetail,
      };
    } catch (error) {
      // Connection refused, DNS failure, timeout — handler not reachable.
      const errorMsg = error instanceof Error ? error.message : String(error);
      const entry = { attempt, reason: "fetch-exception" as const, error: errorMsg };
      retries.push(entry);
      attemptsDetail.push({
        attempt,
        startedAtMs: attemptStartedAt,
        elapsedMs: Date.now() - startedAt,
        durationMs: null,
        status: null,
        ok: null,
        bodyLength: null,
        bodyHead: null,
        headers: null,
        transport: "public",
        classification: "fetch-exception",
        error: errorMsg,
      });
      logInfo("channels.native_forward_retry", {
        channel,
        attempt,
        reason: "fetch-exception",
        error: errorMsg,
        retryElapsedMs: Date.now() - startedAt,
      });
      if (attempt < RETRYING_FORWARD_MAX_ATTEMPTS && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RETRYING_FORWARD_RETRY_INTERVAL_MS));
      }
    }
  }

  // Exhausted retries — report as gateway timeout.
  const totalMs = Date.now() - startedAt;
  logWarn("channels.retrying_forward_exhausted", {
    channel,
    attempts: RETRYING_FORWARD_MAX_ATTEMPTS,
    totalMs,
    retryCount: retries.length,
    attemptsDetail,
  });
  return {
    ok: false,
    status: 504,
    attempts: RETRYING_FORWARD_MAX_ATTEMPTS,
    totalMs,
    transport: null,
    retries,
    attemptsDetail,
  };
}

async function buildExistingBootHandle(
  channel: string,
  payload: unknown,
  bootMessageId?: number | string | null,
): Promise<BootMessageHandle | undefined> {
  if (typeof bootMessageId === "number" && channel === "telegram") {
    const meta = await getInitializedMeta();
    const tgConfig = meta.channels.telegram;
    const chatId = extractTelegramChatId(payload);
    if (tgConfig && chatId) {
      const token = tgConfig.botToken;
      const numChatId = Number(chatId);
      return {
        async update(text: string) {
          try {
            await editMessageText(token, numChatId, bootMessageId, text);
          } catch (error) {
            logWarn("channels.telegram_boot_message_update_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async clear() {
          try {
            await deleteMessage(token, numChatId, bootMessageId);
          } catch (error) {
            logWarn("channels.telegram_boot_message_cleanup_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  if (typeof bootMessageId === "string" && channel === "slack") {
    const meta = await getInitializedMeta();
    const slackConfig = meta.channels.slack;
    const slackPayload = payload as { event?: { channel?: string } } | null;
    const slackChannel = slackPayload?.event?.channel;
    if (slackConfig && slackChannel) {
      const token = slackConfig.botToken;
      return {
        async update(text: string) {
          try {
            await fetch("https://slack.com/api/chat.update", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: slackChannel, ts: bootMessageId, text }),
              signal: AbortSignal.timeout(5_000),
            });
          } catch (error) {
            logWarn("channels.slack_boot_message_update_failed", {
              bootMessageTs: bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async clear() {
          try {
            await fetch("https://slack.com/api/chat.delete", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ channel: slackChannel, ts: bootMessageId }),
              signal: AbortSignal.timeout(5_000),
            });
          } catch (error) {
            logWarn("channels.slack_boot_message_cleanup_failed", {
              bootMessageTs: bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  if (typeof bootMessageId === "string" && channel === "whatsapp") {
    const meta = await getInitializedMeta();
    const waConfig = meta.channels.whatsapp;
    if (hasWhatsAppBusinessCredentials(waConfig)) {
      return {
        async update() {
          // WhatsApp does not support editing sent messages.
        },
        async clear() {
          try {
            await deleteWhatsAppMessage(waConfig.accessToken, bootMessageId);
          } catch (error) {
            logWarn("channels.whatsapp_boot_message_cleanup_failed", {
              bootMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      };
    }
  }
  return undefined;
}

export function buildQueuedChannelJob(
  payload: unknown,
  origin: string,
  requestId: string | null,
): QueuedChannelJob<unknown> {
  return {
    payload,
    origin,
    receivedAt: Date.now(),
    requestId,
  };
}

// Workflows can run for up to 5 minutes — give the sandbox 2 minutes to
// restore instead of the old 25-second queue consumer timeout.
const WORKFLOW_SANDBOX_READY_TIMEOUT_MS = 120_000;
const WORKFLOW_RETRY_AFTER = "15s";

function parseNativeForwardFailedStatus(errorMsg: string): number | null {
  const match = /native_forward_failed status=(\d+)/.exec(errorMsg);
  if (!match) {
    return null;
  }

  const status = Number.parseInt(match[1], 10);
  return Number.isNaN(status) ? null : status;
}

export function toWorkflowProcessingError(
  channel: string,
  error: unknown,
  dependencies: DrainChannelErrorDependencies,
): Error {
  const message = `drain_channel_workflow_failed:${channel}:${formatChannelError(error)}`;
  const errorMsg = formatChannelError(error);

  // Sandbox readiness failures are transient infrastructure issues while the
  // sandbox is restoring. Retry the workflow step so the webhook can recover
  // once the sandbox becomes available again.
  const nativeForwardFailedStatus = parseNativeForwardFailedStatus(errorMsg);
  if (
    errorMsg.includes("sandbox_not_ready") ||
    errorMsg.includes("SANDBOX_READY_TIMEOUT") ||
    errorMsg.includes(NATIVE_HANDLER_TIMEOUT_ERROR) ||
    (nativeForwardFailedStatus !== null && nativeForwardFailedStatus >= 500)
  ) {
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
  }

  if (nativeForwardFailedStatus !== null) {
    return new dependencies.FatalError(message);
  }

  if (dependencies.isRetryable(error)) {
    return new dependencies.RetryableError(message, {
      retryAfter: WORKFLOW_RETRY_AFTER,
    });
  }

  return new dependencies.FatalError(message);
}

async function loadDrainChannelWorkflowDependencies(): Promise<DrainChannelWorkflowDependencies> {
  const [
    { isRetryable },
    { createSlackAdapter },
    { createTelegramAdapter },
    { createDiscordAdapter },
    { createWhatsAppAdapter },
    { reconcileDiscordIntegration },
    { runWithBootMessages },
    { ensureSandboxReady, getSandboxDomain },
    { RetryableError, FatalError },
  ] = await Promise.all([
    import("@/server/channels/driver"),
    import("@/server/channels/slack/adapter"),
    import("@/server/channels/telegram/adapter"),
    import("@/server/channels/discord/adapter"),
    import("@/server/channels/whatsapp/adapter"),
    import("@/server/channels/discord/reconcile"),
    import("@/server/channels/core/boot-messages"),
    import("@/server/sandbox/lifecycle"),
    import("workflow"),
  ]);

  return {
    isRetryable,
    createSlackAdapter,
    createTelegramAdapter,
    createDiscordAdapter,
    createWhatsAppAdapter,
    reconcileDiscordIntegration,
    runWithBootMessages,
    ensureSandboxReady,
    getSandboxDomain,
    forwardToNativeHandler,
    forwardTelegramToNativeHandlerLocally,
    forwardToNativeHandlerWithRetry,
    waitForTelegramNativeHandler,
    probeTelegramNativeHandlerLocally,
    buildExistingBootHandle,
    RetryableError,
    FatalError,
  };
}

function formatChannelError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
