import { createExecutionBudget, operationTimeoutMs, type ExecutionBudget } from './execution-budget';
import type { SlackReplyTarget } from './slack';

export async function setSlackSessionStatus(options: SlackReplyTarget & {
  token: string;
  status: 'processing' | 'active';
  budget?: ExecutionBudget;
}): Promise<void> {
  const timeout = operationTimeoutMs(options.budget ?? createExecutionBudget(), 'Slack session status', { capMs: 3000, reserveReply: false });
  const response = await fetch('https://slack.com/api/agents.sessions.setStatus', {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel_id: options.channelId, thread_ts: options.threadTs, status: options.status }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean };
  if (!response.ok || data.ok !== true) throw new Error(`Slack session status failed: HTTP ${response.status}`);
}
