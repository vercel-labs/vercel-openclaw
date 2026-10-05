import { slackQueue } from '../src/slack-queue.js';
import { consumeSlack } from '../src/slack-worker.js';
import { slackRetry, type QueuedSlackEvent } from '../src/slack-auth.js';
export default { fetch: slackQueue.handleCallback<QueuedSlackEvent>(payload => consumeSlack(payload), { retry: slackRetry }) };
