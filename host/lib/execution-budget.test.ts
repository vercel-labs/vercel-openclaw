import { describe, expect, it } from 'vitest';
import {
  ExecutionDeadlineExceededError,
  createExecutionBudget,
  operationTimeoutMs,
  withExecutionBudget,
} from './execution-budget';

describe('execution budget', () => {
  it('reserves reply time and caps each operation by the remaining budget', () => {
    const budget = createExecutionBudget(1_000);

    expect(budget).toEqual({ deadlineMs: 281_000, replyReserveMs: 15_000 });
    expect(operationTimeoutMs(budget, 'agent turn', { nowMs: 101_000 })).toBe(165_000);
    expect(
      operationTimeoutMs(budget, 'gateway port wait', {
        nowMs: 101_000,
        capMs: 30_000,
      }),
    ).toBe(30_000);
  });

  it('fails before starting work that would consume the reply reserve', () => {
    const budget = createExecutionBudget(1_000);

    expect(() =>
      operationTimeoutMs(budget, 'runtime lock', { nowMs: 266_000 }),
    ).toThrow(ExecutionDeadlineExceededError);
    expect(
      operationTimeoutMs(budget, 'failure reply', {
        nowMs: 270_000,
        reserveReply: false,
      }),
    ).toBe(11_000);
  });

  it('rejects an operation that ignores cancellation when its budget expires', async () => {
    const budget = { deadlineMs: Date.now() + 20, replyReserveMs: 0 };

    await expect(
      withExecutionBudget(
        budget,
        'hung SDK call',
        async () => new Promise<never>(() => undefined),
        { reserveReply: false },
      ),
    ).rejects.toThrow(ExecutionDeadlineExceededError);
  });
});
