import { APIError, Sandbox } from '@vercel/sandbox';
import {
  buildOpenClawRuntime,
  OPENCLAW_SLACK_PLUGIN,
  VERCEL_AI_GATEWAY_PLUGIN,
  type OpenClawRuntime,
} from './openclaw-runtime';

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
const RUNTIME_MARKER = '/tmp/vercel-openclaw-runtime-fingerprint';
const RUNTIME_LOCK = '/tmp/vercel-openclaw-runtime.lock';

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

export function ensureAwake(
  name: string,
  options: { aiGatewayCredential?: string } = {},
): Promise<AwakeGateway> {
  const existing = inflight.get(name);
  if (existing) return existing;
  const attempt = ensureAwakeUncached(name, options).finally(() =>
    inflight.delete(name),
  );
  inflight.set(name, attempt);
  return attempt;
}

async function ensureAwakeUncached(
  name: string,
  options: { aiGatewayCredential?: string },
): Promise<AwakeGateway> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');
  const runtime = buildOpenClawRuntime(process.env, token, options);

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

  // The first command also resumes a stopped persistent VM. Include Linux's
  // boot ID in the marker so a new session can never mistake a snapshot's old
  // marker for a running gateway.
  const bootId = await readSandboxBootId(sandbox);
  const desiredMarker = `${runtime.fingerprint}:${bootId}`;
  const spawnedFresh = await ensureRuntimeReady(
    name,
    sandbox,
    token,
    runtime,
    desiredMarker,
    deadline,
  );

  // getOrCreate retrieves without resuming; the session resumes on the first
  // SDK call (such as runCommand) and onResume runs at that point — per the
  // SDK reference (vercel.com/docs/sandbox/sdk-reference, getOrCreate).
  await waitForGatewayHealth(name, sandbox, token, deadline, () => spawnedFresh);
  return { sandbox, baseUrl: sandbox.domain(GATEWAY_PORT) };
}

export async function startGateway(
  sandbox: Sandbox,
  token: string,
  opts: { appendLog?: boolean; runtime?: OpenClawRuntime } = {},
): Promise<void> {
  const runtime = opts.runtime ?? buildOpenClawRuntime(process.env, token);

  if (runtime.needsSlackPlugin) {
    await ensurePluginInstalled(
      sandbox,
      OPENCLAW_SLACK_PLUGIN,
      "*/node_modules/@openclaw/slack/package.json",
      'OpenClaw Slack',
      runtime.gatewayEnv,
    );
  }
  if (runtime.needsAiGatewayPlugin) {
    await ensurePluginInstalled(
      sandbox,
      VERCEL_AI_GATEWAY_PLUGIN,
      "*/node_modules/@openclaw/vercel-ai-gateway-provider/package.json",
      'Vercel AI Gateway',
      runtime.gatewayEnv,
    );
  }
  if (runtime.configOperations.length > 0) {
    const configured = await sandbox.runCommand({
      cmd: 'openclaw',
      args: [
        'config',
        'set',
        '--batch-json',
        JSON.stringify(runtime.configOperations),
      ],
      env: runtime.gatewayEnv,
    });
    if (configured.exitCode !== 0) {
      const detail = await commandOutput(configured);
      throw new Error(`OpenClaw runtime configuration failed: ${detail}`);
    }
  }

  // Output goes to a log file so failures are diagnosable after the fact
  // (a detached command's own stdio is not otherwise retained). Primary
  // starts truncate (/tmp is on the snapshotted disk and survives resumes);
  // fallback restarts append so they can't destroy the first attempt's log.
  const redirect = opts.appendLog ? '>>' : '>';
  await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `openclaw gateway run --allow-unconfigured --auth token --port ${GATEWAY_PORT} ${redirect} ${GATEWAY_LOG} 2>&1`,
    ],
    env: runtime.gatewayEnv,
    detached: true,
  });
}

async function ensurePluginInstalled(
  sandbox: Sandbox,
  packageSpec: string,
  packagePath: string,
  label: string,
  env: Record<string, string>,
): Promise<void> {
  const installed = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `find /home/node/.openclaw/npm/projects -path '${packagePath}' -print -quit 2>/dev/null | grep -q .`,
    ],
  });
  if (installed.exitCode === 0) return;

  const result = await sandbox.runCommand({
    cmd: 'openclaw',
    args: ['plugins', 'install', packageSpec, '--pin'],
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} plugin installation failed: ${await commandOutput(result)}`);
  }
}

async function ensureRuntimeReady(
  name: string,
  sandbox: Sandbox,
  token: string,
  runtime: OpenClawRuntime,
  desiredMarker: string,
  deadline: number,
): Promise<boolean> {
  if (await isRuntimeReady(sandbox, runtime, desiredMarker)) {
    lastHealthyAt.set(name, Date.now());
    return false;
  }

  await acquireRuntimeLock(sandbox);
  try {
    // Another function instance may have completed startup while this one
    // waited. Re-check under the cross-instance sandbox lock.
    if (await isRuntimeReady(sandbox, runtime, desiredMarker)) {
      lastHealthyAt.set(name, Date.now());
      return false;
    }

    lastHealthyAt.delete(name);
    await stopGateway(sandbox);
    await startGateway(sandbox, token, { appendLog: true, runtime });
    await waitForGatewayHealth(name, sandbox, token, deadline, () => true);
    if (runtime.needsSlackPlugin) await waitForSlackRoute(sandbox);
    await writeRuntimeFingerprint(sandbox, desiredMarker);
    lastHealthyAt.set(name, Date.now());
    return true;
  } finally {
    await releaseRuntimeLock(sandbox);
  }
}

async function isRuntimeReady(
  sandbox: Sandbox,
  runtime: OpenClawRuntime,
  desiredMarker: string,
): Promise<boolean> {
  if ((await readRuntimeFingerprint(sandbox)) !== desiredMarker) return false;
  if (!runtime.needsSlackPlugin) return true;
  return probeSlackRoute(sandbox);
}

async function acquireRuntimeLock(sandbox: Sandbox): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      `for i in $(seq 1 700); do
        mkdir ${RUNTIME_LOCK} 2>/dev/null && exit 0
        if find ${RUNTIME_LOCK} -maxdepth 0 -mmin +2 -print -quit 2>/dev/null | grep -q .; then
          rmdir ${RUNTIME_LOCK} 2>/dev/null || true
        fi
        sleep 0.3
      done
      exit 1`,
    ],
  });
  if (result.exitCode !== 0) {
    throw new Error(`timed out waiting for sandbox runtime lock: ${await commandOutput(result)}`);
  }
}

async function releaseRuntimeLock(sandbox: Sandbox): Promise<void> {
  await sandbox.runCommand('rmdir', [RUNTIME_LOCK]);
}

async function readSandboxBootId(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.runCommand('cat', ['/proc/sys/kernel/random/boot_id']);
  if (result.exitCode !== 0) {
    throw new Error(`could not read sandbox boot ID: ${await commandOutput(result)}`);
  }
  return (await result.stdout()).trim();
}

async function readRuntimeFingerprint(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.runCommand('sh', [
    '-c',
    `cat ${RUNTIME_MARKER} 2>/dev/null || true`,
  ]);
  return (await result.stdout()).trim();
}

async function writeRuntimeFingerprint(
  sandbox: Sandbox,
  fingerprint: string,
): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `umask 077; printf %s "$OPENCLAW_RUNTIME_FINGERPRINT" > ${RUNTIME_MARKER}`,
    ],
    env: { OPENCLAW_RUNTIME_FINGERPRINT: fingerprint },
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not persist runtime fingerprint: ${await commandOutput(result)}`);
  }
}

async function probeSlackRoute(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.runCommand({
    cmd: 'curl',
    args: [
      '-sS',
      '-o',
      '/tmp/slack-route-probe',
      '-w',
      '%{http_code}',
      '-X',
      'POST',
      `http://127.0.0.1:${GATEWAY_PORT}/slack/events`,
      '-H',
      'content-type: application/json',
      '--data',
      '{}',
    ],
  });
  const status = (await result.stdout()).trim();
  return result.exitCode === 0 && status !== '' && status !== '000' && status !== '404';
}

async function waitForSlackRoute(sandbox: Sandbox): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      `for i in $(seq 1 100); do
        status=$(curl -sS -o /tmp/slack-route-probe -w '%{http_code}' -X POST http://127.0.0.1:${GATEWAY_PORT}/slack/events -H 'content-type: application/json' --data '{}' 2>/dev/null || true)
        case "$status" in ''|000|404) ;; *) exit 0 ;; esac
        sleep 0.3
      done
      exit 1`,
    ],
  });
  if (result.exitCode !== 0) {
    const log = await sandbox.runCommand('sh', [
      '-c',
      `tail -30 ${GATEWAY_LOG} 2>/dev/null`,
    ]);
    throw new Error(
      `Slack route did not mount after gateway startup. gateway log tail:\n${(
        await log.stdout()
      ).slice(-1500)}`,
    );
  }
}

async function stopGateway(sandbox: Sandbox): Promise<void> {
  await sandbox.runCommand('sh', [
    '-c',
    "pkill -TERM -f '^openclaw-gateway$' 2>/dev/null || true; sleep 1",
  ]);
}

async function commandOutput(result: {
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}): Promise<string> {
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  return `${stdout}\n${stderr}`.trim().slice(-1500) || 'no command output';
}

/**
 * Two-phase health check, latency-optimized:
 *
 * 1. One in-VM waiter polls the TCP port every 300ms (bash /dev/tcp, no
 *    process spawns) — a single API round trip that returns the moment the
 *    gateway binds, instead of a host-side loop paying a CLI boot plus an
 *    API round trip per 5s probe. This is what took wake times from ~14-19s
 *    to gateway-bound.
 * 2. One `openclaw gateway call health` to confirm the WS protocol answers
 *    with our token (there is no confirmed HTTP /health route).
 *
 * The in-VM waiter also replaces the restart-threshold heuristic: it gives
 * the gateway a full window to bind, so a timeout means genuinely dead, and
 * only then is one restart attempted (log appended, not truncated).
 */
const PORT_WAIT_SECONDS = 30;

async function waitForGatewayHealth(
  name: string,
  sandbox: Sandbox,
  token: string,
  deadline: number,
  spawnedFresh: () => boolean = () => false,
): Promise<void> {
  // Deliberate trade: the cache is per-instance and a gateway that dies
  // inside the 30s window gets one message forwarded into a 502 before the
  // next probe notices. Accepted to avoid a probe round trip per message.
  // Only valid while the session is actually running: after a stop, a cached
  // "healthy" would skip the resume + gateway restart entirely (observed
  // live 2026-08-11 in the e2e: 0.1s "wake" of a stopped sandbox).
  const cached = lastHealthyAt.get(name);
  if (
    !spawnedFresh() &&
    cached &&
    Date.now() - cached < HEALTH_CACHE_MS &&
    sandbox.status === 'running'
  ) {
    return;
  }

  let restartAttempted = false;
  while (true) {
    const bound = await waitForPortBind(sandbox);
    if (bound) {
      // Port bound right after our own spawn (create/resume/restart): that
      // IS the gateway we started with our token; skip the ~3s CLI confirm.
      if (spawnedFresh() || restartAttempted) {
        lastHealthyAt.set(name, Date.now());
        return;
      }
      const result = await sandbox.runCommand({
        cmd: 'openclaw',
        args: [
          'gateway',
          'call',
          'health',
          '--url',
          `ws://127.0.0.1:${GATEWAY_PORT}`,
          // --token must be explicit: with a --url override the CLI refuses
          // env-only credentials ("gateway url override requires explicit
          // credentials", verified live 2026-08-11). argv visibility is
          // acceptable in a single-tenant VM where every process is ours.
          '--token',
          token,
          '--json',
          '--timeout',
          '5000',
        ],
      });
      if (result.exitCode === 0) {
        lastHealthyAt.set(name, Date.now());
        return;
      }
    }
    // Port never bound (or bound but the protocol check failed): the gateway
    // is genuinely dead or wedged. One restart attempt, then give up loudly.
    if (!restartAttempted && Date.now() < deadline) {
      restartAttempted = true;
      await startGateway(sandbox, token, { appendLog: true });
      continue;
    }
    break;
  }
  // Surface the gateway's own log, not just the failed health probe.
  const log = await sandbox.runCommand('sh', ['-c', `tail -20 ${GATEWAY_LOG} 2>/dev/null`]);
  throw new Error(
    `gateway did not become healthy within the wake budget. gateway log tail:\n${(await log.stdout()).slice(-1000)}`,
  );
}

/**
 * Single command that returns as soon as the gateway port accepts a TCP
 * connection, polling every 300ms inside the VM. Also the call that triggers
 * the SDK's implicit resume (and onResume -> startGateway) after a stop.
 */
async function waitForPortBind(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      `for i in $(seq 1 ${PORT_WAIT_SECONDS * 3}); do (exec 3<>/dev/tcp/127.0.0.1/${GATEWAY_PORT}) 2>/dev/null && exit 0; sleep 0.3; done; exit 1`,
    ],
  });
  return result.exitCode === 0;
}

/**
 * Forward a webhook into the gateway's native channel handler.
 *
 * Channel handlers verify signatures over the exact bytes and headers the
 * sender produced (e.g. Slack's x-slack-signature + x-slack-request-timestamp
 * over the raw body), so the body is forwarded as untouched bytes and the
 * caller supplies an ALLOWLIST of which inbound headers travel with it. An
 * allowlist, not a denylist: the gateway URL is publicly routable, and
 * unknown-but-sensitive headers (cookies, platform headers) must not leak.
 */
export async function forwardPayload(
  baseUrl: string,
  path: string,
  options: {
    rawBody: ArrayBuffer | string;
    headers: Headers;
    /** Lowercase header names to pass through from the inbound request. */
    forwardHeaders: string[];
    channel: string;
    receivedAt?: number;
  },
): Promise<Response> {
  const headers = new Headers();
  for (const name of options.forwardHeaders) {
    const value = options.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
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
