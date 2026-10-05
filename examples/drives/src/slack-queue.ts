import assert from 'node:assert/strict';
import { createConnectWebhookVerifier } from '@vercel/connect/chat';
import { QueueClient } from '@vercel/queue';
import { RedisRest, type Redis } from './controller-store.js';
import { envelopeKey, signQueuedEvent } from './slack-auth.js';
import { bodyHash, slackIntake, slackPolicy, type SlackEvent } from './slack-intake.js';

export const SLACK_TOPIC = 'openclaw-drives-slack';
export const slackQueue = new QueueClient({ region: 'iad1' });
const BIND = `local saved=redis.call('GET',KEYS[1]); if saved and saved~=ARGV[1] then return 0 end
if not saved then redis.call('SET',KEYS[1],ARGV[1],'EX',604800) end return 1`;
export function enqueueSlack(redis: Redis, namespace: string, publish: (event: SlackEvent, key: string) => Promise<unknown>) {
  assert(/^[A-Za-z0-9_-]{1,100}$/.test(namespace), 'Invalid Slack namespace.');
  return async (event: SlackEvent): Promise<void> => {
    assert.equal(bodyHash(event.rawBody), event.sha256, 'Slack body changed before enqueue.');
    const key = envelopeKey(namespace, event);
    assert.equal(await redis.command(['EVAL', BIND, 1, `openclaw-drives:slack-envelope:${key}`, event.sha256]), 1,
      'Event ID was reused with another body.');
    await publish(event, key);
  };
}
export function hostedSlackIntake(env = process.env) {
  const verify = createConnectWebhookVerifier();
  return slackIntake({ policy: () => slackPolicy(env.OPENCLAW_SLACK_POLICY), verify: async (request, body) => verify(request, body),
    enqueue: async event => {
      const redis = new RedisRest(env.KV_REST_API_URL!, env.KV_REST_API_TOKEN!);
      const namespace=env.OPENCLAW_CONTROLLER_NAMESPACE ?? env.VERCEL_PROJECT_ID!;
      await enqueueSlack(redis, namespace,
        (payload, key) => slackQueue.send(SLACK_TOPIC, signQueuedEvent(payload,namespace,env.OPENCLAW_SLACK_QUEUE_SECRET), { idempotencyKey: key, retentionSeconds: 86400 }))(event);
    },
  });
}
