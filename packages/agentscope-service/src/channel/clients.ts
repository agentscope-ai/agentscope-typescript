/* eslint-disable jsdoc/require-jsdoc */

import { logger } from '@agentscope-ai/agentscope/logger';

import type { MessageBus } from '../message-bus';
import type { StorageBase } from '../storage';
import { ChannelBase, ChannelEvent } from './base';
import { ChannelTypeRegistry } from './registry';
import { openReplyStream } from './stream';

interface Delivery {
    controller: AbortController;
    promise: Promise<void>;
}

/** Cache of connection-free channel clients plus their background deliveries. */
export class ChannelClients {
    private readonly cache = new Map<string, { version: string; channel: ChannelBase }>();
    private readonly retired: ChannelBase[] = [];
    private readonly deliveries = new Set<Delivery>();

    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly typeRegistry: ChannelTypeRegistry
    ) {}

    async open(): Promise<this> {
        return this;
    }

    async close(): Promise<void> {
        for (const delivery of this.deliveries) delivery.controller.abort();
        await Promise.allSettled([...this.deliveries].map(delivery => delivery.promise));
        for (const channelId of [...this.cache.keys()]) this.retire(channelId);
        for (const channel of this.retired) {
            try {
                await channel.close();
            } catch {
                logger.warning('a channel client did not close cleanly');
            }
        }
        this.retired.length = 0;
    }

    get deliveryCount(): number {
        return this.deliveries.size;
    }

    private retire(channelId: string): void {
        const cached = this.cache.get(channelId);
        this.cache.delete(channelId);
        if (cached) this.retired.push(cached.channel);
    }

    async get(channelId: string): Promise<ChannelBase | null> {
        const record = await this.storage.getChannel(channelId);
        if (!record?.enabled) {
            this.retire(channelId);
            return null;
        }
        const version = String(record.updated_at);
        const cached = this.cache.get(channelId);
        if (cached?.version === version) return cached.channel;
        let channel: ChannelBase;
        try {
            channel = this.typeRegistry.createChannel(
                record.channel_type,
                record.id,
                record.credentials,
                record.platform_config
            );
        } catch (error) {
            logger.error("channel client '%s' could not be built: %s", channelId, error);
            return null;
        }
        this.retire(channelId);
        this.cache.set(channelId, { version, channel });
        return channel;
    }

    async deliver(options: {
        sessionId: string;
        channelId: string;
        chatId: string;
        agentId: string;
    }): Promise<void> {
        const channel = await this.get(options.channelId);
        if (!channel) {
            logger.error(
                "channel '%s' has no client; the reply for session '%s' cannot be delivered",
                options.channelId,
                options.sessionId
            );
            return;
        }
        const target = new ChannelEvent({
            channelId: options.channelId,
            channelUserId: '',
            chatId: options.chatId,
            metadata: { session_id: options.sessionId, agent_id: options.agentId },
        });
        const controller = new AbortController();
        let events: AsyncGenerator<import('../message-bus').BusPayload, void, void>;
        try {
            events = await openReplyStream(this.messageBus, options.sessionId, controller.signal);
        } catch (error) {
            logger.error(
                "channel '%s' could not read the reply for session '%s': %s",
                options.channelId,
                options.sessionId,
                error
            );
            return;
        }

        const delivery = {} as Delivery;
        delivery.controller = controller;
        delivery.promise = (async () => {
            try {
                await channel.sendResponse(target, events);
            } catch (error) {
                if (!controller.signal.aborted) {
                    logger.error(
                        "channel '%s' failed to deliver the reply for session '%s': %s",
                        options.channelId,
                        options.sessionId,
                        error
                    );
                }
            } finally {
                await events.return();
                this.deliveries.delete(delivery);
            }
        })();
        this.deliveries.add(delivery);
    }
}
