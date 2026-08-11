import { APIError, Sandbox } from '@vercel/sandbox';

/**
 * Wake path per docs/suspension-spec.md: resume (or create) the sandbox,
 * make sure the gateway process is running, and return the exposed-port URL
 * the host forwards traffic to.
 *
 * The host runs OUTSIDE the sandbox, so the forwarding URL is always
 * sandbox.domain(GATEWAY_PORT) — never localhost. The gateway's default
 * loopback bind is fine: exposed-port routing reaches loopback-bound
 * listeners (verified 2026-08-11, see docs/suspension-spec.md).
 */

export const GATEWAY_PORT = 3000;
const DEFAULT_IMAGE = 'openclaw-foundation/openclaw/openclaw:latest';
const GATEWAY_LOG = '/tmp/openclaw-gateway.log';

// 75 min platform backstop, 15 min behind the graceful path. Requires a
// Pro/Enterprise team: the Hobby max session length is 45 minutes.
export const SESSION_TIMEOUT_MS = 75 * 60 * 1000;

// image_not_ready is thrown while VCR prepares an optimized amd64 build after
// a push. It happens at create/resume time, not when forwarding payloads.
const IMAGE_READY_RETRIES = 6;
const IMAGE_READY_DELAY_MS = 10_000;

// The whole wake is budgeted against one deadline so diagnostics (the gateway
// log tail) are emitted before the serverless function itself is killed.
const WAKE_BUDGET_MS = 240_000;
const HEALTH_DELAY_MS = 5_000;
const HEALTH_CACHE_MS = 30_000;

export interface AwakeGateway {
  sandbox: Sandbox;
  /** Public exposed-port URL for forwarding into the gateway. */
  baseUrl: string;
}

// Dampens concurrent webhook bursts: one wake per sandbox name per instance,
// and a short-lived "recently healthy" cache to skip per-message probes.
const inflight = new Map<string, Promise<AwakeGateway>>();
const lastHealthyAt = new Map<string, number>();

export function ensureAwake(name: string): Promise<AwakeGateway> {
  const existing = inflight.get(name);
  if (existing) return existing;
  const attempt = ensureAwakeUncached(name).finally(() => inflight.delete(name));
  inflight.set(name, attempt);
  return attempt;
}

async function ensureAwakeUncached(name: string): Promise<AwakeGateway> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');

  const image = process.env.OPENCLAW_IMAGE ?? DEFAULT_IMAGE;
  const deadline = Date.now() + WAKE_BUDGET_MS;

  let sandbox: Sandbox | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      sandbox = await Sandbox.getOrCreate({
        name,
        image,
        persistent: true,
        timeout: SESSION_TIMEOUT_MS,
        ports: [GATEWAY_PORT],
        onCreate: async (sbx) => startGateway(sbx, token),
        // Fires on every session resume: processes die on stop, only disk
        // survives, so the gateway must be restarted.
        onResume: async (sbx) => startGateway(sbx, token),
      });
      break;
    } catch (err) {
      // The SDK carries structured codes at err.json.error.code, not in
      // err.message (which defaults to "").
      const code =
        err instanceof APIError
          ? (err.json as { error?: { code?: string } } | undefined)?.error?.code
          : undefined;
      if (
        code === 'image_not_ready' &&
        attempt < IMAGE_READY_RETRIES &&
        Date.now() + IMAGE_READY_DELAY_MS < deadline
      ) {
        await sleep(IMAGE_READY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }

  // getOrCreate retrieves without resuming; the session resumes on the first
  // SDK call (such as runCommand) and onResume runs at that point — per the
  // SDK reference (vercel.com/docs/sandbox/sdk-reference, getOrCreate).
  await waitForGatewayHealth(name, sandbox, token, deadline);
  return { sandbox, baseUrl: sandbox.domain(GATEWAY_PORT) };
}

export async function startGateway(sandbox: Sandbox, token: string): Promise<void> {
  // Output goes to a log file so failures are diagnosable after the fact
  // (a detached command's own stdio is not otherwise retained). Truncate on
  // each start: /tmp is on the snapshotted disk and survives resumes.
  await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `openclaw gateway run --allow-unconfigured --auth token --port ${GATEWAY_PORT} > ${GATEWAY_LOG} 2>&1`,
    ],
    env: { OPENCLAW_GATEWAY_TOKEN: token },
    detached: true,
  });
}

/**
 * The gateway is a WebSocket server; there is no confirmed HTTP /health
 * route. Health is checked with OpenClaw's own CLI from inside the sandbox:
 * `openclaw gateway call health` (verified against 2026.7.2-beta.7). The
 * token travels via env, not argv, so it never shows in the process table.
 */
async function waitForGatewayHealth(
  name: string,
  sandbox: Sandbox,
  token: string,
  deadline: number,
): Promise<void> {
  const cached = lastHealthyAt.get(name);
  if (cached && Date.now() - cached < HEALTH_CACHE_MS) return;

  let restartAttempted = false;
  while (true) {
    const result = await sandbox.runCommand({
      cmd: 'openclaw',
      args: [
        'gateway',
        'call',
        'health',
        '--url',
        `ws://127.0.0.1:${GATEWAY_PORT}`,
        '--json',
        '--timeout',
        '5000',
      ],
      env: { OPENCLAW_GATEWAY_TOKEN: token },
    });
    if (result.exitCode === 0) {
      lastHealthyAt.set(name, Date.now());
      return;
    }
    // Covers the sandbox-already-running case where neither onCreate nor
    // onResume fired but the gateway died (crash, manual kill), and the
    // partial-create case where onCreate threw after the sandbox existed.
    if (!restartAttempted) {
      restartAttempted = true;
      await startGateway(sandbox, token);
    }
    if (Date.now() + HEALTH_DELAY_MS >= deadline) break;
    await sleep(HEALTH_DELAY_MS);
  }
  // Surface the gateway's own log, not just the failed health probe.
  const log = await sandbox.runCommand('sh', ['-c', `tail -20 ${GATEWAY_LOG} 2>/dev/null`]);
  throw new Error(
    `gateway did not become healthy within the wake budget. gateway log tail:\n${(await log.stdout()).slice(-1000)}`,
  );
}

/** Hop-by-hop / transport headers that must not be blindly forwarded. */
const STRIP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'keep-alive',
  'upgrade',
  'expect',
]);

/**
 * Forward a webhook into the gateway's native channel handler.
 *
 * Channel handlers verify signatures over the exact bytes and headers the
 * sender produced (e.g. Slack's x-slack-signature + x-slack-request-timestamp
 * over the raw body), so the body is forwarded as untouched bytes and the
 * original headers pass through minus hop-by-hop ones.
 */
export async function forwardPayload(
  baseUrl: string,
  path: string,
  options: {
    rawBody: ArrayBuffer | string;
    headers: Headers;
    channel: string;
    receivedAt?: number;
  },
): Promise<Response> {
  const headers = new Headers();
  options.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('x-openclaw-channel', options.channel);
  headers.set('x-received-at', String(options.receivedAt ?? Date.now()));

  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers,
    body: options.rawBody,
    signal: AbortSignal.timeout(10_000),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
