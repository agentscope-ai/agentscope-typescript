/* eslint-disable jsdoc/require-jsdoc */

import { createMsg } from '@agentscope-ai/agentscope/message';
import {
    DataBlock,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
    URLSource,
} from '@agentscope-ai/agentscope/message';
import { ReplyFinishedReason } from '@agentscope-ai/agentscope/type';
import { z } from 'zod';

import {
    ChannelBase,
    ChannelCapability,
    ChannelEvent,
    ChannelHeartbeat,
    ChannelStatus,
    LIVENESS_TTL_SECONDS,
    type ChannelEmitter,
} from '../src/channel';
import type { BusPayload } from '../src/message-bus';

class RenderChannel extends ChannelBase {
    static readonly channelType = 'fake';
    static readonly displayName = 'Fake';
    static readonly platformBotIdField = 'bot_id';
    static readonly credentialsSchema = z.object({});
    static readonly configSchema = z.object({});
    readonly channelId = 'chan-1';

    async startListening(_emit: ChannelEmitter): Promise<void> {}
    async sendResponse(_event: ChannelEvent, _events: AsyncIterable<BusPayload>): Promise<void> {}

    renderPublic(
        reply: Parameters<ChannelBase['render']>[0],
        options?: Parameters<ChannelBase['render']>[1]
    ) {
        return this.render(reply, options);
    }

    splitPublic(text: string): string[] {
        return this.splitLongMessage(text);
    }
}

describe('channel base models and rendering', () => {
    test('normalizes an inbound event, concatenates text, and emits wire JSON', () => {
        const event = new ChannelEvent({
            channelId: 'c',
            channelUserId: 'u',
            chatId: 'chat',
            content: [TextBlock({ text: 'a' }), TextBlock({ text: 'b' })],
        });
        expect(event.message).toBe('ab');
        expect(JSON.parse(JSON.stringify(event))).toMatchObject({
            channel_id: 'c',
            channel_user_id: 'u',
            chat_id: 'chat',
            channel_user_name: '',
        });
    });

    test('renders text, optional thinking/tool process, and data in order', () => {
        const channel = new RenderChannel();
        const data = DataBlock({
            source: URLSource({ url: 'https://example.com/a.png', media_type: 'image/png' }),
        });
        const reply = createMsg({
            name: 'a',
            role: 'assistant',
            content: [
                ThinkingBlock({ thinking: 'hmm' }),
                TextBlock({ text: 'answer' }),
                ToolCallBlock({ id: 'call', name: 'Bash', input: '{}' }),
                ToolResultBlock({ id: 'call', name: 'Bash', output: 'done' }),
                data,
            ],
        });
        expect(channel.renderPublic(reply)).toEqual([
            expect.objectContaining({ text: 'answer' }),
            data,
        ]);
        expect(
            channel.renderPublic(reply, { showThinking: true, showToolProcess: true })[0]
        ).toMatchObject({
            text: '💭 hmm\n\nanswer\n\n🔧 Calling tool: Bash\n\ndone',
        });
    });

    test('renders error and no-content fallbacks', () => {
        const channel = new RenderChannel();
        const error = createMsg({
            name: 'a',
            role: 'assistant',
            content: [],
            finished_reason: ReplyFinishedReason.ERROR,
        });
        const empty = createMsg({ name: 'a', role: 'assistant', content: [] });
        expect(channel.renderPublic(error)[0]).toMatchObject({
            text: expect.stringMatching(/error/i),
        });
        expect(channel.renderPublic(empty)[0]).toMatchObject({
            text: '(Agent returned no text content)',
        });
    });

    test('splits by the declared maximum message length', () => {
        const channel = new RenderChannel();
        Object.defineProperty(channel, 'capabilities', {
            value: new ChannelCapability({ maxMessageLength: 3 }),
        });
        expect(channel.splitPublic('abcdefg')).toEqual(['abc', 'def', 'g']);
    });

    test('heartbeat freshness uses the Python TTL boundary inclusively', () => {
        const beat = new ChannelHeartbeat(new ChannelStatus('connected'), 100);
        expect(beat.isFresh(100 + LIVENESS_TTL_SECONDS)).toBe(true);
        expect(beat.isFresh(100 + LIVENESS_TTL_SECONDS + 0.001)).toBe(false);
        expect(ChannelHeartbeat.parse(JSON.stringify(beat))).toMatchObject({
            status: { state: 'connected', lastError: '' },
            reportedAt: 100,
        });
    });
});
