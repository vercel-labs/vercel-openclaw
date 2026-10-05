import {slackQueue} from '../src/slack-queue.js';
import {consumeSlack} from '../src/slack-worker.js';
import {slackRetry} from '../src/slack-auth.js';
import type {IdleEvent} from '../src/slack-warm.js';
export default {fetch:slackQueue.handleCallback<IdleEvent>(payload=>consumeSlack(payload),{retry:slackRetry})};
