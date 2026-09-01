/* eslint-disable jsdoc/require-jsdoc */

import { ChannelEvent, resolveChannelRoute } from '../src/channel';
import {
    ChannelRecordSchema,
    RoutingConfigSchema,
    type ChannelBinding,
    type ChannelRecord,
} from '../src/storage';

function record(bindings: ChannelBinding[]): ChannelRecord {
    return ChannelRecordSchema.parse({
        id: 'chan-1',
        channel_type: 'feishu',
        user_id: 'owner-1',
        routing: { bindings },
        session: { chat_model_config: { type: 'x' } },
    });
}

function event(
    chatId = 'oc_group',
    userId = 'ou_alice',
    metadata: Record<string, unknown> = {}
): ChannelEvent {
    return new ChannelEvent({
        channelId: 'chan-1',
        channelUserId: userId,
        chatId,
        metadata,
    });
}

describe('Python channel routing parity', () => {
    test('a catch-all routes to its agent with the exact Python UUIDv5', () => {
        expect(
            resolveChannelRoute(
                event(),
                record([
                    {
                        match_key: 'chat_id',
                        match_value: '*',
                        agent_id: 'general',
                        session_scope: 'per_chat',
                    },
                ])
            )
        ).toEqual(['general', '738dd2f8-e3ff-5140-aed1-733ff4ea0c5f', 'per_chat']);
    });

    test('the first matching binding wins', () => {
        const value = record([
            {
                match_key: 'chat_id',
                match_value: 'oc_vip',
                agent_id: 'vip',
                session_scope: 'per_chat',
            },
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'general',
                session_scope: 'per_chat',
            },
        ]);
        expect(resolveChannelRoute(event('oc_vip'), value)[0]).toBe('vip');
        expect(resolveChannelRoute(event('oc_x'), value)[0]).toBe('general');
    });

    test('matches metadata and channel user ids', () => {
        const value = record([
            {
                match_key: 'chat_type',
                match_value: 'p2p',
                agent_id: 'assistant',
                session_scope: 'per_chat',
            },
            {
                match_key: 'user_id',
                match_value: 'ou_bob',
                agent_id: 'bob',
                session_scope: 'per_chat',
            },
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'general',
                session_scope: 'per_chat',
            },
        ]);
        expect(resolveChannelRoute(event('c', 'u', { chat_type: 'p2p' }), value)[0]).toBe(
            'assistant'
        );
        expect(resolveChannelRoute(event('c', 'ou_bob'), value)[0]).toBe('bob');
    });

    test('per-chat shares users while per-chat-user isolates them', () => {
        const perChat = record([
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'a',
                session_scope: 'per_chat',
            },
        ]);
        expect(resolveChannelRoute(event('c', 'alice'), perChat)[1]).toBe(
            resolveChannelRoute(event('c', 'bob'), perChat)[1]
        );

        const perUser = record([
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'a',
                session_scope: 'per_chat_user',
            },
        ]);
        expect(resolveChannelRoute(event('oc_group', 'ou_alice'), perUser)[1]).toBe(
            '83083c30-6324-54a2-ba27-30dd8b1c8f8b'
        );
        expect(resolveChannelRoute(event('c', 'alice'), perUser)[1]).not.toBe(
            resolveChannelRoute(event('c', 'bob'), perUser)[1]
        );
    });

    test('different chats and agents produce different sessions', () => {
        const a = record([
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'a',
                session_scope: 'per_chat',
            },
        ]);
        const b = record([
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'b',
                session_scope: 'per_chat',
            },
        ]);
        expect(resolveChannelRoute(event('one'), a)[1]).not.toBe(
            resolveChannelRoute(event('two'), a)[1]
        );
        expect(resolveChannelRoute(event(), a)[1]).not.toBe(resolveChannelRoute(event(), b)[1]);
    });

    test('resolution is deterministic', () => {
        const value = record([
            {
                match_key: 'chat_id',
                match_value: '*',
                agent_id: 'a',
                session_scope: 'per_chat',
            },
        ]);
        expect(resolveChannelRoute(event(), value)).toEqual(resolveChannelRoute(event(), value));
    });

    test('routing requires one last catch-all and rejects duplicates', () => {
        expect(() =>
            RoutingConfigSchema.parse({
                bindings: [{ match_value: 'oc_1', agent_id: 'a' }],
            })
        ).toThrow();
        expect(() =>
            RoutingConfigSchema.parse({
                bindings: [
                    { match_value: '*', agent_id: 'a' },
                    { match_value: 'oc_1', agent_id: 'b' },
                ],
            })
        ).toThrow();
        expect(() =>
            RoutingConfigSchema.parse({
                bindings: [
                    { match_value: 'oc_1', agent_id: 'a' },
                    { match_value: 'oc_1', agent_id: 'b' },
                    { match_value: '*', agent_id: 'c' },
                ],
            })
        ).toThrow();
    });
});
