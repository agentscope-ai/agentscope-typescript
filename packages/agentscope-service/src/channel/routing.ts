/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */

import { createHash } from 'node:crypto';

import type { ChannelBinding, ChannelRecord, SessionScope } from '../storage';
import type { ChannelEvent } from './base';

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function uuidBytes(uuid: string): Uint8Array {
    return Uint8Array.from(Buffer.from(uuid.replaceAll('-', ''), 'hex'));
}

function formatUuid(bytes: Uint8Array): string {
    const hex = Buffer.from(bytes).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
        16,
        20
    )}-${hex.slice(20)}`;
}

function uuidV5(name: string, namespace: string): string {
    const digest = createHash('sha1')
        .update(uuidBytes(namespace))
        .update(Buffer.from(name, 'utf8'))
        .digest()
        .subarray(0, 16);
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    return formatUuid(digest);
}

const SESSION_NAMESPACE = uuidV5('agentscope.channel.session', NAMESPACE_URL);

function bindingMatches(event: ChannelEvent, binding: ChannelBinding): boolean {
    if (binding.match_value === '*') return true;
    const value =
        binding.match_key === 'chat_id'
            ? event.chatId
            : binding.match_key === 'user_id'
              ? event.channelUserId
              : event.metadata[binding.match_key] == null
                ? null
                : String(event.metadata[binding.match_key]);
    return value === binding.match_value;
}

/** Resolve a channel event to a stable agent/session/scope tuple. */
export function resolveChannelRoute(
    event: ChannelEvent,
    record: ChannelRecord
): [agentId: string, sessionId: string, scope: SessionScope] {
    let binding = record.routing.bindings.at(-1)!;
    for (const candidate of record.routing.bindings) {
        if (bindingMatches(event, candidate)) {
            binding = candidate;
            break;
        }
    }
    const scopeKey =
        binding.session_scope === 'per_chat_user'
            ? `${event.chatId}:${event.channelUserId}`
            : event.chatId;
    const sessionId = uuidV5(`${record.id}:${binding.agent_id}:${scopeKey}`, SESSION_NAMESPACE);
    return [binding.agent_id, sessionId, binding.session_scope];
}

export const resolve = resolveChannelRoute;
