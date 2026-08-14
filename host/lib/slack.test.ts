import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSlackEvent,
  postSlackReaction,
  postSlackReply,
  removeSlackReaction,
  stripMentions,
} from './slack';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function envelope(event: Record<string, unknown>, eventId = 'Ev123') {
  return { type: 'event_callback', event_id: eventId, event };
}

describe('parseSlackEvent', () => {
  it('handles an app mention and strips the bot mention from the text', () => {
    const result = parseSlackEvent(
      envelope({
        type: 'app_mention',
        user: 'U123',
        channel: 'C1',
        ts: '111.1',
        text: '<@U0BOT> what is the deploy status',
      }),
    );
    expect(result).toEqual({
      handle: true,
      message: {
        eventId: 'Ev123',
        userId: 'U123',
        channelId: 'C1',
        messageTs: '111.1',
        threadTs: '111.1',
        text: 'what is the deploy status',
      },
    });
  });

  it('handles a direct message', () => {
    const result = parseSlackEvent(
      envelope({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '1.1', text: 'hi' }),
    );
    expect(result.handle).toBe(true);
  });

  it('ignores a plain channel message that does not mention the bot', () => {
    // Otherwise the agent would answer every line of conversation in any channel
    // it was invited to.
    const result = parseSlackEvent(
      envelope({ type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', ts: '1.1', text: 'hi' }),
    );
    expect(result.handle).toBe(false);
  });

  it('ignores bot-authored events, which is what stops a self-reply loop', () => {
    // Our own replies arrive back as events; handling them would loop forever.
    for (const event of [
      { type: 'app_mention', bot_id: 'B1', channel: 'C1', ts: '1.1', text: 'x' },
      { type: 'app_mention', bot_profile: {}, channel: 'C1', ts: '1.1', text: 'x' },
    ]) {
      expect(parseSlackEvent(envelope(event)).handle).toBe(false);
    }
  });

  it('ignores message subtypes such as edits and joins', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'file_share']) {
      const result = parseSlackEvent(
        envelope({ type: 'message', channel_type: 'im', subtype, channel: 'D1', ts: '1.1' }),
      );
      expect(result.handle, subtype).toBe(false);
    }
  });

  it('replies in the existing thread when the mention is threaded', () => {
    const result = parseSlackEvent(
      envelope({
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        ts: '222.2',
        thread_ts: '111.1',
        text: 'follow up',
      }),
    );
    if (!result.handle) throw new Error('expected handled');
    expect(result.message.messageTs).toBe('222.2');
    expect(result.message.threadTs).toBe('111.1');
  });

  it('starts a thread on the message itself when not already threaded', () => {
    const result = parseSlackEvent(
      envelope({ type: 'app_mention', user: 'U1', channel: 'C1', ts: '222.2', text: 'x' }),
    );
    if (!result.handle) throw new Error('expected handled');
    expect(result.message.threadTs).toBe('222.2');
  });

  it('ignores anything that is not an event callback', () => {
    expect(parseSlackEvent({ type: 'url_verification', challenge: 'abc' }).handle).toBe(false);
    expect(parseSlackEvent(null).handle).toBe(false);
    expect(parseSlackEvent({}).handle).toBe(false);
  });

  it('ignores an event missing the channel or timestamp it needs to reply', () => {
    expect(parseSlackEvent(envelope({ type: 'app_mention', user: 'U1', ts: '1.1' })).handle).toBe(false);
    expect(parseSlackEvent(envelope({ type: 'app_mention', user: 'U1', channel: 'C1' })).handle).toBe(
      false,
    );
  });
});

describe('stripMentions', () => {
  it('removes mention tokens and collapses the whitespace they leave', () => {
    expect(stripMentions('<@U0BOT> hello')).toBe('hello');
    expect(stripMentions('hey <@U1> and <@U2> look')).toBe('hey and look');
  });

  it('handles the label form Slack sometimes sends', () => {
    expect(stripMentions('<@U1|elisabeth> hi')).toBe('hi');
  });

  it('leaves ordinary text alone, including a bare @', () => {
    expect(stripMentions('email me @ work please')).toBe('email me @ work please');
  });
});

describe('postSlackReply', () => {
  it('caps the Slack request by the remaining shared budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })));

    await postSlackReply({
      token: 'connect-token',
      channelId: 'C123',
      threadTs: '1.0',
      text: 'hello',
      budget: { deadlineMs: 7_000, replyReserveMs: 15_000 },
    });

    expect(timeout).toHaveBeenCalledWith(6_000);
  });
});

describe('postSlackReaction', () => {
  it('adds a visible acknowledgement to the triggering message', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await postSlackReaction({
      token: 'connect-token',
      channelId: 'C123',
      messageTs: '2.0',
      name: 'eyes',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/reactions.add',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel: 'C123', timestamp: '2.0', name: 'eyes' }),
      }),
    );
  });

  it('removes the progress acknowledgement after completion', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await removeSlackReaction({
      token: 'connect-token',
      channelId: 'C123',
      messageTs: '2.0',
      name: 'eyes',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/reactions.remove',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
