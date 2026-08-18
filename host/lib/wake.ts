import { APIError, Sandbox } from '@vercel/sandbox';
import {
  createExecutionBudget,
  operationAbortOptions,
  operationTimeoutMs,
  withExecutionBudget,
  type ExecutionBudget,
} from './execution-budget';
import {
  PLACEHOLDER_MODEL_KEY,
  PLUGIN_SPECS,
  buildInstallNetworkPolicy,
  buildNetworkPolicy,
  readOidcToken,
} from './model-credentials';
import { buildOpenClawRuntime, type OpenClawRuntime } from './openclaw-runtime';

/**
 * Wake path per docs/suspension-spec.md: resume (or create) the sandbox and
 * make sure the gateway process is running. Agent turns are invoked with the
 * OpenClaw CLI inside the VM, so the gateway needs no public port route.
 */

/**
 * OpenClaw's own default gateway port.
 *
 * Not an arbitrary choice: `openclaw agent` takes no `--url`, `--token`, or
 * `--port` option (verified against the CLI's help inside the image,
 * 2026-08-14), so it always dials 127.0.0.1:18789. A gateway on any other port
 * is invisible to it, and rather than failing loudly the CLI quietly runs an
 * embedded agent instead, bypassing the gateway this control plane suspends and
 * resumes. Running where the CLI looks is the only way to keep turns on the
 * managed gateway.
 */
export const GATEWAY_PORT = 18789;
const DEFAULT_IMAGE = 'openclaw-foundation/openclaw/openclaw:latest';
const GATEWAY_LOG = '/tmp/openclaw-gateway.log';
const RUNTIME_MARKER = '/tmp/vercel-openclaw-runtime-fingerprint';
const RUNTIME_LOCK = '/tmp/vercel-openclaw-runtime.lock';

// Keep the PoC deployable on personal Hobby projects, whose maximum persistent
// Sandbox session length is 45 minutes. Idle suspension should normally win.
export const SESSION_TIMEOUT_MS = 45 * 60 * 1000;

// image_not_ready is thrown while VCR prepares an optimized amd64 build after
// a push. It happens at create/resume time, not when forwarding payloads.
const IMAGE_READY_RETRIES = 6;
const IMAGE_READY_DELAY_MS = 10_000;

const HEALTH_CACHE_MS = 30_000;
const RUNTIME_LOCK_WAIT_MS = 30_000;

export interface AwakeGateway {
  sandbox: Sandbox;
  /** Present only when the caller requested the native inbound HTTP route. */
  baseUrl?: string;
}

export interface WakeOptions {
  oidcToken?: string;
  budget?: ExecutionBudget;
  exposeGatewayPort?: boolean;
}

// Dampens concurrent webhook bursts: one wake per sandbox name per instance,
// and a short-lived "recently healthy" cache to skip per-message probes.
const inflight = new Map<string, Promise<AwakeGateway>>();
const lastHealthyAt = new Map<string, number>();

export function ensureAwake(
  name: string,
  options: WakeOptions = {},
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
  options: WakeOptions,
): Promise<AwakeGateway> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');
  const runtime = buildOpenClawRuntime(process.env, token);

  const image = process.env.OPENCLAW_IMAGE ?? DEFAULT_IMAGE;
  const budget = options.budget ?? createExecutionBudget();

  // Model access is brokered at the firewall, so the credential is part of the
  // network policy rather than anything inside the VM. Read once per wake: the
  // token is short-lived and every session gets a fresh one.
  const oidcToken = readOidcToken(options.oidcToken);
  const hostBridgeApiUrl = options.exposeGatewayPort
    ? process.env.OPENCLAW_SLACK_HOST_BRIDGE_API_URL
    : undefined;
  const networkPolicy = buildNetworkPolicy(oidcToken, hostBridgeApiUrl);
  let sandbox: Sandbox | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      sandbox = await withExecutionBudget(
        budget,
        'sandbox get or create',
        async (signal) =>
          Sandbox.getOrCreate({
            name,
            image,
            persistent: true,
            timeout: SESSION_TIMEOUT_MS,
            networkPolicy,
            ...(options.exposeGatewayPort ? { ports: [GATEWAY_PORT] } : {}),
            signal,
          }),
      );
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
        Date.now() + IMAGE_READY_DELAY_MS < budget.deadlineMs - budget.replyReserveMs
      ) {
        await withExecutionBudget(
          budget,
          'image readiness retry delay',
          async (signal) => sleep(IMAGE_READY_DELAY_MS, signal),
        );
        continue;
      }
      throw err;
    }
  }

  // Refresh on every accepted turn. Function OIDC is request-scoped and may
  // rotate while a persistent session remains running; it belongs only in the
  // firewall policy and never in a sandbox env/config value.
  await withExecutionBudget(
    budget,
    'network policy refresh',
    async (signal) => sandbox.updateNetworkPolicy(networkPolicy, { signal }),
    { capMs: 15_000 },
  );

  const desiredMarker = runtime.fingerprint;
  const runtimeStarted = await ensureRuntimeReady(
    name,
    sandbox,
    token,
    runtime,
    desiredMarker,
    budget,
    oidcToken,
    hostBridgeApiUrl,
    Boolean(options.exposeGatewayPort),
  );

  // getOrCreate retrieves without resuming; updateNetworkPolicy above is the
  // first SDK call and resumes a stopped session before readiness is checked.
  await waitForGatewayHealth(
    name,
    sandbox,
    token,
    budget,
    () => runtimeStarted,
  );
  return {
    sandbox,
    ...(options.exposeGatewayPort
      ? { baseUrl: sandbox.domain(GATEWAY_PORT) }
      : {}),
  };
}

/**
 * Installs the plugins the official image does not ship.
 *
 * Verified on 2026-08-14 against `openclaw-foundation/openclaw/openclaw:latest`:
 * a fresh sandbox carries 69 stock plugins and neither the Slack channel nor the
 * AI Gateway provider is among them, so `channels.slack` configures fine and
 * then the gateway reports "no channel plugin is installed or loadable" and
 * `/slack/events` 404s.
 *
 * npm is reachable for the duration of the install and then taken away again,
 * before the gateway starts and therefore before any agent code runs. That is
 * the only window in which the sandbox can reach the registry, and it exists
 * because network policies can be swapped on a running sandbox.
 *
 * The plugins land under `/home/node/.openclaw/npm`, which is on the snapshotted
 * disk, so a resumed sandbox already has them and never repeats this.
 */
async function installPlugins(
  sandbox: Sandbox,
  oidcToken: string,
  budget: ExecutionBudget,
  hostBridgeApiUrl?: string,
): Promise<void> {
  const missing: Array<(typeof PLUGIN_SPECS)[number]> = [];
  for (const spec of PLUGIN_SPECS) {
    const installed = await sandbox.runCommand({
      cmd: 'sh',
      args: [
        '-c',
        `find /home/node/.openclaw/npm/projects -path '*/node_modules/${spec}/package.json' -print -quit 2>/dev/null | grep -q .`,
      ],
      ...operationAbortOptions(budget, `inspect ${spec}`, { capMs: 10_000 }),
    });
    if (installed.exitCode !== 0) missing.push(spec);
  }
  if (missing.length === 0) return;

  await withExecutionBudget(
    budget,
    'open npm egress for plugin install',
    async (signal) =>
      sandbox.updateNetworkPolicy(
        buildInstallNetworkPolicy(oidcToken, hostBridgeApiUrl),
        { signal },
      ),
    { capMs: 15_000 },
  );

  try {
    for (const spec of missing) {
      const result = await sandbox.runCommand({
        cmd: 'openclaw',
        args: ['plugins', 'install', spec],
        ...operationAbortOptions(budget, `install ${spec}`, { capMs: 120_000 }),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `plugin install failed for ${spec}: ${await commandOutput(result, budget)}`,
        );
      }
    }
  } finally {
    // Always narrow back, including when an install failed. A sandbox left with
    // the registry reachable is exactly the hole the policy exists to close.
    await withExecutionBudget(
      budget,
      'restore steady-state egress policy',
      async (signal) =>
        sandbox.updateNetworkPolicy(
          buildNetworkPolicy(oidcToken, hostBridgeApiUrl),
          { signal },
        ),
      { capMs: 15_000 },
    );
  }
}

/**
 * Seeds the placeholder the AI Gateway provider plugin looks for.
 *
 * The plugin resolves auth from a per-agent SQLite auth store, not from the
 * process environment. Observed live 2026-08-14: exporting `AI_GATEWAY_API_KEY`
 * to the gateway, and again writing it to `~/.openclaw/.env`, both still failed
 * with `No API key found for provider "vercel-ai-gateway"`; `openclaw models
 * status` reports `Shell env : off`. Registering a profile is what makes the
 * provider effective:
 *
 *   vercel-ai-gateway effective=profiles:…/openclaw-agent.sqlite | api_key=1
 *
 * `paste-api-key` reads the value from stdin, so it works without a TTY.
 *
 * Storing a credential on the sandbox disk would normally be the wrong instinct.
 * It is right here precisely because the value is not a credential: the firewall
 * replaces the Authorization header on the way out, so the string has no power
 * and anyone reading it inside the VM learns nothing.
 */
async function seedProviderPlaceholder(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `printf '%s\\n' '${PLACEHOLDER_MODEL_KEY}' | ` +
        `openclaw models auth paste-api-key --provider vercel-ai-gateway`,
    ],
    ...operationAbortOptions(budget, 'register provider placeholder', { capMs: 60_000 }),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `could not seed the provider placeholder: ${await commandOutput(result, budget)}`,
    );
  }
}

export async function startGateway(
  sandbox: Sandbox,
  token: string,
  opts: {
    appendLog?: boolean;
    budget?: ExecutionBudget;
    runtime?: OpenClawRuntime;
    configure?: boolean;
  } = {},
): Promise<void> {
  const runtime = opts.runtime ?? buildOpenClawRuntime(process.env, token);
  const budget = opts.budget ?? createExecutionBudget();

  if (opts.configure !== false && runtime.configOperations.length > 0) {
    const configured = await sandbox.runCommand({
      cmd: 'openclaw',
      args: [
        'config',
        'set',
        '--batch-json',
        JSON.stringify(runtime.configOperations),
      ],
      env: runtime.gatewayEnv,
      ...operationAbortOptions(budget, 'OpenClaw runtime configuration', {
        capMs: 60_000,
      }),
    });
    if (configured.exitCode !== 0) {
      const detail = await commandOutput(configured, budget);
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
    signal: AbortSignal.timeout(
      operationTimeoutMs(budget, 'gateway process start', { capMs: 10_000 }),
    ),
    detached: true,
  });
}

async function ensureRuntimeReady(
  name: string,
  sandbox: Sandbox,
  token: string,
  runtime: OpenClawRuntime,
  desiredMarker: string,
  budget: ExecutionBudget,
  oidcToken: string,
  hostBridgeApiUrl: string | undefined,
  requireSlackRoute: boolean,
): Promise<boolean> {
  if (await isRuntimeReady(sandbox, desiredMarker, budget, requireSlackRoute)) {
    return false;
  }

  await acquireRuntimeLock(sandbox, budget);
  try {
    // Another function instance may have completed startup while this one
    // waited. Re-check under the cross-instance sandbox lock.
    if (await isRuntimeReady(sandbox, desiredMarker, budget, requireSlackRoute)) {
      return false;
    }

    const configurationCurrent =
      (await readRuntimeFingerprint(sandbox, budget)) === desiredMarker;
    lastHealthyAt.delete(name);
    // Stop the gateway BEFORE anything that widens egress, and keep it that way.
    //
    // `installPlugins` opens registry.npmjs.org. On a fresh sandbox nothing is
    // running, but this branch is also reached on a *running* sandbox whenever
    // the fingerprint moved: a deploy that changes RUNTIME_CONFIG_VERSION or
    // configOperations, a different OPENCLAW_MODEL, or a rotated gateway token.
    // Installing first would leave the old gateway serving, possibly with an
    // agent turn in flight, while the registry was reachable for up to the
    // install timeout. That is precisely the invariant this design sells:
    // "no agent code ever runs with the registry reachable"
    // (lib/model-credentials.ts).
    await stopGateway(sandbox, budget);
    // Inspect before installing. The native PoC overlays its tarball onto an
    // official Slack install; a blind reinstall here would silently erase it.
    await installPlugins(sandbox, oidcToken, budget, hostBridgeApiUrl);
    if (!configurationCurrent) {
      await seedProviderPlaceholder(sandbox, budget);
    }
    await startGateway(sandbox, token, {
      appendLog: true,
      budget,
      runtime,
      configure: !configurationCurrent,
    });
    await waitForGatewayHealth(name, sandbox, token, budget, () => true);
    if (requireSlackRoute) await waitForSlackRoute(sandbox, budget);
    if (!configurationCurrent) {
      await writeRuntimeFingerprint(sandbox, desiredMarker, budget);
    }
    lastHealthyAt.set(name, Date.now());
    return true;
  } finally {
    await releaseRuntimeLock(sandbox, budget);
  }
}

async function isRuntimeReady(
  sandbox: Sandbox,
  desiredMarker: string,
  budget: ExecutionBudget,
  requireSlackRoute: boolean,
): Promise<boolean> {
  if ((await readRuntimeFingerprint(sandbox, budget)) !== desiredMarker) return false;
  if (!(await probeGatewayPort(sandbox, budget))) return false;
  return requireSlackRoute ? probeSlackRoute(sandbox, budget) : true;
}

async function acquireRuntimeLock(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      `for i in $(seq 1 100); do
        mkdir ${RUNTIME_LOCK} 2>/dev/null && exit 0
        if find ${RUNTIME_LOCK} -maxdepth 0 -mmin +2 -print -quit 2>/dev/null | grep -q .; then
          rmdir ${RUNTIME_LOCK} 2>/dev/null || true
        fi
        sleep 0.3
      done
      exit 1`,
    ],
    ...operationAbortOptions(budget, 'sandbox runtime lock', {
      capMs: RUNTIME_LOCK_WAIT_MS,
    }),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `timed out waiting for sandbox runtime lock: ${await commandOutput(result, budget)}`,
    );
  }
}

async function releaseRuntimeLock(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<void> {
  try {
    await sandbox.runCommand({
      cmd: 'rmdir',
      args: [RUNTIME_LOCK],
      ...operationAbortOptions(budget, 'sandbox runtime lock release', {
        capMs: 2_000,
        reserveReply: false,
      }),
    });
  } catch (err) {
    console.error('failed to release sandbox runtime lock:', err);
  }
}

async function readRuntimeFingerprint(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<string> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', `cat ${RUNTIME_MARKER} 2>/dev/null || true`],
    ...operationAbortOptions(budget, 'runtime fingerprint read', { capMs: 5_000 }),
  });
  return (
    await withExecutionBudget(
      budget,
      'runtime fingerprint output',
      async (signal) => result.stdout({ signal }),
      { capMs: 5_000 },
    )
  ).trim();
}

async function writeRuntimeFingerprint(
  sandbox: Sandbox,
  fingerprint: string,
  budget: ExecutionBudget,
): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `umask 077; printf %s "$OPENCLAW_RUNTIME_FINGERPRINT" > ${RUNTIME_MARKER}`,
    ],
    env: { OPENCLAW_RUNTIME_FINGERPRINT: fingerprint },
    ...operationAbortOptions(budget, 'runtime fingerprint write', { capMs: 5_000 }),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `could not persist runtime fingerprint: ${await commandOutput(result, budget)}`,
    );
  }
}

async function probeGatewayPort(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<boolean> {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      `(exec 3<>/dev/tcp/127.0.0.1/${GATEWAY_PORT}) 2>/dev/null`,
    ],
    ...operationAbortOptions(budget, 'gateway port probe', { capMs: 5_000 }),
  });
  return result.exitCode === 0;
}

async function probeSlackRoute(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<boolean> {
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
    ...operationAbortOptions(budget, 'Slack route probe', { capMs: 5_000 }),
  });
  const status = (
    await withExecutionBudget(
      budget,
      'Slack route probe output',
      async (signal) => result.stdout({ signal }),
      { capMs: 5_000 },
    )
  ).trim();
  return result.exitCode === 0 && status !== '' && status !== '000' && status !== '404';
}

async function waitForSlackRoute(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<void> {
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
    ...operationAbortOptions(budget, 'Slack route readiness', { capMs: 30_000 }),
  });
  if (result.exitCode !== 0) {
    throw new Error('Slack route did not mount after gateway startup');
  }
}

async function stopGateway(sandbox: Sandbox, budget: ExecutionBudget): Promise<void> {
  await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      "pkill -TERM -f '^openclaw-gateway$' 2>/dev/null || true; sleep 1",
    ],
    ...operationAbortOptions(budget, 'gateway process stop', { capMs: 5_000 }),
  });
}

async function commandOutput(result: {
  stdout(options?: { signal?: AbortSignal }): Promise<string>;
  stderr(options?: { signal?: AbortSignal }): Promise<string>;
}, budget: ExecutionBudget): Promise<string> {
  const [stdout, stderr] = await withExecutionBudget(
    budget,
    'sandbox command output',
    async (signal) =>
      Promise.all([result.stdout({ signal }), result.stderr({ signal })]),
    { capMs: 5_000 },
  );
  return `${stdout}\n${stderr}`.trim().slice(-1500) || 'no command output';
}

/**
 * Tops the session timeout back up to the full backstop window.
 *
 * `extendTimeout` ADDS duration rather than resetting the deadline, so the
 * extension is the shortfall only and `expiresAt` never outruns wall clock by
 * more than SESSION_TIMEOUT_MS. At the plan's hard 24h maximum this starts
 * failing, which is the signal for the cron's ceiling path to take over, so the
 * failure is logged loudly rather than swallowed quietly.
 */
export async function topUpSessionTimeout(
  sandbox: Sandbox,
  budget: ExecutionBudget = createExecutionBudget(),
): Promise<void> {
  try {
    const expiresAt = sandbox.expiresAt?.getTime();
    if (expiresAt === undefined) return;
    const shortfall = SESSION_TIMEOUT_MS - (expiresAt - Date.now());
    if (shortfall > 0) {
      await withExecutionBudget(
        budget,
        'sandbox timeout extension',
        async (signal) => sandbox.extendTimeout(shortfall, { signal }),
        { capMs: 5_000 },
      );
    }
  } catch (err) {
    console.error('extendTimeout failed (hard ceiling reached?):', err);
  }
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
  budget: ExecutionBudget,
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
    const bound = await waitForPortBind(sandbox, budget);
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
        ...operationAbortOptions(budget, 'gateway protocol health check', {
          capMs: 10_000,
        }),
      });
      if (result.exitCode === 0) {
        lastHealthyAt.set(name, Date.now());
        return;
      }
    }
    // Port never bound (or bound but the protocol check failed): the gateway
    // is genuinely dead or wedged. One restart attempt, then give up loudly.
    if (!restartAttempted) {
      restartAttempted = true;
      await startGateway(sandbox, token, {
        appendLog: true,
        budget,
        configure: false,
      });
      continue;
    }
    break;
  }
  // Surface the gateway's own log, not just the failed health probe.
  //
  // Three sources, because the obvious one can be empty. OpenClaw writes its
  // structured log to /tmp/openclaw/*.log separately from this stdout redirect,
  // and anything failing before the logger initializes appears in neither. In
  // that case the process table is the only evidence: a gateway wedged on a
  // blocked network resolution is alive with a child `npm`/`node` still running
  // (observed 2026-08-17). Without the ps snapshot that failure reads as a
  // generic timeout with a zero-byte log.
  //
  // Order matters: the caller keeps only the tail of this output, so the two
  // highest-value sections are emitted last. OpenClaw's own log goes first and
  // is the one bounded hardest, with `-q` to suppress the per-file `==>` headers
  // that would otherwise crowd out the primary log when several files match.
  const log = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `echo "--- openclaw internal log ---"; tail -q -n 8 /tmp/openclaw/*.log 2>/dev/null; ` +
        `echo "--- ${GATEWAY_LOG} ---"; tail -20 ${GATEWAY_LOG} 2>/dev/null; ` +
        `echo "--- processes ---"; ps -eo pid,etime,args 2>/dev/null | grep -iE 'openclaw|npm' | grep -v grep`,
    ],
    ...operationAbortOptions(budget, 'gateway log tail', { capMs: 5_000 }),
  });
  const logTail = await withExecutionBudget(
    budget,
    'gateway log output',
    async (signal) => log.stdout({ signal }),
    { capMs: 5_000 },
  );
  throw new Error(
    `gateway did not become healthy within the wake budget. gateway diagnostics:\n${logTail.slice(-2500)}`,
  );
}

/**
 * Single command that returns as soon as the gateway port accepts a TCP
 * connection, polling every 300ms inside the VM.
 */
async function waitForPortBind(
  sandbox: Sandbox,
  budget: ExecutionBudget,
): Promise<boolean> {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-c',
      `for i in $(seq 1 ${PORT_WAIT_SECONDS * 3}); do (exec 3<>/dev/tcp/127.0.0.1/${GATEWAY_PORT}) 2>/dev/null && exit 0; sleep 0.3; done; exit 1`,
    ],
    ...operationAbortOptions(budget, 'gateway port wait', {
      capMs: PORT_WAIT_SECONDS * 1_000,
    }),
  });
  return result.exitCode === 0;
}

/** Forwards the exact verified envelope into a native channel HTTP handler. */
export async function forwardPayload(
  baseUrl: string,
  path: string,
  options: {
    rawBody: ArrayBuffer | string;
    headers: Headers;
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
