export const TURN_BUDGET_MS = 280_000;
export const REPLY_RESERVE_MS = 15_000;

export interface ExecutionBudget {
  deadlineMs: number;
  replyReserveMs: number;
}

export interface OperationBudgetOptions {
  capMs?: number;
  nowMs?: number;
  reserveReply?: boolean;
}

export class ExecutionDeadlineExceededError extends Error {
  constructor(phase: string) {
    super(`execution deadline reached before ${phase}`);
    this.name = 'ExecutionDeadlineExceededError';
  }
}

export function createExecutionBudget(nowMs = Date.now()): ExecutionBudget {
  return {
    deadlineMs: nowMs + TURN_BUDGET_MS,
    replyReserveMs: REPLY_RESERVE_MS,
  };
}

export function operationTimeoutMs(
  budget: ExecutionBudget,
  phase: string,
  options: OperationBudgetOptions = {},
): number {
  const reserveMs = options.reserveReply === false ? 0 : budget.replyReserveMs;
  const remainingMs = budget.deadlineMs - reserveMs - (options.nowMs ?? Date.now());
  if (remainingMs < 1) throw new ExecutionDeadlineExceededError(phase);
  return Math.floor(Math.min(remainingMs, options.capMs ?? Number.POSITIVE_INFINITY));
}

export function operationAbortOptions(
  budget: ExecutionBudget,
  phase: string,
  options: OperationBudgetOptions = {},
): { signal: AbortSignal; timeoutMs: number } {
  const timeoutMs = operationTimeoutMs(budget, phase, options);
  return { signal: AbortSignal.timeout(timeoutMs), timeoutMs };
}

export async function withExecutionBudget<T>(
  budget: ExecutionBudget,
  phase: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: OperationBudgetOptions = {},
): Promise<T> {
  const signal = AbortSignal.timeout(operationTimeoutMs(budget, phase, options));
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ExecutionDeadlineExceededError(phase));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(signal), expired]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
