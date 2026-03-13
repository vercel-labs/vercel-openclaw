/**
 * Route invocation helpers for Next.js App Router route handlers.
 *
 * Collects `after()` callbacks scheduled by route handlers so tests
 * can execute them synchronously after the response is returned.
 *
 * Also provides `patchNextServerAfter()` which replaces the `after`
 * export on the `next/server` CJS module with `capturedAfter`, so
 * that route handlers loaded *after* the patch use the test version.
 */

type AfterCallback = () => Promise<void> | void;

let pendingAfterCallbacks: AfterCallback[] = [];

/**
 * Replacement for `next/server`'s `after()` that captures
 * callbacks instead of scheduling them in the background.
 *
 * Tests call `drainAfterCallbacks()` to run them.
 */
export function capturedAfter(callback: AfterCallback): void {
  pendingAfterCallbacks.push(callback);
}

/**
 * Execute all captured `after()` callbacks in order,
 * then clear the queue.
 *
 * Each callback is raced against a timeout (default 10 s).
 * Timed-out callbacks are detached — their unhandled rejections
 * are suppressed and the timer is `unref`'d so it cannot prevent
 * the process from exiting.  This mirrors the best-effort
 * semantics of the real `after()` in production.
 */
export async function drainAfterCallbacks(timeoutMs = 10_000): Promise<void> {
  const callbacks = [...pendingAfterCallbacks];
  pendingAfterCallbacks = [];
  for (const cb of callbacks) {
    const result = Promise.resolve(cb());
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    await Promise.race([result, timeout]);
    // Suppress unhandled rejection from any detached callback.
    result.catch(() => {});
  }
}

/**
 * Discard all pending `after()` callbacks without running them.
 */
export function resetAfterCallbacks(): void {
  pendingAfterCallbacks = [];
}

/**
 * Return the number of pending `after()` callbacks.
 */
export function pendingAfterCount(): number {
  return pendingAfterCallbacks.length;
}

// ---------------------------------------------------------------------------
// Route handler invocation
// ---------------------------------------------------------------------------

type RouteHandler = (request: Request) => Promise<Response> | Response;

export type RouteCallResult = {
  response: Response;
  status: number;
  /** Parsed JSON body (null if parsing fails). */
  json: unknown;
  /** Raw text body. */
  text: string;
};

/**
 * Invoke a Next.js route handler POST function and collect results.
 *
 * Does NOT automatically drain `after()` callbacks — call
 * `drainAfterCallbacks()` explicitly when you want background
 * work to execute.
 */
export async function callRoute(
  handler: RouteHandler,
  request: Request,
): Promise<RouteCallResult> {
  const response = await handler(request);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON — that's fine.
  }

  return {
    response,
    status: response.status,
    json,
    text,
  };
}

/**
 * Build a POST Request to a local route path.
 *
 * @param path - Route path, e.g. "/api/channels/slack/webhook"
 * @param body - String body (already serialised JSON or raw text)
 * @param headers - Additional headers
 */
export function buildPostRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

/**
 * Build a GET Request to a local route path.
 */
export function buildGetRequest(
  path: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "GET",
    headers: headers ?? {},
  });
}

// ---------------------------------------------------------------------------
// next/server patching for route-level tests
// ---------------------------------------------------------------------------

let patched = false;

/**
 * Replace `after` on the `next/server` CJS module object with
 * `capturedAfter`.  Must be called **before** any route handler
 * module is `require()`-d so the patched binding is what gets used.
 *
 * Safe to call multiple times — only patches once.
 */
export function patchNextServerAfter(): void {
  if (patched) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ns = require("next/server");
  ns.after = capturedAfter;
  patched = true;
}

// ---------------------------------------------------------------------------
// Route handler lazy loaders
// ---------------------------------------------------------------------------

/**
 * Gateway route handler type: each export takes (request, { params })
 * where params is a Promise.
 */
type GatewayRouteHandler = (
  request: Request,
  ctx: { params: Promise<{ path?: string[] }> },
) => Promise<Response>;

type GatewayRouteModule = {
  GET: GatewayRouteHandler;
  POST: GatewayRouteHandler;
  PUT: GatewayRouteHandler;
  PATCH: GatewayRouteHandler;
  DELETE: GatewayRouteHandler;
  HEAD: GatewayRouteHandler;
  OPTIONS: GatewayRouteHandler;
};

let _gatewayRoute: GatewayRouteModule | null = null;

/**
 * Lazily require the gateway route handler module.
 * Ensures `patchNextServerAfter()` is called first.
 */
export function getGatewayRoute(): GatewayRouteModule {
  if (!_gatewayRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _gatewayRoute = require("@/app/gateway/[[...path]]/route") as GatewayRouteModule;
  }
  return _gatewayRoute;
}

type AdminRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

let _adminEnsureRoute: AdminRouteModule | null = null;
let _adminStopRoute: AdminRouteModule | null = null;

export function getAdminEnsureRoute(): AdminRouteModule {
  if (!_adminEnsureRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminEnsureRoute = require("@/app/api/admin/ensure/route") as AdminRouteModule;
  }
  return _adminEnsureRoute;
}

export function getAdminStopRoute(): AdminRouteModule {
  if (!_adminStopRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminStopRoute = require("@/app/api/admin/stop/route") as AdminRouteModule;
  }
  return _adminStopRoute;
}

type ChannelRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

let _slackWebhookRoute: ChannelRouteModule | null = null;
let _telegramWebhookRoute: ChannelRouteModule | null = null;
let _discordWebhookRoute: ChannelRouteModule | null = null;

export function getSlackWebhookRoute(): ChannelRouteModule {
  if (!_slackWebhookRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _slackWebhookRoute = require("@/app/api/channels/slack/webhook/route") as ChannelRouteModule;
  }
  return _slackWebhookRoute;
}

export function getTelegramWebhookRoute(): ChannelRouteModule {
  if (!_telegramWebhookRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _telegramWebhookRoute = require("@/app/api/channels/telegram/webhook/route") as ChannelRouteModule;
  }
  return _telegramWebhookRoute;
}

export function getDiscordWebhookRoute(): ChannelRouteModule {
  if (!_discordWebhookRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _discordWebhookRoute = require("@/app/api/channels/discord/webhook/route") as ChannelRouteModule;
  }
  return _discordWebhookRoute;
}

// ---------------------------------------------------------------------------
// Additional route lazy loaders
// ---------------------------------------------------------------------------

type SimpleRouteModule = {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
  PUT?: (request: Request) => Promise<Response>;
  DELETE?: (request: Request) => Promise<Response>;
};

let _healthRoute: SimpleRouteModule | null = null;
let _statusRoute: SimpleRouteModule | null = null;
let _adminSnapshotRoute: SimpleRouteModule | null = null;
let _adminSshRoute: SimpleRouteModule | null = null;
let _adminSnapshotsRoute: SimpleRouteModule | null = null;
let _adminLogsRoute: SimpleRouteModule | null = null;
let _firewallRoute: SimpleRouteModule | null = null;
let _firewallDiagnosticsRoute: SimpleRouteModule | null = null;
let _firewallTestRoute: SimpleRouteModule | null = null;
let _firewallAllowlistRoute: SimpleRouteModule | null = null;
let _firewallPromoteRoute: SimpleRouteModule | null = null;
let _firewallLearnedRoute: SimpleRouteModule | null = null;
let _firewallReportRoute: SimpleRouteModule | null = null;
let _cronDrainRoute: SimpleRouteModule | null = null;
let _channelsSummaryRoute: SimpleRouteModule | null = null;
let _authAuthorizeRoute: SimpleRouteModule | null = null;
let _authCallbackRoute: SimpleRouteModule | null = null;
let _authSignoutRoute: SimpleRouteModule | null = null;
let _adminRestoreRoute: AdminRouteModule | null = null;

export function getHealthRoute(): SimpleRouteModule {
  if (!_healthRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _healthRoute = require("@/app/api/health/route") as SimpleRouteModule;
  }
  return _healthRoute;
}

export function getStatusRoute(): SimpleRouteModule {
  if (!_statusRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _statusRoute = require("@/app/api/status/route") as SimpleRouteModule;
  }
  return _statusRoute;
}

export function getAdminSnapshotRoute(): SimpleRouteModule {
  if (!_adminSnapshotRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminSnapshotRoute = require("@/app/api/admin/snapshot/route") as SimpleRouteModule;
  }
  return _adminSnapshotRoute;
}

export function getAdminSshRoute(): SimpleRouteModule {
  if (!_adminSshRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminSshRoute = require("@/app/api/admin/ssh/route") as SimpleRouteModule;
  }
  return _adminSshRoute;
}

export function getAdminSnapshotsRoute(): SimpleRouteModule {
  if (!_adminSnapshotsRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminSnapshotsRoute = require("@/app/api/admin/snapshots/route") as SimpleRouteModule;
  }
  return _adminSnapshotsRoute;
}

export function getAdminLogsRoute(): SimpleRouteModule {
  if (!_adminLogsRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminLogsRoute = require("@/app/api/admin/logs/route") as SimpleRouteModule;
  }
  return _adminLogsRoute;
}

export function getFirewallRoute(): SimpleRouteModule {
  if (!_firewallRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallRoute = require("@/app/api/firewall/route") as SimpleRouteModule;
  }
  return _firewallRoute;
}

export function getFirewallDiagnosticsRoute(): SimpleRouteModule {
  if (!_firewallDiagnosticsRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallDiagnosticsRoute = require("@/app/api/firewall/diagnostics/route") as SimpleRouteModule;
  }
  return _firewallDiagnosticsRoute;
}

export function getFirewallTestRoute(): SimpleRouteModule {
  if (!_firewallTestRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallTestRoute = require("@/app/api/firewall/test/route") as SimpleRouteModule;
  }
  return _firewallTestRoute;
}

export function getCronDrainRoute(): SimpleRouteModule {
  if (!_cronDrainRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _cronDrainRoute = require("@/app/api/cron/drain-channels/route") as SimpleRouteModule;
  }
  return _cronDrainRoute;
}

export function getChannelsSummaryRoute(): SimpleRouteModule {
  if (!_channelsSummaryRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _channelsSummaryRoute = require("@/app/api/channels/summary/route") as SimpleRouteModule;
  }
  return _channelsSummaryRoute;
}

export function getFirewallAllowlistRoute(): SimpleRouteModule {
  if (!_firewallAllowlistRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallAllowlistRoute = require("@/app/api/firewall/allowlist/route") as SimpleRouteModule;
  }
  return _firewallAllowlistRoute;
}

export function getFirewallLearnedRoute(): SimpleRouteModule {
  if (!_firewallLearnedRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallLearnedRoute = require("@/app/api/firewall/learned/route") as SimpleRouteModule;
  }
  return _firewallLearnedRoute;
}

export function getFirewallReportRoute(): SimpleRouteModule {
  if (!_firewallReportRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallReportRoute = require("@/app/api/firewall/report/route") as SimpleRouteModule;
  }
  return _firewallReportRoute;
}

export function getFirewallPromoteRoute(): SimpleRouteModule {
  if (!_firewallPromoteRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _firewallPromoteRoute = require("@/app/api/firewall/promote/route") as SimpleRouteModule;
  }
  return _firewallPromoteRoute;
}

export function getAuthAuthorizeRoute(): SimpleRouteModule {
  if (!_authAuthorizeRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _authAuthorizeRoute = require("@/app/api/auth/authorize/route") as SimpleRouteModule;
  }
  return _authAuthorizeRoute;
}

export function getAuthCallbackRoute(): SimpleRouteModule {
  if (!_authCallbackRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _authCallbackRoute = require("@/app/api/auth/callback/route") as SimpleRouteModule;
  }
  return _authCallbackRoute;
}

export function getAuthSignoutRoute(): SimpleRouteModule {
  if (!_authSignoutRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _authSignoutRoute = require("@/app/api/auth/signout/route") as SimpleRouteModule;
  }
  return _authSignoutRoute;
}

export function getAdminRestoreRoute(): AdminRouteModule {
  if (!_adminRestoreRoute) {
    patchNextServerAfter();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _adminRestoreRoute = require("@/app/api/admin/snapshots/restore/route") as AdminRouteModule;
  }
  return _adminRestoreRoute;
}

let _slackManifestRoute: SimpleRouteModule | null = null;
let _slackTestRoute: SimpleRouteModule | null = null;
let _telegramPreviewRoute: SimpleRouteModule | null = null;
let _discordRegisterCommandRoute: SimpleRouteModule | null = null;

export function getSlackManifestRoute(): SimpleRouteModule {
  if (!_slackManifestRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _slackManifestRoute = require("@/app/api/channels/slack/manifest/route") as SimpleRouteModule;
  }
  return _slackManifestRoute;
}

export function getSlackTestRoute(): SimpleRouteModule {
  if (!_slackTestRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _slackTestRoute = require("@/app/api/channels/slack/test/route") as SimpleRouteModule;
  }
  return _slackTestRoute;
}

export function getTelegramPreviewRoute(): SimpleRouteModule {
  if (!_telegramPreviewRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _telegramPreviewRoute = require("@/app/api/channels/telegram/preview/route") as SimpleRouteModule;
  }
  return _telegramPreviewRoute;
}

export function getDiscordRegisterCommandRoute(): SimpleRouteModule {
  if (!_discordRegisterCommandRoute) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _discordRegisterCommandRoute = require("@/app/api/channels/discord/register-command/route") as SimpleRouteModule;
  }
  return _discordRegisterCommandRoute;
}

// ---------------------------------------------------------------------------
// Request builders for PUT/DELETE
// ---------------------------------------------------------------------------

export function buildPutRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

export function buildDeleteRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// CSRF-authenticated request builders
// ---------------------------------------------------------------------------

export function buildAuthPostRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return buildPostRequest(path, body, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
    ...headers,
  });
}

export function buildAuthGetRequest(
  path: string,
  headers?: Record<string, string>,
): Request {
  return buildGetRequest(path, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
    ...headers,
  });
}

export function buildAuthPutRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return buildPutRequest(path, body, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
    ...headers,
  });
}

export function buildAuthDeleteRequest(
  path: string,
  body: string,
  headers?: Record<string, string>,
): Request {
  return buildDeleteRequest(path, body, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
    ...headers,
  });
}

// ---------------------------------------------------------------------------
// Higher-level helpers for common route calls
// ---------------------------------------------------------------------------

/**
 * Call the gateway GET handler with the given sub-path.
 * Auth mode should already be configured (e.g. deployment-protection).
 */
export async function callGatewayGet(
  subPath = "/",
  headers?: Record<string, string>,
): Promise<RouteCallResult> {
  const mod = getGatewayRoute();
  const pathSegments = subPath === "/" ? [] : subPath.replace(/^\//, "").split("/");
  const request = buildGetRequest(`/gateway${subPath === "/" ? "" : subPath}`, headers);
  const response = await mod.GET(request, {
    params: Promise.resolve({ path: pathSegments.length ? pathSegments : undefined }),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { response, status: response.status, json, text };
}

/**
 * Call any gateway method handler with the given sub-path.
 * Auth mode should already be configured (e.g. deployment-protection).
 */
export async function callGatewayMethod(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
  subPath = "/",
  options?: { body?: string; headers?: Record<string, string> },
): Promise<RouteCallResult> {
  const mod = getGatewayRoute();
  const pathSegments = subPath === "/" ? [] : subPath.replace(/^\//, "").split("/");
  const url = `http://localhost:3000/gateway${subPath === "/" ? "" : subPath}`;
  const init: RequestInit = {
    method,
    headers: options?.headers ?? {},
  };
  if (options?.body && !["GET", "HEAD"].includes(method)) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = options.body;
  }
  const request = new Request(url, init);
  const handler = mod[method] as GatewayRouteHandler;
  const response = await handler(request, {
    params: Promise.resolve({ path: pathSegments.length ? pathSegments : undefined }),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { response, status: response.status, json, text };
}

/**
 * Call an admin POST route with CSRF headers set correctly.
 */
export async function callAdminPost(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body = "{}",
): Promise<RouteCallResult> {
  const request = buildPostRequest(path, body, {
    origin: "http://localhost:3000",
    "x-requested-with": "XMLHttpRequest",
  });
  return callRoute(handler, request);
}
