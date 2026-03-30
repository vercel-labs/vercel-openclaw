"use client";

import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import {
  getFirstRunCallout,
  getLifecycleActionLabel,
} from "@/shared/sandbox-lifecycle-copy";
import type {
  SetupProgress,
  StatusPayload,
  RunAction,
} from "@/components/admin-types";
import type { SingleStatus } from "@/shared/types";

type StatusPanelProps = {
  status: StatusPayload;
  busy: boolean;
  pendingAction: string | null;
  runAction: RunAction;
  checkHealth: () => Promise<void>;
};

const NEEDS_RESTART = new Set<SingleStatus>(["error", "stopped", "uninitialized"]);
const IS_TRANSITIONAL = new Set<SingleStatus>([
  "creating",
  "restoring",
  "booting",
  "setup",
]);

const STEP_ORDER = [
  "Creating sandbox",
  "Installing OpenClaw",
  "Configuring",
  "Starting gateway",
  "Ready",
] as const;

function getSetupStepIndex(progress: SetupProgress | null): number {
  if (!progress) return 0;
  switch (progress.phase) {
    case "creating-sandbox":
      return 0;
    case "installing-openclaw":
    case "installing-bun":
    case "cleaning-cache":
    case "installing-plugin":
      return 1;
    case "writing-config":
    case "checking-version":
      return 2;
    case "starting-gateway":
    case "waiting-for-gateway":
    case "pairing-device":
    case "applying-firewall":
      return 3;
    case "ready":
      return 4;
    case "failed":
      return 3;
    default:
      return 0;
  }
}

function getSetupStepState(
  index: number,
  activeIndex: number,
  failed: boolean,
): "past" | "current" | "upcoming" | "failed" {
  if (failed && index === activeIndex) return "failed";
  if (index < activeIndex) return "past";
  if (index === activeIndex) return "current";
  return "upcoming";
}

function friendlyError(raw: string): { headline: string; detail: string } {
  const lower = raw.toLowerCase();
  if (lower.includes("gateway never became ready") || lower.includes("gateway_ready_timeout")) {
    return {
      headline: "Gateway didn't respond in time",
      detail: "This can happen after a deployment or token rotation. Restarting usually fixes it.",
    };
  }
  if (lower.includes("snapshot storage") || lower.includes("snapshot_not_found")) {
    return {
      headline: "Snapshot unavailable",
      detail: "The snapshot could not be loaded. Check your Upstash connection or create a new sandbox.",
    };
  }
  if (lower.includes("oidc") || lower.includes("token") || lower.includes("ai gateway")) {
    return {
      headline: "AI Gateway authentication failed",
      detail: "This usually resolves on the next attempt when a fresh token is issued.",
    };
  }
  if (lower.includes("command") && lower.includes("failed")) {
    return {
      headline: "A setup command failed during restore",
      detail: "The sandbox started but a configuration step failed. Restarting usually fixes it.",
    };
  }
  return {
    headline: "Sandbox encountered an error",
    detail: "An unexpected error occurred during the last operation.",
  };
}

function formatDurationMinutes(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatDurationSeconds(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  return `${seconds}s`;
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 5_000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatGatewayStatus(status: StatusPayload["gatewayStatus"]): string {
  if (status === "ready") return "Ready";
  if (status === "not-ready") return "Not ready";
  return "Unknown";
}

export function getAutoSleepDisplay(
  status: Pick<StatusPayload, "timeoutSource">,
  displayedTimeoutMs: number | null,
): string {
  if (displayedTimeoutMs == null || status.timeoutSource === "none") {
    return "Unknown";
  }
  if (status.timeoutSource === "estimated" && displayedTimeoutMs <= 0) {
    return "Past estimated sleep time \u2014 sandbox may be asleep";
  }
  const suffix =
    status.timeoutSource === "estimated"
      ? " (estimated)"
      : status.timeoutSource === "live"
        ? " (live)"
        : "";
  return `${formatDurationMinutes(Math.max(displayedTimeoutMs, 0))}${suffix}`;
}

export function deriveEffectiveStatus(
  status: SingleStatus,
  timeoutRemainingMs: number | null,
  timeoutSource: string,
): SingleStatus | "asleep" {
  if (
    status === "running" &&
    timeoutSource === "estimated" &&
    timeoutRemainingMs != null &&
    timeoutRemainingMs <= 0
  ) {
    return "asleep";
  }
  return status;
}

// ---------------------------------------------------------------------------
// Fact builders — stopped vs running
// ---------------------------------------------------------------------------

type StatusFact = { label: string; value: string; detail?: string; warn?: boolean };


function getChannelSummary(channels: StatusPayload["channels"]): StatusFact | null {
  const items: string[] = [];
  if (channels.slack.configured) items.push("Slack");
  if (channels.telegram.configured) items.push("Telegram");
  if (channels.discord.configured) items.push("Discord");
  if (channels.whatsapp.configured) items.push("WhatsApp");
  if (items.length === 0) return null;
  return { label: "Channels", value: items.join(", ") };
}

function getTokenHealthFact(lifecycle: StatusPayload["lifecycle"]): StatusFact | null {
  if (lifecycle.consecutiveTokenRefreshFailures > 0) {
    const msg = lifecycle.breakerOpenUntil && lifecycle.breakerOpenUntil > Date.now()
      ? `Paused (${lifecycle.consecutiveTokenRefreshFailures} failures)`
      : `${lifecycle.consecutiveTokenRefreshFailures} consecutive failures`;
    return { label: "Token health", value: msg, warn: true };
  }
  if (lifecycle.lastTokenSource) {
    return { label: "Token", value: lifecycle.lastTokenSource.toUpperCase() };
  }
  return null;
}

function getRestoreEstimate(lifecycle: StatusPayload["lifecycle"]): string | null {
  const metrics = lifecycle.lastRestoreMetrics;
  if (!metrics) return null;
  const time = formatDurationSeconds(metrics.totalMs);
  return `~${time} on ${metrics.vcpus} vCPU${metrics.vcpus !== 1 ? "s" : ""}`;
}

function getRestoreReadiness(restoreTarget: StatusPayload["restoreTarget"]): StatusFact | null {
  if (!restoreTarget.attestation) return null;
  const att = restoreTarget.attestation;
  if (att.reusable) return { label: "Restore readiness", value: "Pre-warmed" };
  if (att.needsPrepare) {
    return {
      label: "Restore readiness",
      value: "Needs preparation",
      detail: att.reasons.join("; "),
      warn: true,
    };
  }
  return null;
}

function getStoppedFacts(status: StatusPayload): StatusFact[] {
  const facts: StatusFact[] = [];
  const lifecycle = status.lifecycle;

  // Restore point + speed estimate
  const estimate = getRestoreEstimate(lifecycle);
  facts.push({
    label: "Restore point",
    value: status.snapshotId ? "Available" : "None",
    detail: estimate ?? undefined,
  });

  // Restore readiness
  const readiness = getRestoreReadiness(status.restoreTarget);
  if (readiness) facts.push(readiness);

  // Last active
  if (status.lastKeepaliveAt) {
    facts.push({
      label: "Last active",
      value: formatRelativeTime(status.lastKeepaliveAt),
    });
  }

  // Channel summary
  const channelFact = getChannelSummary(status.channels);
  if (channelFact) facts.push(channelFact);

  // Token health (warn only)
  const tokenFact = getTokenHealthFact(lifecycle);
  if (tokenFact?.warn) facts.push(tokenFact);

  return facts;
}

function getRunningFacts(status: StatusPayload): StatusFact[] {
  const facts: StatusFact[] = [];
  const lifecycle = status.lifecycle;

  // Gateway
  facts.push({
    label: "Gateway",
    value: formatGatewayStatus(status.gatewayStatus),
    detail:
      status.gatewayCheckedAt != null
        ? `Checked ${formatRelativeTime(status.gatewayCheckedAt)}`
        : undefined,
  });

  // Auto-sleep
  facts.push({
    label: "Auto-sleep",
    value: getAutoSleepDisplay(status, status.timeoutRemainingMs),
    detail:
      status.timeoutSource === "none"
        ? undefined
        : `Target ${Math.round(status.sleepAfterMs / 60_000)}m`,
  });

  // Sandbox ID
  if (status.sandboxId) {
    facts.push({
      label: "Sandbox",
      value: status.sandboxId,
    });
  }

  // Channel summary
  const channelFact = getChannelSummary(status.channels);
  if (channelFact) facts.push(channelFact);

  // Token health
  const tokenFact = getTokenHealthFact(status.lifecycle);
  if (tokenFact) facts.push(tokenFact);

  // Firewall
  if (status.firewall.mode !== "disabled") {
    const mode = status.firewall.mode === "enforcing" ? "Enforcing" : "Learning";
    const domainCount = status.firewall.learned.length + status.firewall.allowlist.length;
    facts.push({
      label: "Firewall",
      value: mode,
      detail: domainCount > 0 ? `${domainCount} domain${domainCount !== 1 ? "s" : ""}` : undefined,
    });
  }

  return facts;
}

function getSecondaryFacts(status: StatusPayload): StatusFact[] {
  const facts: StatusFact[] = [
    { label: "Auth", value: status.authMode },
    {
      label: "Store",
      value: status.persistentStore
        ? status.storeBackend
        : `${status.storeBackend} (memory only)`,
    },
  ];
  if (status.sandboxId && status.status !== "running") {
    facts.push({ label: "Sandbox ID", value: status.sandboxId });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StatusPanel({
  status,
  busy,
  pendingAction,
  runAction,
  checkHealth,
}: StatusPanelProps) {
  const { confirm: confirmStop, dialogProps: stopDialogProps } = useConfirm();

  const lifecycleStatus = status.status as SingleStatus;
  const effectiveStatus = deriveEffectiveStatus(
    lifecycleStatus,
    status.timeoutRemainingMs,
    status.timeoutSource,
  );
  const hasSnapshot = Boolean(status.snapshotId);
  const primaryActionLabel = getLifecycleActionLabel(
    effectiveStatus === "asleep" ? "stopped" : lifecycleStatus,
    hasSnapshot,
  );
  const firstRunCallout =
    lifecycleStatus === "uninitialized" ? getFirstRunCallout() : null;

  function handleRestart(): void {
    void runAction("/api/admin/ensure", {
      label: primaryActionLabel,
      successMessage:
        lifecycleStatus === "uninitialized"
          ? "Sandbox creation initiated"
          : lifecycleStatus === "stopped"
            ? "Sandbox start initiated"
            : hasSnapshot
              ? "Sandbox restore initiated"
              : "Fresh sandbox creation initiated",
      method: "POST",
    });
  }

  async function handleStop(): Promise<void> {
    const ok = await confirmStop({
      title: "Stop sandbox?",
      description:
        "This will snapshot the current state and stop the sandbox. You can restore it later from the snapshot.",
      confirmLabel: "Snapshot & stop",
      variant: "danger",
    });
    if (!ok) return;
    void runAction("/api/admin/stop", {
      label: "Stop sandbox",
      successMessage: "Sandbox stopped",
      method: "POST",
    });
  }

  const isStopping = pendingAction === "Stop sandbox";
  const displayStatus = isStopping ? "stopping" : effectiveStatus;
  const showRestart =
    NEEDS_RESTART.has(lifecycleStatus) || effectiveStatus === "asleep";
  const showRunningActions =
    lifecycleStatus === "running" &&
    effectiveStatus !== "asleep" &&
    !isStopping;
  const isLifecycleTransition = IS_TRANSITIONAL.has(lifecycleStatus);
  const isTransitional = isLifecycleTransition || isStopping;
  const errorCopy = status.lastError ? friendlyError(status.lastError) : null;
  const isCheckingHealth = pendingAction === "Check health";
  const setupProgress = status.setupProgress;
  const showSetupProgress = Boolean(
    setupProgress && (isLifecycleTransition || setupProgress.phase === "failed"),
  );
  const activeStepIndex = getSetupStepIndex(setupProgress);
  const setupFailed = setupProgress?.phase === "failed";

  const isRunning = lifecycleStatus === "running" && effectiveStatus !== "asleep";
  const primaryFacts = isRunning
    ? getRunningFacts(status)
    : getStoppedFacts(status);
  const secondaryFacts = getSecondaryFacts(status);

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Sandbox</p>
          <h2>Sandbox status</h2>
        </div>
        <StatusBadge status={displayStatus} />
      </div>

      <dl className="metrics-grid">
        {primaryFacts.map((fact) => (
          <div key={fact.label} className={fact.warn ? "status-fact-warn" : undefined}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
            {fact.detail ? (
              <p className="status-fact-detail">{fact.detail}</p>
            ) : null}
          </div>
        ))}
      </dl>

      {secondaryFacts.length > 0 ? (
        <details className="status-secondary-details">
          <summary>Environment details</summary>
          <dl className="status-secondary-grid">
            {secondaryFacts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      {firstRunCallout ? (
        <div className="status-callout">
          <p className="status-callout-title">{firstRunCallout.headline}</p>
          {firstRunCallout.body.map((line) => (
            <p key={line} className="status-callout-copy">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {showSetupProgress ? (
        <section className="status-setup-card">
          <div className="status-setup-stack">
            <div className="status-setup-steps" aria-label="Setup steps">
              {STEP_ORDER.map((step, index) => (
                <div
                  key={step}
                  className="status-setup-step"
                  data-state={getSetupStepState(index, activeStepIndex, setupFailed)}
                >
                  {step}
                </div>
              ))}
            </div>
            <div>
              <p className="status-setup-phase-label">Current phase</p>
              <p className="status-setup-phase-title">
                {setupProgress?.phaseLabel ?? "Starting setup"}
              </p>
              {setupProgress?.preview ? (
                <p className="status-setup-phase-preview">
                  {setupProgress.preview}
                </p>
              ) : null}
            </div>
            {setupProgress && setupProgress.lines.length > 0 ? (
              <details className="status-setup-logs">
                <summary>Recent setup logs</summary>
                <pre>
                  {setupProgress.lines
                    .map((line) => `[${line.stream}] ${line.text}`)
                    .join("\n")}
                </pre>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="hero-actions hero-actions-end">
        {showRestart && (
          <button
            className="button success"
            disabled={busy}
            onClick={handleRestart}
          >
            {primaryActionLabel}
          </button>
        )}
        {showRunningActions && (
          <>
            <button
              className="button ghost"
              disabled={busy || isCheckingHealth}
              onClick={() => void checkHealth()}
              type="button"
            >
              {isCheckingHealth ? "Checking health\u2026" : "Check health"}
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void handleStop()}
            >
              Stop
            </button>
            <a
              className="button success"
              href={status.gatewayUrl}
              target="_blank"
              rel="noreferrer"
            >
              {primaryActionLabel}
            </a>
          </>
        )}
        {isTransitional && (
          <button className="button ghost" disabled>
            {isStopping ? "Stopping\u2026" : "Starting\u2026"}
          </button>
        )}
      </div>


      {errorCopy ? (
        <div className="error-banner">
          <p className="error-banner-headline">
            {errorCopy.headline}
          </p>
          <p className="error-banner-detail">
            {errorCopy.detail}
          </p>
          <details className="error-banner-technical">
            <summary>Technical details</summary>
            <pre>
              {status.lastError}
            </pre>
          </details>
        </div>
      ) : null}

      <ConfirmDialog {...stopDialogProps} />
    </article>
  );
}
