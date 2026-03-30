import { useEffect, useRef, useState } from "react";
import {
  buildJsonRouteErrorMessage,
  type JsonRouteErrorPayload,
} from "@/components/api-route-errors";
import type {
  StatusPayload,
  RunAction,
  RequestJson,
} from "@/components/admin-types";
import { TelegramPanel } from "@/components/panels/telegram-panel";
import { SlackPanel } from "@/components/panels/slack-panel";
import { WhatsAppPanel } from "@/components/panels/whatsapp-panel";
import { DiscordPanel } from "@/components/panels/discord-panel";
import type {
  LaunchVerificationPayload,
  LaunchVerificationPhase,
  ChannelReadiness,
} from "@/shared/launch-verification";

type PreflightCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

type PreflightAction = {
  id: string;
  status: "required" | "recommended";
  message: string;
  remediation: string;
  env: string[];
};

type PreflightData = {
  ok: boolean;
  checks: PreflightCheck[];
  actions: PreflightAction[];
};

export type PreflightSummary = {
  ok: boolean | null;
  blockerIds: string[];
  blockerMessages: string[];
  requiredActionIds: string[];
  requiredRemediations: string[];
};

type PreflightResponsePayload = PreflightData & JsonRouteErrorPayload;

type ChannelsPanelProps = {
  active: boolean;
  status: StatusPayload;
  busy: boolean;
  runAction: RunAction;
  requestJson: RequestJson;
  refresh: () => Promise<void>;
};

export function getPreflightBlockerIds(
  preflight: Pick<PreflightData, "ok" | "checks"> | null,
): Set<string> | null {
  if (!preflight || preflight.ok) return null;
  return new Set(
    preflight.checks
      .filter((c) => c.status === "fail")
      .map((c) => c.id),
  );
}

export function summarizePreflight(
  preflight: PreflightData | null,
): PreflightSummary {
  const failedChecks =
    preflight?.checks.filter((check) => check.status === "fail") ?? [];
  const requiredActions =
    preflight?.actions.filter((action) => action.status === "required") ?? [];

  return {
    ok: preflight ? preflight.ok : null,
    blockerIds: failedChecks.map((check) => check.id),
    blockerMessages: failedChecks.map((check) => check.message),
    requiredActionIds: requiredActions.map((action) => action.id),
    requiredRemediations: requiredActions.map((action) => action.remediation),
  };
}

export function formatPreflightFetchError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to load deployment preflight. Refresh the panel or open /api/admin/preflight.";
}

async function loadPreflightData(): Promise<PreflightData> {
  const res = await fetch("/api/admin/preflight", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  const payload = (await res.json().catch(() => null)) as
    | PreflightResponsePayload
    | null;

  if (!res.ok) {
    throw new Error(
      buildJsonRouteErrorMessage(
        payload,
        `Failed to load deployment preflight: HTTP ${res.status}`,
      ),
    );
  }

  if (
    !payload ||
    typeof payload.ok !== "boolean" ||
    !Array.isArray(payload.checks) ||
    !Array.isArray(payload.actions)
  ) {
    throw new Error(
      "Failed to load deployment preflight: invalid JSON payload.",
    );
  }

  return payload;
}

/* ── Launch verification helpers (kept for exported API surface) ── */

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── Verification view-model ── */

export type VerificationViewModel = {
  badgeText: string;
  badgeClassName: string;
  summaryText: string;
  primaryActionLabel: "Verify" | "Re-verify" | "Verifying\u2026";
  primaryActionClassName: string;
  showQuickCheck: boolean;
};

export function getVerificationViewModel({
  readiness,
  verifyResult,
  verifyRunning,
  totalMs,
}: {
  readiness: Pick<ChannelReadiness, "ready" | "verifiedAt"> | null;
  verifyResult: Pick<LaunchVerificationPayload, "ok"> | null;
  verifyRunning: boolean;
  totalMs: number;
}): VerificationViewModel {
  const isVerified = readiness?.ready === true;
  const isFailed = verifyResult?.ok === false;

  if (verifyRunning) {
    return {
      badgeText: "Verifying\u2026",
      badgeClassName: "status-badge restoring",
      summaryText: "Verification in progress",
      primaryActionLabel: "Verifying\u2026",
      primaryActionClassName: "button primary",
      showQuickCheck: false,
    };
  }

  if (isFailed) {
    return {
      badgeText: "Failed",
      badgeClassName: "status-badge error",
      summaryText: "Last verification failed",
      primaryActionLabel: isVerified ? "Re-verify" : "Verify",
      primaryActionClassName: "button primary",
      showQuickCheck: !isVerified,
    };
  }

  if (isVerified) {
    const durationSuffix = verifyResult ? ` in ${formatDuration(totalMs)}` : "";
    return {
      badgeText: "Verified",
      badgeClassName: "status-badge running",
      summaryText: readiness?.verifiedAt
        ? `Verified ${formatTimestamp(readiness.verifiedAt)}${durationSuffix}`
        : `Verified${durationSuffix}`,
      primaryActionLabel: "Re-verify",
      primaryActionClassName: "button ghost",
      showQuickCheck: false,
    };
  }

  return {
    badgeText: "",
    badgeClassName: "",
    summaryText: "Not yet verified",
    primaryActionLabel: "Verify",
    primaryActionClassName: "button primary",
    showQuickCheck: true,
  };
}

/* ── Structured verification telemetry ── */

type VerificationRunMode = "safe" | "destructive";

type ChannelsPanelEvent =
  | {
      event: "channels.preflight.refresh";
      source: "channels-panel";
      ts: string;
      ok: boolean | null;
      blockerIds: string[];
      requiredActionIds: string[];
    }
  | {
      event: "channels.preflight.error";
      source: "channels-panel";
      ts: string;
      error: string;
    }
  | {
      event: "channels.readiness.refresh";
      source: "channels-panel";
      ts: string;
      ok: boolean;
      verifiedAt: string | null;
    }
  | {
      event: "channels.verify.start";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
    }
  | {
      event: "channels.verify.phase";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      phaseId: string;
      phaseStatus: LaunchVerificationPhase["status"];
      durationMs: number;
      message: string;
      error?: string;
    }
  | {
      event: "channels.verify.result";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      ok: boolean;
      totalMs: number;
      verifiedAt: string | null;
    }
  | {
      event: "channels.verify.error";
      source: "channels-panel";
      ts: string;
      requestId: string;
      mode: VerificationRunMode;
      error: string;
    };

export function createVerificationRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `verify-${crypto.randomUUID()}`;
  }
  return `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type ChannelsPanelEventInput = {
  [K in ChannelsPanelEvent["event"]]: Omit<
    Extract<ChannelsPanelEvent, { event: K }>,
    "source" | "ts"
  >;
}[ChannelsPanelEvent["event"]];

export function emitChannelsPanelEvent(
  event: ChannelsPanelEventInput,
): void {
  const payload = {
    source: "channels-panel" as const,
    ts: new Date().toISOString(),
    ...event,
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("openclaw:channels-panel", { detail: payload }),
    );
  }

  const serialized = JSON.stringify(payload);
  if (payload.event.endsWith(".error")) {
    console.error(`[openclaw.channels] ${serialized}`);
    return;
  }
  console.info(`[openclaw.channels] ${serialized}`);
}

export function formatLaunchVerificationFetchError(
  payload: { error?: { message?: string }; message?: string } | null,
  status: number,
): string {
  const explicit = payload?.error?.message ?? payload?.message;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }
  return `Verification request failed (HTTP ${status}). Refresh the panel or open /api/admin/launch-verify.`;
}

export function getVerificationSurfaceState(args: {
  readiness: ChannelReadiness | null;
  verifyResult: LaunchVerificationPayload | null;
  verifyRunning: boolean;
}): "idle" | "running" | "verified" | "failed" {
  if (args.verifyRunning) return "running";
  if (args.verifyResult) return args.verifyResult.ok ? "verified" : "failed";
  if (args.readiness?.ready) return "verified";
  return "idle";
}

/* ── Main component ── */

export function ChannelsPanel({
  active,
  status,
  busy,
  runAction,
  requestJson,
  refresh,
}: ChannelsPanelProps) {
  /* Preflight state */
  const [preflight, setPreflight] = useState<PreflightData | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightLoadedAt, setPreflightLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const preflightRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const preflightSummary = summarizePreflight(preflight);
  const preflightBlockerIds =
    preflightSummary.ok === false
      ? new Set(preflightSummary.blockerIds)
      : null;

  /* ── Preflight fetching ── */

  async function refreshPreflight(): Promise<void> {
    const requestId = preflightRequestIdRef.current + 1;
    preflightRequestIdRef.current = requestId;

    try {
      const nextPreflight = await loadPreflightData();
      if (!mountedRef.current || requestId !== preflightRequestIdRef.current) {
        return;
      }

      const summary = summarizePreflight(nextPreflight);
      setPreflight(nextPreflight);
      setPreflightError(null);
      setPreflightLoadedAt(Date.now());
      emitChannelsPanelEvent({
        event: "channels.preflight.refresh",
        ok: summary.ok,
        blockerIds: summary.blockerIds,
        requiredActionIds: summary.requiredActionIds,
      });
    } catch (error) {
      if (!mountedRef.current || requestId !== preflightRequestIdRef.current) {
        return;
      }

      const message = formatPreflightFetchError(error);
      setPreflightError(message);
      emitChannelsPanelEvent({
        event: "channels.preflight.error",
        error: message,
      });
    }
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      void refreshPreflight();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active]);

  return (
    <article
      className="panel-card full-span"
      data-preflight-ok={
        preflightSummary.ok === null ? "unknown" : String(preflightSummary.ok)
      }
      data-preflight-blocker-ids={preflightSummary.blockerIds.join(",")}
      data-preflight-required-action-ids={preflightSummary.requiredActionIds.join(",")}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Channels</p>
          <h2>External entry points</h2>
        </div>
        <button
          className="button ghost"
          disabled={busy || refreshing}
          onClick={() => {
            setRefreshing(true);
            void Promise.all([refresh(), refreshPreflight()])
              .finally(() => setRefreshing(false));
          }}
        >
          {refreshing ? "Refreshing\u2026" : "Refresh"}
        </button>
      </div>

      {/* ── Preflight error ── */}
      {preflightError ? (
        <div className="error-banner" style={{ marginTop: 16, marginBottom: 16 }} aria-live="polite">
          <p style={{ margin: 0, fontWeight: 500 }}>{preflightError}</p>
          <p className="muted-copy" style={{ margin: "4px 0 0" }}>
            Channel cards keep the last known preflight snapshot until refresh succeeds.
          </p>
        </div>
      ) : null}

      {/* ── Preflight deployment blockers ── */}
      {preflightSummary.ok === false ? (
        <div
          className="error-banner"
          style={{ marginTop: 16, marginBottom: 16 }}
          aria-live="polite"
          data-preflight-banner="deployment-blockers"
        >
          <p style={{ margin: 0, fontWeight: 500 }}>
            Resolve deployment blockers before connecting channels.
          </p>
          {preflightSummary.blockerMessages.map((message) => (
            <p key={message} className="muted-copy" style={{ margin: "4px 0 0" }}>
              {message}
            </p>
          ))}
          {preflightSummary.requiredRemediations.length > 0 ? (
            <details className="channel-details" style={{ marginTop: 10 }}>
              <summary>Required changes</summary>
              <div className="channel-details-body">
                {preflightSummary.requiredRemediations.map((remediation) => (
                  <p key={remediation} className="muted-copy" style={{ margin: 0 }}>
                    {remediation}
                  </p>
                ))}
              </div>
            </details>
          ) : null}
          {preflightLoadedAt ? (
            <p className="muted-copy" style={{ margin: "8px 0 0" }}>
              Checked {new Date(preflightLoadedAt).toLocaleTimeString()}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="channel-grid">
        <SlackPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <TelegramPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <DiscordPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
        <WhatsAppPanel
          status={status}
          busy={busy}
          runAction={runAction}
          requestJson={requestJson}
          preflightBlockerIds={preflightBlockerIds}
        />
      </div>
    </article>
  );
}
