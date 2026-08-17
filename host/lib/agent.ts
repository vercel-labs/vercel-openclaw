import type { Sandbox } from '@vercel/sandbox';
import {
  createExecutionBudget,
  operationTimeoutMs,
  withExecutionBudget,
  type ExecutionBudget,
} from './execution-budget';

/**
 * Runs one OpenClaw agent turn and returns its reply.
 *
 * This is the bridge that replaces OpenClaw's own channel handling. The host
 * owns the channel (Slack, via Vercel Connect) and hands OpenClaw only the
 * message text, so no third-party credential ever enters the sandbox. OpenClaw
 * documents this as a supported integration shape: the gateway RPC surface is
 * for external bridges that do not need to become channel plugins
 * (docs.openclaw.ai/gateway/external-apps, retrieved 2026-08-14).
 *
 * The turn is invoked as a command INSIDE the VM rather than over the gateway's
 * exposed port. Two reasons:
 *
 *   - The CLI already talks to the local gateway, so we reuse OpenClaw's own
 *     client instead of reimplementing its WebSocket protocol.
 *   - Nothing has to be publicly routable. The sandbox has no exposed gateway
 *     port; driving turns in-VM keeps its HTTP and WebSocket surfaces private.
 */

/** Session-key prefix; OpenClaw resolves `agent:<agent-id>:<key>` forms. */
const DEFAULT_AGENT_ID = 'main';

/**
 * OpenClaw's own turn timeout, in seconds. Its documented default is 600, which
 * outlives the webhook function (`maxDuration = 300`), so we pin it below the
 * caller's budget rather than letting the function die mid-turn and leave the
 * gateway working on a reply nobody will collect.
 */
const DEFAULT_TURN_TIMEOUT_S = 240;

export interface AgentTurnResult {
  /** The reply text to post back to the channel. */
  reply: string;
  /** Parsed `--json` payload, when OpenClaw returned valid JSON. */
  raw: unknown;
}

/**
 * Builds the session key for a Slack channel. One session per channel, shared by
 * everyone in it, and stable across threads.
 *
 * The channel is the whole key on purpose. Elisabeth's call, 2026-08-14: the
 * agent "should have full context from an entire channel rather than scoped per
 * user", which is also what Andrew Qu asked for ("each channel should maintain
 * the same session"). Adding the user id gave each person a private notebook, so
 * the agent could answer one person fluently and then draw a blank with the next
 * — and since every reply is public while the notebook is not, that reads as
 * broken rather than private.
 *
 * Where a reply is POSTED is a separate question: replies still land in the
 * thread the mention came from. Session identity and reply target are decoupled.
 *
 * In a DM this is per-person anyway, because a DM has its own channel id.
 */
export function slackSessionKey(channelId: string, agentId = DEFAULT_AGENT_ID) {
  return `agent:${agentId}:slack-${channelId}`;
}

export async function runAgentTurn(options: {
  sandbox: Sandbox;
  message: string;
  sessionKey: string;
  /**
   * Gateway auth token. The CLI opens a WebSocket to the local gateway and
   * refuses to do so unauthenticated: observed live 2026-08-14 as
   * `GatewayCredentialsRequiredError: gateway agent requires credentials before
   * opening a websocket`. Passed through the environment rather than `--token`
   * to keep it out of argv.
   */
  gatewayToken: string;
  budget?: ExecutionBudget;
}): Promise<AgentTurnResult> {
  try {
    return await runAgentTurnOnce(options);
  } catch (err) {
    // One session per channel means two people in the same channel can now land
    // on the same session at once, where per-user keys could not. OpenClaw
    // refuses the second turn with "Session ... changed while starting work.
    // Retry." (observed live 2026-08-14), which is worth one retry rather than a
    // silently dropped mention.
    if (!/changed while starting work/i.test(String(err))) throw err;
    console.warn(`session ${options.sessionKey} was busy; retrying once`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return await runAgentTurnOnce(options);
  }
}

async function runAgentTurnOnce(options: {
  sandbox: Sandbox;
  message: string;
  sessionKey: string;
  gatewayToken: string;
  budget?: ExecutionBudget;
}): Promise<AgentTurnResult> {
  const { sandbox, message, sessionKey, gatewayToken } = options;
  const budget = options.budget ?? createExecutionBudget();
  const timeoutMs = operationTimeoutMs(
    budget,
    'OpenClaw agent turn',
    { capMs: DEFAULT_TURN_TIMEOUT_S * 1_000 },
  );
  const timeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1_000));

  // Arguments are passed as an argv array, never interpolated into a shell
  // string: the message is untrusted input from a chat channel.
  const result = await sandbox.runCommand({
    cmd: 'openclaw',
    args: [
      'agent',
      '--message',
      message,
      '--json',
      '--session-key',
      sessionKey,
      '--timeout',
      String(timeoutSeconds),
    ],
    // The CLI has no flag for the gateway address or credentials, so the token
    // travels in the environment and the gateway has to be listening on
    // GATEWAY_PORT, which is OpenClaw's default for exactly that reason.
    env: { OPENCLAW_GATEWAY_TOKEN: gatewayToken },
    signal: AbortSignal.timeout(timeoutMs),
    timeoutMs,
  });

  const stdout = await withExecutionBudget(
    budget,
    'agent command output',
    async (signal) => result.stdout({ signal }),
    { capMs: 10_000 },
  );

  if (result.exitCode !== 0) {
    const stderr = await withExecutionBudget(
      budget,
      'agent command error output',
      async (signal) => result.stderr({ signal }),
      { capMs: 10_000 },
    );
    throw new Error(
      `openclaw agent exited ${result.exitCode} for session ${sessionKey}. ` +
        `stderr: ${stderr.slice(-800)} stdout: ${stdout.slice(-800)}`,
    );
  }

  const parsed = parseTurnOutput(stdout);
  const usedGateway = didUseGateway(parsed.raw);
  if (!usedGateway) {
    throw new Error(
      `openclaw agent did not use the managed gateway for session ${sessionKey}; ` +
        'refusing to publish an unverified embedded-fallback reply',
    );
  }
  if (parsed.status !== 'ok') {
    throw new Error(
      `openclaw agent reported status ${parsed.status ?? 'missing'} for session ${sessionKey}`,
    );
  }
  if (!parsed.reply.trim()) {
    throw new Error(
      `openclaw agent returned no channel-visible reply for session ${sessionKey}`,
    );
  }

  return { reply: parsed.reply, raw: parsed.raw };
}

/**
 * Positively identifies the managed gateway's observed run envelope. The flat
 * payload is the embedded fallback, and an unknown future shape is rejected:
 * silently accepting it would bypass lifecycle and session continuity.
 */
export function didUseGateway(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const envelope = raw as { runId?: unknown; status?: unknown; result?: unknown };
  if (
    typeof envelope.runId !== 'string' ||
    !envelope.runId ||
    typeof envelope.status !== 'string' ||
    !envelope.result ||
    typeof envelope.result !== 'object'
  ) {
    return false;
  }

  const meta = (envelope.result as {
    meta?: { transport?: unknown; fallbackFrom?: unknown };
  }).meta;
  if (meta?.fallbackFrom === 'gateway') return false;
  if (meta?.transport === 'embedded') return false;
  return true;
}

/**
 * Extracts the reply from `--json` output.
 *
 * OpenClaw emits TWO different envelopes, both observed live 2026-08-14 against
 * 2026.7.1, and mistaking one for the other yields a reply full of JSON.
 *
 * Gateway-served turn (the path we want) wraps everything in a run envelope:
 *
 *   {
 *     "runId": "8103...", "status": "ok", "summary": "completed",
 *     "result": { "payloads": [{ "text": "bridge works", "mediaUrl": null }], "meta": {...} }
 *   }
 *
 * Embedded fallback returns the inner object flat:
 *
 *   { "payloads": [{ "text": "bridge works", "mediaUrl": null }], "meta": {...} }
 *
 * `payloads` is the channel-facing answer and is what we render; `meta` is a
 * large diagnostic block (token usage, system-prompt report, execution trace)
 * that is useful for logging but must never be posted to a channel.
 *
 * The payload is pretty-printed across many lines, so it is parsed whole rather
 * than line by line. Truly unparseable output degrades to raw text. Parsed JSON
 * with no recognized reply stays empty so diagnostic metadata can never leak to
 * a channel when the upstream schema changes.
 *
 * Presentation note: `payloads[].mediaUrl` exists, so media has a home, but the
 * turn output carries no cards, tables, or controls. Anything richer than text
 * plus media has to be rebuilt on our side.
 */
export function parseTurnOutput(stdout: string): {
  reply: string;
  raw: unknown;
  status?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { reply: '', raw: undefined };

  const parsed = parseJsonPayload(trimmed);
  if (parsed === undefined) return { reply: trimmed, raw: undefined };

  const status = (parsed as { status?: unknown }).status;
  const body = unwrapRunEnvelope(parsed) as {
    payloads?: Array<{ text?: unknown }>;
    meta?: { finalAssistantVisibleText?: unknown };
  };

  const result = {
    raw: parsed,
    status: typeof status === 'string' ? status : undefined,
  };

  // Preferred: the channel payloads, joined in order.
  const fromPayloads = (body.payloads ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter((text) => text.trim())
    .join('\n\n');
  if (fromPayloads) return { reply: fromPayloads, ...result };

  // Fallback: the assistant text recorded in meta.
  const visible = body.meta?.finalAssistantVisibleText;
  if (typeof visible === 'string' && visible.trim()) return { reply: visible, ...result };

  // Parsed, but no recognizable reply. The caller turns this into a controlled
  // failure message; never expose the full structured diagnostic payload.
  return { reply: '', ...result };
}

/**
 * Returns the inner turn result, unwrapping the gateway's run envelope when
 * present so both output shapes can be read the same way.
 */
function unwrapRunEnvelope(parsed: unknown): unknown {
  const inner = (parsed as { result?: unknown } | null)?.result;
  return inner && typeof inner === 'object' ? inner : parsed;
}

/** Candidate JSON starts to try when stdout is prefixed with log output. */
const MAX_PAYLOAD_START_CANDIDATES = 50;

/**
 * Parses stdout as JSON, tolerating leading log lines.
 *
 * Cannot simply scan for the first `{` or `[`: OpenClaw's own log lines are
 * bracket-prefixed (`[gateway] pre-warmed plugins`), so the first bracket in
 * stdout is frequently not JSON at all. Instead each line that could begin a
 * document is tried in order, capped so malformed output can't turn into a
 * quadratic parse.
 */
function parseJsonPayload(trimmed: string): unknown {
  try {
    return JSON.parse(trimmed);
  } catch {
    // Prefixed with log output; fall through to per-line candidates.
  }

  let offset = 0;
  let attempts = 0;
  for (const line of trimmed.split('\n')) {
    if (attempts >= MAX_PAYLOAD_START_CANDIDATES) break;
    const start = line.search(/[{[]/);
    // Only consider a line whose first non-whitespace character opens a
    // document, which excludes `[gateway] ...` style log lines.
    if (start !== -1 && line.slice(0, start).trim() === '') {
      attempts += 1;
      try {
        return JSON.parse(trimmed.slice(offset + start));
      } catch {
        // Not the start of a valid document; keep looking.
      }
    }
    offset += line.length + 1; // +1 for the newline consumed by split
  }
  return undefined;
}
