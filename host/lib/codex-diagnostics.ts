import { createHash } from 'node:crypto';

export type CodexPhase = 'config' | 'inspect' | 'ownership' | 'policy' | 'resume' | 'readiness' | 'runtime' | 'receipt' | 'publish' | 'stop' | 'confirm' | 'startup-cleanup';

export class CodexLifecycleError extends Error {
  constructor(readonly phase: CodexPhase, cause: unknown) {
    super(`Codex lifecycle failed at ${phase}`, { cause });
    this.name = 'CodexLifecycleError';
  }
}

const names = new Set(['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'APIError', 'StreamError', 'ExecutionDeadlineExceededError']);
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'sandbox_stopped', 'sandbox_stopping', 'sandbox_snapshotting', 'snapshot_not_found', 'forbidden', 'unauthorized', 'not_found', 'rate_limited']);
const messages = new Set(['fetch failed', 'The operation was aborted due to timeout', 'The operation was aborted.', 'Codex host configuration is incomplete', 'Refusing an unowned or mismatched Codex sandbox', 'Codex sandbox is not stopped; inspect the previous attempt before retrying', 'Resumed sandbox identity is unconfirmed', 'Readiness command failed', 'Startup cleanup ownership is unconfirmed', 'Startup cleanup session is unconfirmed', 'Startup cleanup stop is unconfirmed', 'VM1 stop is not confirmed', 'VM1 snapshot is not confirmed', 'Missing unique Codex lifecycle receipt', 'Incomplete Codex lifecycle receipt', 'Native Slack delivery is unconfirmed']);
type ErrorFields = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; response?: { status?: unknown }; json?: { error?: { code?: unknown } } };

export function safeCodexError(error: unknown, depth = 0): Record<string, unknown> {
  const value = error && typeof error === 'object' ? error as ErrorFields : {};
  const name = typeof value.name === 'string' && names.has(value.name) ? value.name : 'UnknownError';
  const code = value.code ?? value.json?.error?.code;
  const status = value.response?.status;
  // Error messages, HTTP bodies and stacks can contain credentials or user text.
  return {
    name,
    ...(typeof code === 'string' && codes.has(code) ? { code } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof value.message === 'string' && messages.has(value.message) ? { message: value.message } : {}),
    ...(typeof value.message === 'string' ? { messageHash: createHash('sha256').update(value.message).digest('hex') } : {}),
    ...(depth < 2 && value.cause ? { cause: safeCodexError(value.cause, depth + 1) } : {}),
  };
}

export function retryableReadinessError(error: unknown): boolean {
  const safe = safeCodexError(error);
  const cause = safe.cause as Record<string, unknown> | undefined;
  return safe.name === 'TimeoutError' || safe.name === 'AbortError' ||
    (typeof safe.status === 'number' && (safe.status === 429 || safe.status >= 500)) ||
    [safe.code, cause?.code].some(code => typeof code === 'string' && /^(E|UND_ERR_)/.test(code));
}

export function codexPhaseRunner(eventId: string) {
  return async <T>(phase: CodexPhase, operation: () => Promise<T> | T): Promise<T> => {
    const at = Date.now();
    const log = (outcome: string, error?: unknown) => console.info('codex host phase', JSON.stringify({ eventId, phase, outcome, at, durationMs: Date.now() - at, ...(error === undefined ? {} : { error: safeCodexError(error) }) }));
    log('started');
    try {
      const result = await operation();
      log('completed');
      return result;
    } catch (error) {
      log('failed', error);
      throw new CodexLifecycleError(phase, error);
    }
  };
}
