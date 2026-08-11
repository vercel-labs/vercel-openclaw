import { Sandbox } from '@vercel/sandbox';

/**
 * Wake path per docs/suspension-spec.md: resume (or create) the sandbox,
 * make sure the gateway process is running, and return the exposed-port URL
 * the host forwards traffic to.
 *
 * The host runs OUTSIDE the sandbox, so the forwarding URL is always
 * sandbox.domain(GATEWAY_PORT) — never localhost. localhost:3000 only exists
 * inside the VM.
 */

const GATEWAY_PORT = 3000;
const DEFAULT_IMAGE = 'openclaw-foundation/openclaw/openclaw:latest';
const SESSION_TIMEOUT_MS = 75 * 60 * 1000; // platform backstop, 15 min behind graceful path

// image_not_ready is thrown while VCR prepares an optimized amd64 build after
// a push. It happens at create/resume time, not when forwarding payloads.
const IMAGE_READY_RETRIES = 6;
const IMAGE_READY_DELAY_MS = 10_000;

const HEALTH_ATTEMPTS = 24;
const HEALTH_DELAY_MS = 5_000;

export interface AwakeGateway {
  sandbox: Sandbox;
  /** Public exposed-port URL for forwarding into the gateway. */
  baseUrl: string;
}

export async function ensureAwake(name: string): Promise<AwakeGateway> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('OPENCLAW_GATEWAY_TOKEN not set');

  const image = process.env.OPENCLAW_IMAGE ?? DEFAULT_IMAGE;

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
        // Fires on every session resume, including auto-resume: processes die
        // on stop, only disk survives, so the gateway must be restarted.
        onResume: async (sbx) => startGateway(sbx, token),
      });
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('image_not_ready') && attempt < IMAGE_READY_RETRIES) {
        await sleep(IMAGE_READY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }

  // getOrCreate resumes lazily; the first runCommand below triggers the
  // resume (and onResume) when the sandbox was stopped.
  await waitForGatewayHealth(sandbox, token);
  return { sandbox, baseUrl: sandbox.domain(GATEWAY_PORT) };
}

async function startGateway(sandbox: Sandbox, token: string): Promise<void> {
  await sandbox.runCommand({
    cmd: 'openclaw',
    args: [
      'gateway',
      'run',
      '--allow-unconfigured',
      '--auth',
      'token',
      '--port',
      String(GATEWAY_PORT),
    ],
    env: { OPENCLAW_GATEWAY_TOKEN: token },
    detached: true,
  });
}

/**
 * The gateway is a WebSocket server; there is no confirmed HTTP /health
 * route. Health is checked with OpenClaw's own CLI from inside the sandbox:
 * `openclaw gateway call health` (verified against 2026.7.2-beta.7).
 */
async function waitForGatewayHealth(sandbox: Sandbox, token: string): Promise<void> {
  let lastOutput = '';
  for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
    const result = await sandbox.runCommand({
      cmd: 'openclaw',
      args: [
        'gateway',
        'call',
        'health',
        '--url',
        `ws://127.0.0.1:${GATEWAY_PORT}`,
        '--token',
        token,
        '--json',
        '--timeout',
        '5000',
      ],
    });
    if (result.exitCode === 0) return;
    lastOutput = await result.stderr();
    await sleep(HEALTH_DELAY_MS);
  }
  throw new Error(`gateway did not become healthy: ${lastOutput.slice(0, 500)}`);
}

/**
 * Forward a webhook into the gateway's native channel handler.
 *
 * The body MUST be byte-identical to what the sender posted: channel handlers
 * verify signatures over the raw body. Host metadata travels in headers only.
 */
export async function forwardPayload(
  baseUrl: string,
  path: string,
  options: {
    rawBody: string;
    contentType: string | null;
    channel: string;
    receivedAt?: number;
  },
): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      'x-openclaw-channel': options.channel,
      'x-received-at': String(options.receivedAt ?? Date.now()),
    },
    body: options.rawBody,
    signal: AbortSignal.timeout(10_000),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
