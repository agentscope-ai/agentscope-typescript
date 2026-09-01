/* eslint-disable jsdoc/require-jsdoc */

import { logger } from '@agentscope-ai/agentscope/logger';
import {
    DataBlockSchema,
    HintBlock,
    UserMsg,
    type DataBlock,
} from '@agentscope-ai/agentscope/message';
import { createPermissionContext, PermissionMode } from '@agentscope-ai/agentscope/permission';
import { AgentState } from '@agentscope-ai/agentscope/state';

import { enqueueRunTrigger } from '../bus-ops';
import type { BusPayload, MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import {
    ChatModelConfigSchema,
    SessionConfigSchema,
    type ChannelRecord,
    type SessionScope,
    type StorageBase,
} from '../storage';
import type { WorkspaceManagerBase } from '../workspace-manager';
import {
    ChannelConfirmationResultEvent,
    ChannelEvent,
    type ChannelContentBlock,
    type ChannelInboundEvent,
} from './base';
import { resumeAfterDecision } from './decision';
import { resolveChannelRoute } from './routing';

export const MEDIA_BUFFER_TTL_SECONDS = 300;
export const MEDIA_BUFFER_MAX = 9;

/** Inbound orchestration from normalized platform events into agent runs. */
export class ChannelGateway {
    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly workspaceManager: WorkspaceManagerBase
    ) {}

    readonly process = async (event: ChannelInboundEvent): Promise<void> => {
        try {
            if (event instanceof ChannelConfirmationResultEvent) {
                await this.handleDecision(event);
            } else {
                await this.handleMessage(event);
            }
        } catch (error) {
            logger.error(
                'ChannelGateway.process failed for channel %s: %s',
                event.channelId,
                error
            );
        }
    };

    async handleDecision(event: ChannelConfirmationResultEvent): Promise<void> {
        const record = await this.storage.getChannel(event.channelId);
        if (!record?.enabled) return;
        const guess: [string, string] =
            event.agentId && event.sessionId
                ? [event.agentId, event.sessionId]
                : (resolveChannelRoute(
                      new ChannelEvent({
                          channelId: event.channelId,
                          channelUserId: event.channelUserId,
                          chatId: event.chatId,
                      }),
                      record
                  ).slice(0, 2) as [string, string]);
        if (await this.resume(record.user_id, guess, event)) return;

        for (const session of await this.storage.listSessionsByChannel(
            record.user_id,
            event.channelId
        )) {
            const target: [string, string] = [session.agent_id, session.id];
            if (
                (target[0] === guess[0] && target[1] === guess[1]) ||
                session.source_chat_id !== event.chatId
            ) {
                continue;
            }
            if (await this.resume(record.user_id, target, event)) return;
        }
        logger.warning(
            "channel '%s': no session is waiting on tool call '%s' (clicked in chat '%s' by '%s')",
            event.channelId,
            event.toolCallId,
            event.chatId,
            event.channelUserId
        );
    }

    private resume(
        userId: string,
        target: [agentId: string, sessionId: string],
        event: ChannelConfirmationResultEvent
    ): Promise<boolean> {
        return resumeAfterDecision(this.messageBus, this.storage, {
            userId,
            agentId: target[0],
            sessionId: target[1],
            toolCallId: event.toolCallId,
            approved: event.approved,
        });
    }

    async handleMessage(event: ChannelEvent): Promise<void> {
        const record = await this.storage.getChannel(event.channelId);
        if (!record) {
            logger.error('No channel record for %s', event.channelId);
            return;
        }
        if (!record.enabled) return;

        const [agentId, sessionId, scope] = resolveChannelRoute(event, record);
        if (event.chatId) {
            await this.messageBus.registrySet(
                MessageBusKeys.channelSeenChats(event.channelId),
                event.chatId,
                '1'
            );
        }
        const content = await this.aggregateMedia(event);
        if (!content) return;

        if (await this.messageBus.isLocked(MessageBusKeys.sessionLock(sessionId))) {
            await this.messageBus.queuePush(
                MessageBusKeys.inbox(sessionId),
                HintBlock({
                    hint: content,
                    source: JSON.stringify({
                        label: 'channel',
                        sublabel: event.channelUserName || event.channelUserId,
                    }),
                }) as unknown as BusPayload
            );
            return;
        }

        await this.ensureSession(record, agentId, sessionId, event, scope);
        await enqueueRunTrigger(this.messageBus, {
            userId: record.user_id,
            sessionId,
            agentId,
            kind: MessageBusKeys.WAKEUP_KIND_MESSAGE,
            input: UserMsg({ name: event.channelUserId, content }),
        });
    }

    async aggregateMedia(event: ChannelEvent): Promise<ChannelContentBlock[] | null> {
        const key = MessageBusKeys.channelMediaBuffer(
            event.channelId,
            event.chatId,
            event.channelUserId
        );
        const hasText = event.content.some(block => block.type === 'text');
        if (!hasText) {
            for (const block of event.content) {
                if (block.type === 'data') {
                    await this.messageBus.queuePush(key, block as unknown as BusPayload, {
                        ttlSeconds: MEDIA_BUFFER_TTL_SECONDS,
                    });
                }
            }
            return null;
        }
        const buffered = (await this.messageBus.queueDrain(key, MEDIA_BUFFER_MAX)).map(
            ([, payload]) => DataBlockSchema.parse(payload) as DataBlock
        );
        return [...buffered, ...event.content];
    }

    async ensureSession(
        record: ChannelRecord,
        agentId: string,
        sessionId: string,
        event: ChannelEvent,
        scope: SessionScope
    ): Promise<void> {
        if (await this.storage.getSession(record.user_id, agentId, sessionId)) return;
        const fallback = record.session.fallback_chat_model_config;
        const config = SessionConfigSchema.parse({
            workspace_id: await this.workspaceManager.assignWorkspaceId({
                userId: record.user_id,
                agentId,
                sessionId,
            }),
            chat_model_config: ChatModelConfigSchema.parse(record.session.chat_model_config),
            fallback_chat_model_config: fallback ? ChatModelConfigSchema.parse(fallback) : null,
            name: ChannelGateway.sessionName(record, event, scope),
        });
        const permissionMode = Object.values(PermissionMode).includes(
            record.session.permission_mode as PermissionMode
        )
            ? (record.session.permission_mode as PermissionMode)
            : PermissionMode.DEFAULT;
        const state = new AgentState({
            permissionContext: createPermissionContext(permissionMode),
        });
        await this.storage.upsertSession({
            userId: record.user_id,
            agentId,
            config,
            state: state.toJSON(),
            sessionId,
            source: 'channel',
            sourceChatId: event.chatId,
            sourceChatName: event.chatName || null,
            sourceChannelId: record.id,
        });
    }

    static sessionName(record: ChannelRecord, event: ChannelEvent, scope: SessionScope): string {
        const platform = record.channel_type
            ? `${record.channel_type[0].toUpperCase()}${record.channel_type.slice(1).toLowerCase()}`
            : '';
        const where = event.chatName || event.channelUserName || event.chatId;
        const parts = [platform, where];
        if (scope === 'per_chat_user') {
            const who = event.channelUserName || event.channelUserId;
            if (who && who !== where) parts.push(who);
        }
        return parts.filter(Boolean).join('/');
    }
}
