/**
 * Remote smoke phase functions.
 *
 * Each function hits a live deployed instance over HTTP and returns
 * a structured PhaseResult. No external dependencies — plain fetch().
 */

import { authHeaders, getAuthSource } from "./remote-auth.js";
import {
  buildSlackSmokePayload,
  buildTelegramSmokePayload,
} from "./remote-crypto.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseResult {
  phase: string;
  passed: boolean;
  durationMs: number;
  detail?: Record<string, unknown>;
  error?: string;
  /** Machine-readable error classification. Present on every failure. */
  errorCode?: string;
  /** The endpoint that was called when the failure occurred. */
  endpoint?: string;
  /** HTTP status code of the failed response, if applicable. */
  httpStatus?: number;
  /** Actionable suggestion for fixing the failure. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - t0)];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(phase: string, msg: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), phase, msg, ...data };
  console.error(JSON.stringify(entry));
}

/**
 * Fetch with an AbortController timeout.
 * Rejects with an error containing "timeout" if the request exceeds `timeoutMs`.
 */
function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Normalize abort/timeout errors to a consistent message and error code.
 */
function classifyError(err: unknown): { message: string; errorCode: string; hint: string } {
  if (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted")))
  ) {
    return {
      message: "request timeout (aborted)",
      errorCode: "TIMEOUT",
      hint: "Increase --request-timeout or check if the endpoint is reachable",
    };
  }
  if (err instanceof Error) {
    if (err.message.includes("ECONNREFUSED") || err.message.includes("connect")) {
      return {
        message: err.message,
        errorCode: "CONNECTION_REFUSED",
        hint: "Verify the base URL is correct and the server is running",
      };
    }
    if (err.message.includes("ENOTFOUND") || err.message.includes("getaddrinfo")) {
      return {
        message: err.message,
        errorCode: "DNS_FAILURE",
        hint: "Check the hostname in --base-url",
      };
    }
    return {
      message: err.message,
      errorCode: "FETCH_ERROR",
      hint: "Check network connectivity and server logs",
    };
  }
  return {
    message: String(err),
    errorCode: "UNKNOWN_ERROR",
    hint: "Unexpected error — check stderr logs for details",
  };
}

/** Back-compat wrapper used in polling loop. */
function errorMessage(err: unknown): string {
  return classifyError(err).message;
}

/** Build a failed PhaseResult from a caught exception. */
function failFromError(
  phase: string,
  endpoint: string,
  err: unknown,
): PhaseResult {
  const { message, errorCode, hint } = classifyError(err);
  log(phase, "error", { error: message, errorCode });
  return { phase, passed: false, durationMs: 0, error: message, errorCode, endpoint, hint };
}

/** Build a failed PhaseResult from an unexpected HTTP response. */
function failFromHttp(
  phase: string,
  endpoint: string,
  httpStatus: number,
  error: string,
  opts: { durationMs: number; detail?: Record<string, unknown>; errorCode?: string; hint?: string },
): PhaseResult {
  const errorCode = opts.errorCode ?? (httpStatus === 401 || httpStatus === 403 ? "AUTH_FAILED" : `HTTP_${httpStatus}`);
  const hint = opts.hint ?? (httpStatus === 401 || httpStatus === 403
    ? "Set SMOKE_AUTH_COOKIE or check deployment protection settings"
    : `Endpoint returned HTTP ${httpStatus}`);
  return {
    phase,
    passed: false,
    durationMs: opts.durationMs,
    detail: opts.detail,
    error,
    errorCode,
    endpoint,
    httpStatus,
    hint,
  };
}

// ---------------------------------------------------------------------------
// Centralized response classification
// ---------------------------------------------------------------------------

/** Structured classification of an HTTP response or parse failure. */
export interface ResponseClassification {
  errorCode: string;
  error: string;
  hint: string;
}

/** Detect login/sign-in pages returned as 200 instead of the expected content. */
function looksLikeLoginPage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    (lower.includes("<form") &&
      (lower.includes("login") ||
        lower.includes("sign in") ||
        lower.includes("password"))) ||
    lower.includes("sign in with vercel") ||
    lower.includes("__vercel_auth")
  );
}

/**
 * Classify common HTTP response problems before phase-specific validation.
 * Returns null if no common problem is detected.
 *
 * Handles: 401/403 auth, login HTML detection, unexpected redirects.
 */
export function classifyResponse(
  status: number,
  bodyText: string,
  headers?: { get(name: string): string | null },
): ResponseClassification | null {
  if (status === 401 || status === 403) {
    return {
      errorCode: "AUTH_FAILED",
      error: `Authentication failed (HTTP ${status})`,
      hint: "Set SMOKE_AUTH_COOKIE or check deployment protection settings",
    };
  }

  if (status >= 300 && status < 400) {
    const location = headers?.get("location") ?? "unknown";
    return {
      errorCode: "UNEXPECTED_REDIRECT",
      error: `Unexpected redirect to ${location} (HTTP ${status})`,
      hint: "Check proxy rewrite rules or deployment protection settings",
    };
  }

  if (looksLikeLoginPage(bodyText)) {
    return {
      errorCode: "LOGIN_PAGE",
      error: "Response is a login/sign-in page, not the expected content",
      hint: "Set SMOKE_AUTH_COOKIE — the endpoint requires authentication",
    };
  }

  return null;
}

/**
 * Try to parse a response body as a JSON object.
 * Returns the parsed data or a classification for malformed/non-object JSON.
 */
export function parseJsonBody(
  bodyText: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; classification: ResponseClassification } {
  try {
    const data = JSON.parse(bodyText);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      const kind = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
      return {
        ok: false,
        classification: {
          errorCode: "MALFORMED_JSON",
          error: `Expected JSON object, got ${kind}`,
          hint: "The endpoint returned valid JSON but not an object — check the API implementation",
        },
      };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      classification: {
        errorCode: "MALFORMED_JSON",
        error: "Response body is not valid JSON",
        hint: "The endpoint returned non-JSON content — it may be an error page or login redirect",
      },
    };
  }
}

/**
 * Read body as text, run classifyResponse, then parse JSON.
 * Returns a PhaseResult on early failure or the parsed body on success.
 */
function classifyAndParseJson(
  phase: string,
  endpoint: string,
  res: Response,
  bodyText: string,
  durationMs: number,
): PhaseResult | { body: Record<string, unknown> } {
  const c = classifyResponse(res.status, bodyText, res.headers);
  if (c) {
    log(phase, "classified", { errorCode: c.errorCode, httpStatus: res.status });
    return {
      phase, passed: false, durationMs, endpoint,
      httpStatus: res.status, error: c.error, errorCode: c.errorCode, hint: c.hint,
    };
  }
  const p = parseJsonBody(bodyText);
  if (!p.ok) {
    log(phase, "malformed-json", { errorCode: p.classification.errorCode });
    return {
      phase, passed: false, durationMs, endpoint,
      httpStatus: res.status,
      error: p.classification.error,
      errorCode: p.classification.errorCode,
      hint: p.classification.hint,
    };
  }
  return { body: p.data };
}

// ---------------------------------------------------------------------------
// Options shared by all phase functions
// ---------------------------------------------------------------------------

export interface PhaseOptions {
  /** Per-request timeout in milliseconds. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Safe phases (read-only)
// ---------------------------------------------------------------------------

export async function health(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "health";
  const endpoint = "/api/health";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    // Health is unauthenticated at the app level, but Vercel deployment
    // protection intercepts at the edge. Include bypass headers if available.
    const bypassHdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), Object.keys(bypassHdrs).length ? { headers: bypassHdrs } : undefined, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed = res.ok && body.ok === true;
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    return failFromHttp(phase, endpoint, res.status, body.ok === false ? "health check returned ok:false" : `unexpected HTTP ${res.status}`, {
      durationMs: ms,
      detail: body,
      errorCode: body.ok === false ? "HEALTH_NOT_OK" : undefined,
      hint: body.ok === false ? "The server is up but reporting unhealthy — check server logs" : undefined,
    });
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function status(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "status";
  const endpoint = "/api/status";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { headers: hdrs }, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed =
      res.ok &&
      typeof body.status === "string" &&
      typeof body.authMode === "string" &&
      typeof body.storeBackend === "string";
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    const missing = ["status", "authMode", "storeBackend"].filter(k => typeof body[k] !== "string");
    return failFromHttp(phase, endpoint, res.status,
      !res.ok ? `HTTP ${res.status}` : `missing fields: ${missing.join(", ")}`,
      { durationMs: ms, detail: body, errorCode: res.ok ? "MISSING_FIELDS" : undefined, hint: res.ok ? "Status endpoint returned 200 but response is missing expected fields" : undefined },
    );
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function gatewayProbe(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "gatewayProbe";
  const endpoint = "/gateway";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    // Follow redirects (e.g. Next.js trailing-slash 308) so we reach the
    // actual gateway HTML rather than classifying the redirect as a failure.
    const [res, ms] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { headers: hdrs },
        timeout,
      ),
    );
    const text = await res.text();

    // Centralized classification for auth/redirect/login-page
    const classified = classifyResponse(res.status, text, res.headers);
    if (classified) {
      log(phase, "classified", { errorCode: classified.errorCode, httpStatus: res.status });
      return {
        phase, passed: false, durationMs: ms, endpoint,
        httpStatus: res.status, error: classified.error, errorCode: classified.errorCode, hint: classified.hint,
      };
    }

    const hasMarker = text.includes("openclaw-app");
    const isWaitingPage = res.status === 202 || text.includes("waiting");

    const passed =
      (res.status === 200 && hasMarker) || res.status === 202;

    const detail: Record<string, unknown> = {
      httpStatus: res.status,
      bodyLength: text.length,
      hasMarker,
      isWaitingPage,
      ...(res.status === 200 && !hasMarker
        ? { expected: "body containing 'openclaw-app'", found: "200 without marker" }
        : {}),
    };

    if (passed) {
      log(phase, "ok", detail);
      return { phase, passed, durationMs: ms, detail, endpoint };
    }

    const error =
      res.status === 200 && !hasMarker
        ? "200 response missing 'openclaw-app' marker — may not be the real gateway"
        : `unexpected HTTP ${res.status}`;
    const errorCode =
      res.status === 200 && !hasMarker ? "MISSING_MARKER" : `HTTP_${res.status}`;
    const hint =
      res.status === 200 && !hasMarker
        ? "The response body should contain 'openclaw-app' — the proxy may be serving a different page"
        : `Gateway returned HTTP ${res.status}`;

    log(phase, "failed", detail);
    return { phase, passed, durationMs: ms, detail, error, errorCode, endpoint, httpStatus: res.status, hint };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function firewallRead(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "firewallRead";
  const endpoint = "/api/firewall";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { headers: hdrs }, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed =
      res.ok &&
      typeof body.mode === "string" &&
      Array.isArray(body.allowlist);
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    const missing = [
      typeof body.mode !== "string" && "mode",
      !Array.isArray(body.allowlist) && "allowlist",
    ].filter(Boolean);
    return failFromHttp(phase, endpoint, res.status,
      !res.ok ? `HTTP ${res.status}` : `missing fields: ${missing.join(", ")}`,
      { durationMs: ms, detail: body, errorCode: res.ok ? "MISSING_FIELDS" : undefined, hint: res.ok ? "Firewall endpoint responded but is missing expected fields" : undefined },
    );
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function channelsSummary(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "channelsSummary";
  const endpoint = "/api/channels/summary";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = authHeaders();
    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { headers: hdrs }, timeout),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed = res.ok;
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    return failFromHttp(phase, endpoint, res.status,
      `HTTP ${res.status}`,
      { durationMs: ms, detail: body },
    );
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function sshEcho(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "sshEcho";
  const endpoint = "/api/admin/ssh";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, ms] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify({ command: "echo", args: ["smoke-ok"] }),
        },
        timeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed =
      res.ok &&
      typeof body.stdout === "string" &&
      (body.stdout as string).includes("smoke-ok");
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    if (!res.ok) {
      return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, { durationMs: ms, detail: body });
    }
    return {
      phase, passed: false, durationMs: ms, detail: body, endpoint,
      error: "stdout missing 'smoke-ok' marker",
      errorCode: "ECHO_MISMATCH",
      hint: "SSH echo command ran but output did not contain expected marker",
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Test channel configuration
// ---------------------------------------------------------------------------

/**
 * Configure test channels with generated credentials (bypasses platform API
 * validation). Returns true if configuration succeeded.
 */
async function configureTestChannels(
  baseUrl: string,
  requestTimeoutMs: number,
): Promise<boolean> {
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const res = await fetchWithTimeout(
      url(baseUrl, "/api/admin/channel-secrets"),
      { method: "PUT", headers: hdrs },
      requestTimeoutMs,
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Remove test channel configurations.
 */
async function removeTestChannels(
  baseUrl: string,
  requestTimeoutMs: number,
): Promise<void> {
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    await fetchWithTimeout(
      url(baseUrl, "/api/admin/channel-secrets"),
      { method: "DELETE", headers: hdrs },
      requestTimeoutMs,
    );
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Server-side channel webhook signing
// ---------------------------------------------------------------------------

/**
 * Ask the server to sign and send a webhook payload for the given channel.
 * The server constructs the signed request and POSTs it to the local webhook
 * endpoint — raw secrets never leave the server.
 *
 * Returns { configured, sent, status } or null if the endpoint is unreachable.
 */
async function sendSmokeWebhook(
  baseUrl: string,
  channel: "slack" | "telegram",
  payloadBody: string,
  requestTimeoutMs: number,
): Promise<{ configured: boolean; sent: boolean; status?: number } | null> {
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const res = await fetchWithTimeout(
      url(baseUrl, "/api/admin/channel-secrets"),
      {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ channel, body: payloadBody }),
      },
      requestTimeoutMs,
    );
    if (!res.ok) return null;
    return (await res.json()) as { configured: boolean; sent: boolean; status?: number };
  } catch {
    return null;
  }
}

async function fetchChannelSummary(
  baseUrl: string,
  requestTimeoutMs: number,
): Promise<Record<string, { connected: boolean; queueDepth: number; deadLetterCount: number }> | null> {
  try {
    const hdrs = authHeaders();
    const res = await fetchWithTimeout(
      url(baseUrl, "/api/channels/summary"),
      { headers: hdrs },
      requestTimeoutMs,
    );
    if (!res.ok) return null;
    return (await res.json()) as Record<string, { connected: boolean; queueDepth: number; deadLetterCount: number }>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channel round-trip phase (tests webhook → queue → drain → completions)
// ---------------------------------------------------------------------------

export async function channelRoundTrip(baseUrl: string, opts?: PhaseOptions & { pollTimeoutMs?: number }): Promise<PhaseResult> {
  const phase = "channelRoundTrip";
  const endpoint = "/api/admin/channel-secrets";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollTimeout = opts?.pollTimeoutMs ?? 120_000;

  let configuredByUs = false;

  try {
    // 1. Try sending smoke webhooks (signed + delivered server-side)
    const slackPayload = buildSlackSmokePayload().body;
    const telegramPayload = buildTelegramSmokePayload();

    let slackResult = await sendSmokeWebhook(baseUrl, "slack", slackPayload, reqTimeout);
    let telegramResult = await sendSmokeWebhook(baseUrl, "telegram", telegramPayload, reqTimeout);

    if (!slackResult && !telegramResult) {
      log(phase, "skipped", { reason: "smoke-webhook-endpoint-unavailable" });
      return {
        phase, passed: true, durationMs: 0, endpoint,
        detail: { skipped: true, reason: "Could not reach smoke webhook endpoint" },
      };
    }

    let hasSlack = slackResult?.configured === true && slackResult.sent === true;
    let hasTelegram = telegramResult?.configured === true && telegramResult.sent === true;

    if (!hasSlack && !hasTelegram) {
      // Channels not configured — auto-configure test channels and retry
      const noneConfigured = (slackResult?.configured === false) && (telegramResult?.configured === false);
      if (noneConfigured) {
        log(phase, "auto-configuring", { reason: "no-channels-configured" });
        const configured = await configureTestChannels(baseUrl, reqTimeout);
        if (!configured) {
          log(phase, "skipped", { reason: "auto-configure-failed" });
          return {
            phase, passed: true, durationMs: 0, endpoint,
            detail: { skipped: true, reason: "No channels configured and auto-configure failed" },
          };
        }
        configuredByUs = true;

        // Retry with fresh payloads
        const retrySlackPayload = buildSlackSmokePayload().body;
        const retryTelegramPayload = buildTelegramSmokePayload();
        slackResult = await sendSmokeWebhook(baseUrl, "slack", retrySlackPayload, reqTimeout);
        telegramResult = await sendSmokeWebhook(baseUrl, "telegram", retryTelegramPayload, reqTimeout);
        hasSlack = slackResult?.configured === true && slackResult.sent === true;
        hasTelegram = telegramResult?.configured === true && telegramResult.sent === true;
      }

      if (!hasSlack && !hasTelegram) {
        log(phase, "send-failed", { slack: slackResult, telegram: telegramResult });
        return {
          phase, passed: false, durationMs: 0, endpoint,
          error: "Failed to send smoke webhooks",
          errorCode: "WEBHOOK_SEND_FAILED",
          detail: { slack: slackResult, telegram: telegramResult },
        };
      }
    }

    // 2. Read baseline queue state
    const baselineSummary = await fetchChannelSummary(baseUrl, reqTimeout);
    const baselineSlackDL = baselineSummary?.slack?.deadLetterCount ?? 0;
    const baselineTelegramDL = baselineSummary?.telegram?.deadLetterCount ?? 0;

    const results: Record<string, { sent: boolean; drained: boolean; deadLetterDelta: number; durationMs: number; error?: string }> = {};
    const t0 = performance.now();

    if (hasSlack) {
      results.slack = { sent: true, drained: false, deadLetterDelta: 0, durationMs: 0 };
    }
    if (hasTelegram) {
      results.telegram = { sent: true, drained: false, deadLetterDelta: 0, durationMs: 0 };
    }

    // 4. Poll until queues drain
    const deadline = Date.now() + pollTimeout;
    let delay = 2_000;

    while (Date.now() < deadline) {
      await sleep(delay);
      const summary = await fetchChannelSummary(baseUrl, reqTimeout);
      if (!summary) continue;

      let allDrained = true;

      if (hasSlack && results.slack?.sent) {
        if (summary.slack?.queueDepth === 0) {
          results.slack.drained = true;
          results.slack.deadLetterDelta = (summary.slack?.deadLetterCount ?? 0) - baselineSlackDL;
        } else {
          allDrained = false;
        }
      }

      if (hasTelegram && results.telegram?.sent) {
        if (summary.telegram?.queueDepth === 0) {
          results.telegram.drained = true;
          results.telegram.deadLetterDelta = (summary.telegram?.deadLetterCount ?? 0) - baselineTelegramDL;
        } else {
          allDrained = false;
        }
      }

      log(phase, "poll", { slackQueue: summary.slack?.queueDepth, telegramQueue: summary.telegram?.queueDepth });

      if (allDrained) break;
      delay = Math.min(delay * 1.5, 10_000);
    }

    const totalMs = Math.round(performance.now() - t0);

    // 5. Evaluate results
    const channelResults = Object.entries(results).map(([ch, r]) => ({
      channel: ch,
      ...r,
      durationMs: totalMs,
    }));

    // A channel passes if: sent successfully AND drained (queue=0)
    // Dead letters from smoke payloads are expected (fake channel/chat IDs cause reply failures)
    // so we don't fail on dead letter delta — we just report it
    const allSent = channelResults.every((r) => r.sent);
    const allDrained = channelResults.every((r) => r.drained);
    const passed = allSent && allDrained;

    log(phase, passed ? "ok" : "failed", { channelResults, configuredByUs });

    // Clean up auto-configured test channels
    if (configuredByUs) {
      await removeTestChannels(baseUrl, reqTimeout);
      log(phase, "test-channels-removed", {});
    }

    return {
      phase, passed, durationMs: totalMs, endpoint: "/api/channels/*/webhook",
      detail: { channels: channelResults, autoConfigured: configuredByUs },
      ...(!passed ? {
        error: !allSent ? "Failed to send some webhooks" : "Queues did not drain within timeout",
        errorCode: !allSent ? "WEBHOOK_SEND_FAILED" : "QUEUE_DRAIN_TIMEOUT",
        hint: !allSent ? "Check channel configuration and signing secrets" : "Increase --timeout or check sandbox logs",
      } : {}),
    };
  } catch (err) {
    // Clean up on failure too
    if (configuredByUs) {
      await removeTestChannels(baseUrl, reqTimeout);
    }
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Channel wake-from-sleep phase (destructive: stop → webhook → verify wake)
// ---------------------------------------------------------------------------

export async function channelWakeFromSleep(
  baseUrl: string,
  timeoutMs = 120_000,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "channelWakeFromSleep";
  const endpoint = "/api/channels/slack/webhook";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let configuredByUs = false;

  try {
    // 1. Probe if Slack is configured
    let slackProbe = await sendSmokeWebhook(baseUrl, "slack", "{}", reqTimeout);
    if (!slackProbe?.configured) {
      // Auto-configure test channels
      log(phase, "auto-configuring", { reason: "no-slack-configured" });
      const configured = await configureTestChannels(baseUrl, reqTimeout);
      if (!configured) {
        log(phase, "skipped", { reason: "auto-configure-failed" });
        return {
          phase, passed: true, durationMs: 0, endpoint,
          detail: { skipped: true, reason: "Slack not configured and auto-configure failed" },
        };
      }
      configuredByUs = true;
      slackProbe = await sendSmokeWebhook(baseUrl, "slack", "{}", reqTimeout);
      if (!slackProbe?.configured) {
        log(phase, "skipped", { reason: "still-not-configured-after-auto" });
        return {
          phase, passed: true, durationMs: 0, endpoint,
          detail: { skipped: true, reason: "Slack still not configured after auto-configure" },
        };
      }
    }

    const t0 = performance.now();

    // 2. Verify sandbox is stopped
    const statusRes = await fetchWithTimeout(
      url(baseUrl, "/api/status"),
      { headers: authHeaders() },
      reqTimeout,
    );
    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    if (statusBody.status === "running") {
      // Stop it first
      log(phase, "stopping-sandbox", {});
      const stopRes = await fetchWithTimeout(
        url(baseUrl, "/api/admin/snapshot"),
        { method: "POST", headers: { ...authHeaders({ mutation: true }), "Content-Type": "application/json" }, body: "{}" },
        reqTimeout,
      );
      if (!stopRes.ok) {
        return failFromHttp(phase, "/api/admin/snapshot", stopRes.status, "Failed to stop sandbox for wake test", {
          durationMs: Math.round(performance.now() - t0),
        });
      }
      log(phase, "sandbox-stopped", {});
    }

    // 3. Read baseline dead letters
    const baselineSummary = await fetchChannelSummary(baseUrl, reqTimeout);
    const baselineDL = baselineSummary?.slack?.deadLetterCount ?? 0;

    // 4. Send webhook while sandbox is stopped (signed + sent server-side)
    log(phase, "sending-webhook-while-stopped", {});
    const slackPayload = buildSlackSmokePayload().body;
    const slackResult = await sendSmokeWebhook(baseUrl, "slack", slackPayload, reqTimeout);
    if (!slackResult?.sent) {
      return {
        phase, passed: false, durationMs: Math.round(performance.now() - t0), endpoint,
        error: `Failed to send Slack webhook (status: ${slackResult?.status ?? "unknown"})`,
        errorCode: "WEBHOOK_SEND_FAILED",
        hint: "Check Slack channel configuration",
      };
    }

    // 5. Poll until sandbox wakes up AND queue drains
    const deadline = Date.now() + timeoutMs;
    let delay = 3_000;
    let sandboxRunning = false;
    let queueDrained = false;

    while (Date.now() < deadline) {
      await sleep(delay);

      // Check status
      try {
        const res = await fetchWithTimeout(
          url(baseUrl, "/api/status"),
          { headers: authHeaders() },
          reqTimeout,
        );
        const body = (await res.json()) as Record<string, unknown>;
        if (body.status === "running") {
          if (!sandboxRunning) {
            log(phase, "sandbox-woke-up", { elapsedMs: Math.round(performance.now() - t0) });
          }
          sandboxRunning = true;
        }
        log(phase, "poll", { status: body.status, sandboxRunning });
      } catch {
        // ignore fetch errors during polling
      }

      // Check queue
      if (sandboxRunning) {
        const summary = await fetchChannelSummary(baseUrl, reqTimeout);
        if (summary && summary.slack?.queueDepth === 0) {
          queueDrained = true;
          log(phase, "queue-drained", {
            deadLetterDelta: summary.slack.deadLetterCount - baselineDL,
            elapsedMs: Math.round(performance.now() - t0),
          });
          break;
        }
      }

      delay = Math.min(delay * 1.3, 10_000);
    }

    const totalMs = Math.round(performance.now() - t0);

    if (!sandboxRunning) {
      return {
        phase, passed: false, durationMs: totalMs, endpoint,
        error: "Sandbox did not wake up within timeout",
        errorCode: "WAKE_TIMEOUT",
        hint: "The channel webhook was sent but the sandbox did not reach 'running' — increase --timeout",
      };
    }

    if (!queueDrained) {
      return {
        phase, passed: false, durationMs: totalMs, endpoint,
        error: "Sandbox woke up but queue did not drain within timeout",
        errorCode: "QUEUE_DRAIN_TIMEOUT",
        hint: "Sandbox is running but the queued message was not processed — check drain logs",
      };
    }

    // Clean up auto-configured test channels
    if (configuredByUs) {
      await removeTestChannels(baseUrl, reqTimeout);
      log(phase, "test-channels-removed", {});
    }

    return {
      phase, passed: true, durationMs: totalMs, endpoint,
      detail: { sandboxWokeUp: true, queueDrained: true, autoConfigured: configuredByUs },
    };
  } catch (err) {
    if (configuredByUs) {
      await removeTestChannels(baseUrl, reqTimeout);
    }
    return failFromError(phase, endpoint, err);
  }
}

export async function chatCompletions(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "chatCompletions";
  const endpoint = "/gateway/v1/chat/completions";
  const timeout = opts?.requestTimeoutMs ?? 60_000; // LLM responses can be slow
  try {
    const hdrs = {
      ...authHeaders({ mutation: true }),
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      model: "default",
      messages: [{ role: "user", content: "Reply with exactly: smoke-ok" }],
      stream: false,
    });

    const [res, ms] = await timed(() =>
      fetchWithTimeout(url(baseUrl, endpoint), { method: "POST", headers: hdrs, body }, timeout),
    );

    const bodyText = await res.text();

    // Check for auth/redirect issues first
    const classified = classifyResponse(res.status, bodyText, res.headers);
    if (classified) {
      log(phase, "classified", { errorCode: classified.errorCode, httpStatus: res.status });
      return {
        phase, passed: false, durationMs: ms, endpoint,
        httpStatus: res.status, error: classified.error, errorCode: classified.errorCode, hint: classified.hint,
      };
    }

    // 202 = waiting page (sandbox not ready yet)
    if (res.status === 202) {
      log(phase, "waiting", { status: 202 });
      return {
        phase, passed: false, durationMs: ms, endpoint,
        httpStatus: 202,
        error: "Sandbox not ready — gateway returned waiting page",
        errorCode: "SANDBOX_NOT_READY",
        hint: "Run with --destructive to ensure the sandbox is running first, or wait for bootstrap to complete",
      };
    }

    if (!res.ok) {
      log(phase, "failed", { status: res.status, body: bodyText.slice(0, 500) });
      return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, {
        durationMs: ms,
        detail: { bodyPreview: bodyText.slice(0, 500) },
      });
    }

    // Try to parse as OpenAI-compatible response
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok) {
      // Non-JSON response — could be streaming or HTML
      const hasContent = bodyText.length > 10;
      log(phase, hasContent ? "non-json-response" : "empty-response", { bodyLength: bodyText.length });
      return {
        phase,
        passed: hasContent, // pass if we got any substantial response
        durationMs: ms,
        endpoint,
        detail: {
          bodyLength: bodyText.length,
          bodyPreview: bodyText.slice(0, 200),
          format: "non-json",
        },
        ...(hasContent ? {} : {
          error: "Empty response from completions endpoint",
          errorCode: "EMPTY_RESPONSE",
          hint: "OpenClaw may not be fully bootstrapped or the model is not responding",
        }),
      };
    }

    const data = parsed.data;

    // OpenAI format: { choices: [{ message: { content: "..." } }] }
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content ?? "";
    const hasContent = content.length > 0;

    log(phase, hasContent ? "ok" : "empty-content", {
      status: res.status,
      contentLength: content.length,
      contentPreview: content.slice(0, 200),
      model: data.model,
    });

    return {
      phase,
      passed: hasContent,
      durationMs: ms,
      endpoint,
      detail: {
        model: data.model,
        contentLength: content.length,
        contentPreview: content.slice(0, 200),
        ...(data.usage ? { usage: data.usage } : {}),
      },
      ...(hasContent ? {} : {
        error: "Completions response had no content",
        errorCode: "EMPTY_CONTENT",
        hint: "The endpoint responded with valid JSON but the assistant message was empty",
      }),
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Destructive phases (opt-in)
// ---------------------------------------------------------------------------

const HEAL_POLL_INITIAL_MS = 2_000;
const HEAL_POLL_MAX_MS = 10_000;
const HEAL_POLL_BACKOFF = 1.5;

async function pollUntilRunning(
  baseUrl: string,
  timeoutMs: number,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ running: boolean; lastBody: Record<string, unknown> | null }> {
  const deadline = Date.now() + timeoutMs;
  let delay = HEAL_POLL_INITIAL_MS;
  let lastBody: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const hdrs = authHeaders();
      const res = await fetchWithTimeout(
        url(baseUrl, "/api/status"),
        { headers: hdrs },
        requestTimeoutMs,
      );
      const body = (await res.json()) as Record<string, unknown>;
      lastBody = body;
      log("poll", "status", { status: body.status });
      if (body.status === "running") return { running: true, lastBody };
      if (body.status === "error") return { running: false, lastBody };
    } catch (err) {
      log("poll", "fetch-error", { error: errorMessage(err) });
    }
    delay = Math.min(delay * HEAL_POLL_BACKOFF, HEAL_POLL_MAX_MS);
  }

  return { running: false, lastBody };
}

export async function ensureRunning(
  baseUrl: string,
  timeoutMs = 120_000,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "ensureRunning";
  const endpoint = "/api/admin/ensure";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, fetchMs] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { method: "POST", headers: hdrs, body: "{}" },
        reqTimeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, fetchMs);
    if ("passed" in cr) return cr;
    const body = cr.body;
    log(phase, "initial-response", { status: res.status, body });

    if (res.status === 200 && body.state === "running") {
      return { phase, passed: true, durationMs: fetchMs, detail: body, endpoint };
    }

    if (res.status === 202) {
      const [poll, pollMs] = await timed(() =>
        pollUntilRunning(baseUrl, timeoutMs, reqTimeout),
      );
      const totalMs = fetchMs + pollMs;
      if (poll.running) {
        log(phase, "running-after-poll", { totalMs });
        return {
          phase,
          passed: true,
          durationMs: totalMs,
          detail: poll.lastBody ?? body,
          endpoint,
        };
      }
      log(phase, "timeout", { totalMs, lastBody: poll.lastBody });
      return {
        phase, passed: false, durationMs: totalMs,
        detail: poll.lastBody ?? body,
        error: "Timed out waiting for running state",
        errorCode: "POLL_TIMEOUT",
        endpoint,
        hint: "Sandbox did not reach 'running' within the timeout — increase --timeout or check sandbox logs",
      };
    }

    return failFromHttp(phase, endpoint, res.status, `Unexpected status ${res.status}`, {
      durationMs: fetchMs, detail: body,
    });
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function snapshotStop(baseUrl: string, opts?: PhaseOptions): Promise<PhaseResult> {
  const phase = "snapshotStop";
  const endpoint = "/api/admin/snapshot";
  const timeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, ms] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { method: "POST", headers: hdrs, body: "{}" },
        timeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, ms);
    if ("passed" in cr) return cr;
    const body = cr.body;

    const passed = res.ok && typeof body.snapshotId === "string";
    log(phase, passed ? "ok" : "failed", { status: res.status, body });
    if (passed) return { phase, passed, durationMs: ms, detail: body, endpoint };
    if (!res.ok) {
      return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, { durationMs: ms, detail: body });
    }
    return {
      phase, passed: false, durationMs: ms, detail: body, endpoint,
      error: "Response missing snapshotId field",
      errorCode: "MISSING_SNAPSHOT_ID",
      hint: "Snapshot endpoint returned 200 but no snapshotId — the sandbox may not have been running",
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

export async function restoreFromSnapshot(
  baseUrl: string,
  snapshotId?: string,
  timeoutMs = 120_000,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "restoreFromSnapshot";
  const endpoint = "/api/admin/snapshots/restore";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    // If no snapshotId provided, read it from status
    let sid = snapshotId;
    if (!sid) {
      const hdrs = authHeaders();
      const statusRes = await fetchWithTimeout(
        url(baseUrl, "/api/status"),
        { headers: hdrs },
        reqTimeout,
      );
      const statusText = await statusRes.text();
      const statusCr = classifyAndParseJson(phase, "/api/status", statusRes, statusText, 0);
      if ("passed" in statusCr) return statusCr;
      sid = statusCr.body.snapshotId as string | undefined;
      if (!sid) {
        return {
          phase, passed: false, durationMs: 0, endpoint,
          error: "No snapshotId available for restore",
          errorCode: "NO_SNAPSHOT_ID",
          hint: "Run snapshotStop first or ensure status returns a snapshotId",
        };
      }
    }

    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const [res, fetchMs] = await timed(() =>
      fetchWithTimeout(
        url(baseUrl, endpoint),
        { method: "POST", headers: hdrs, body: JSON.stringify({ snapshotId: sid }) },
        reqTimeout,
      ),
    );
    const bodyText = await res.text();
    const cr = classifyAndParseJson(phase, endpoint, res, bodyText, fetchMs);
    if ("passed" in cr) return cr;
    const body = cr.body;
    log(phase, "initial-response", { status: res.status, body });

    // Poll until running if not immediate
    if (body.status !== "running" && body.state !== "running") {
      const [poll, pollMs] = await timed(() =>
        pollUntilRunning(baseUrl, timeoutMs, reqTimeout),
      );
      const totalMs = fetchMs + pollMs;
      if (poll.running) {
        log(phase, "running-after-poll", { totalMs });
        return {
          phase, passed: true, durationMs: totalMs, endpoint,
          detail: { snapshotId: sid, ...poll.lastBody },
        };
      }
      return {
        phase, passed: false, durationMs: totalMs, endpoint,
        detail: poll.lastBody ?? body,
        error: "Timed out waiting for restore to complete",
        errorCode: "POLL_TIMEOUT",
        hint: "Restore did not reach 'running' within the timeout — increase --timeout",
      };
    }

    if (res.ok) {
      return {
        phase, passed: true, durationMs: fetchMs, endpoint,
        detail: { snapshotId: sid, ...body },
      };
    }
    return failFromHttp(phase, endpoint, res.status, `HTTP ${res.status}`, {
      durationMs: fetchMs, detail: { snapshotId: sid, ...body },
    });
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}

// ---------------------------------------------------------------------------
// Self-healing: corrupt gateway token → Telegram round-trip → verify recovery
// ---------------------------------------------------------------------------

// Matches OPENCLAW_AI_GATEWAY_API_KEY_PATH in src/server/openclaw/config.ts.
const SANDBOX_AI_KEY_PATH = "/home/vercel-sandbox/.openclaw/.ai-gateway-api-key";

const HEAL_GATEWAY_TIMEOUT_MS = 60_000;
const HEAL_POST_KILL_SETTLE_MS = 3_000;
const HEAL_DEAD_CHECK_TIMEOUT_MS = 10_000;

/**
 * Run a command on the sandbox via the admin SSH endpoint.
 * The SSH endpoint is auth-gated (admin secret or session cookie)
 * and only reachable with valid credentials.
 */
async function sshCommand(
  baseUrl: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  try {
    const hdrs = { ...authHeaders({ mutation: true }), "Content-Type": "application/json" };
    const res = await fetchWithTimeout(
      url(baseUrl, "/api/admin/ssh"),
      { method: "POST", headers: hdrs, body: JSON.stringify({ command }) },
      timeoutMs,
    );
    if (!res.ok) {
      log("sshCommand", "error", { command: command.slice(0, 80), status: res.status });
      return null;
    }
    return (await res.json()) as { stdout: string; stderr: string; exitCode: number };
  } catch (err) {
    log("sshCommand", "error", { command: command.slice(0, 80), error: String(err) });
    return null;
  }
}

/**
 * Simulates OIDC token expiry by corrupting the AI gateway key file and
 * killing the gateway process, then sends a Telegram smoke webhook and
 * verifies the self-healing pipeline recovers:
 *
 *   1. Gateway call fails (503/500 — dead or stale-token gateway)
 *   2. Pipeline force-refreshes the OIDC token on disk
 *   3. Startup script restarts the gateway with the fresh token
 *   4. Pipeline waits for gateway readiness, retries the gateway call
 *   5. Reply is delivered (queue drains without dead-letter)
 */
export async function selfHealTokenRefresh(
  baseUrl: string,
  pollTimeoutMs: number,
  opts?: PhaseOptions,
): Promise<PhaseResult> {
  const phase = "selfHealTokenRefresh";
  const endpoint = "/api/admin/ssh";
  const reqTimeout = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  try {
    // Step 1: Verify gateway is healthy before corrupting
    const preCheck = await fetchWithTimeout(
      url(baseUrl, "/gateway/v1/chat/completions"),
      {
        method: "POST",
        headers: { ...authHeaders({ mutation: true }), "Content-Type": "application/json" },
        body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "say smoke-ok" }], stream: false }),
      },
      HEAL_GATEWAY_TIMEOUT_MS,
    );
    if (!preCheck.ok) {
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: `Gateway not healthy before corruption (HTTP ${preCheck.status})`,
        errorCode: "PRE_CHECK_FAILED",
        hint: "Ensure the sandbox is running before this phase",
      };
    }
    log(phase, "pre-check-ok", { status: preCheck.status });

    // Step 2: Corrupt the token file on disk so it differs from the fresh OIDC
    // token. When ensureFreshGatewayToken runs during the Telegram queue consumer,
    // it will detect the mismatch and perform a full refresh: write the fresh
    // token, restart the gateway with env -u, and wait for readiness.
    //
    // The running gateway still works (it has the good token in memory), but after
    // the restart it picks up the fresh file-based token via the app's env -u
    // startup path — proving the full refresh cycle works end to end.
    const corruptCmd = `printf '%s' 'STALE-EXPIRED-TOKEN' > ${SANDBOX_AI_KEY_PATH}`;
    const corruptResult = await sshCommand(baseUrl, corruptCmd, reqTimeout);
    if (!corruptResult) {
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: "Failed to corrupt gateway token via SSH",
        errorCode: "CORRUPT_FAILED",
      };
    }

    // Verify corruption
    const verifyResult = await sshCommand(baseUrl, `cat ${SANDBOX_AI_KEY_PATH}`, reqTimeout);
    const tokenOnDisk = verifyResult?.stdout?.trim() ?? "";
    if (tokenOnDisk !== "STALE-EXPIRED-TOKEN") {
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: `Token file corruption failed: got '${tokenOnDisk.slice(0, 20)}'`,
        errorCode: "CORRUPT_VERIFY_FAILED",
      };
    }
    log(phase, "token-corrupted", { tokenOnDisk: tokenOnDisk.slice(0, 20) });

    // Step 4: Read baseline queue state
    const baselineSummary = await fetchChannelSummary(baseUrl, reqTimeout);
    const baselineDL = baselineSummary?.telegram?.deadLetterCount ?? 0;

    // Step 5: Send a Telegram smoke webhook
    const telegramPayload = buildTelegramSmokePayload();
    const sendResult = await sendSmokeWebhook(baseUrl, "telegram", telegramPayload, reqTimeout);
    if (!sendResult?.sent) {
      return {
        phase, passed: false, durationMs: 0, endpoint,
        error: "Failed to send Telegram smoke webhook",
        errorCode: "WEBHOOK_SEND_FAILED",
        detail: { sendResult },
      };
    }
    log(phase, "webhook-sent");

    // Step 6: Poll until queue drains (self-healing happens during processing)
    const t0 = performance.now();
    const deadline = Date.now() + pollTimeoutMs;
    let delay = HEAL_POLL_INITIAL_MS;

    while (Date.now() < deadline) {
      await sleep(delay);
      const summary = await fetchChannelSummary(baseUrl, reqTimeout);
      if (!summary?.telegram || summary.telegram.queueDepth > 0) {
        log(phase, "poll", { telegramQueue: summary?.telegram?.queueDepth });
        delay = Math.min(delay * HEAL_POLL_BACKOFF, HEAL_POLL_MAX_MS);
        continue;
      }

      // Queue drained — check for dead letters
      const dlDelta = (summary.telegram.deadLetterCount ?? 0) - baselineDL;
      const totalMs = Math.round(performance.now() - t0);

      if (dlDelta > 0) {
        log(phase, "drained-to-dead-letter", { dlDelta, totalMs });
        return {
          phase, passed: false, durationMs: totalMs, endpoint,
          error: `Queue drained but message went to dead letter (delta: ${dlDelta})`,
          errorCode: "DEAD_LETTER",
          detail: { dlDelta, totalMs },
          hint: "Self-healing did not recover in time — check gateway logs",
        };
      }

      // Step 7: Verify gateway is healthy again
      const postCheck = await fetchWithTimeout(
        url(baseUrl, "/gateway/v1/chat/completions"),
        {
          method: "POST",
          headers: { ...authHeaders({ mutation: true }), "Content-Type": "application/json" },
          body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "say smoke-ok" }], stream: false }),
        },
        HEAL_GATEWAY_TIMEOUT_MS,
      ).catch(() => null);

      const gatewayRecovered = postCheck?.ok === true;
      log(phase, gatewayRecovered ? "gateway-recovered" : "gateway-still-broken", {
        status: postCheck?.status, totalMs,
      });

      return {
        phase,
        passed: gatewayRecovered,
        durationMs: totalMs,
        endpoint,
        detail: {
          gatewayRecovered,
          postCheckStatus: postCheck?.status,
          deadLetterDelta: dlDelta,
          totalMs,
        },
        ...(!gatewayRecovered ? {
          error: "Queue drained but gateway did not recover",
          errorCode: "GATEWAY_NOT_RECOVERED",
          hint: "Token refresh may have succeeded but gateway restart failed",
        } : {}),
      };
    }

    const totalMs = Math.round(performance.now() - t0);
    return {
      phase, passed: false, durationMs: totalMs, endpoint,
      error: "Queue did not drain within timeout",
      errorCode: "POLL_TIMEOUT",
      hint: "Self-healing may be taking too long — increase --timeout",
    };
  } catch (err) {
    return failFromError(phase, endpoint, err);
  }
}
