/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';

import {
    ChannelError,
    ChannelHeartbeat,
    ChannelStatus,
    type ChannelTypeRegistry,
} from '../channel';
import type { MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import {
    ChannelRecordSchema,
    type ChannelRecord,
    type RoutingConfig,
    type SessionSettings,
    type StorageBase,
} from '../storage';

/** Stateless CRUD and cluster-wide read operations for channel records. */
export class ChannelService {
    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly typeRegistry: ChannelTypeRegistry
    ) {}

    async create(options: {
        userId: string;
        channelType: string;
        credentials: Record<string, unknown>;
        platformConfig: Record<string, unknown>;
        routing: RoutingConfig;
        session: SessionSettings;
        enabled?: boolean;
        name?: string | null;
    }): Promise<ChannelRecord> {
        const botId = this.typeRegistry.extractPlatformBotId(
            options.channelType,
            options.credentials
        );
        const existing = await this.storage.getChannelIdByPlatformBotId(botId);
        if (existing) {
            throw new ChannelError(
                `Bot '${botId}' already registered as channel '${existing}'.`,
                409
            );
        }
        const timestamp = new Date().toISOString();
        const record = ChannelRecordSchema.parse({
            id: randomUUID().replaceAll('-', ''),
            channel_type: options.channelType,
            name: options.name ?? null,
            user_id: options.userId,
            enabled: options.enabled ?? true,
            credentials: options.credentials,
            platform_config: options.platformConfig,
            routing: options.routing,
            session: options.session,
            created_at: timestamp,
            updated_at: timestamp,
        });
        await this.storage.upsertChannel(record, botId);
        await this.notify(record.id);
        return record;
    }

    async update(channelId: string, updates: Record<string, unknown>): Promise<ChannelRecord> {
        const record = await this.require(channelId);
        const {
            credentials: _immutableCredentials,
            channel_type: _immutableChannelType,
            ...allowed
        } = updates;
        const updated = ChannelRecordSchema.parse({
            ...record,
            ...allowed,
            credentials: record.credentials,
            channel_type: record.channel_type,
            updated_at: new Date().toISOString(),
        });
        const botId = this.typeRegistry.extractPlatformBotId(
            updated.channel_type,
            updated.credentials
        );
        await this.storage.upsertChannel(updated, botId);
        await this.notify(channelId);
        return updated;
    }

    setEnabled(channelId: string, enabled: boolean): Promise<ChannelRecord> {
        return this.update(channelId, { enabled });
    }

    async delete(channelId: string): Promise<void> {
        const record = await this.require(channelId);
        const botId = this.typeRegistry.extractPlatformBotId(
            record.channel_type,
            record.credentials
        );
        await this.storage.deleteChannel(channelId, botId);
        await this.notify(channelId);
    }

    async getStatus(channelId: string, now = Date.now() / 1000): Promise<ChannelStatus> {
        let entries: Record<string, string>;
        try {
            entries = await this.messageBus.registryGetAll(
                MessageBusKeys.channelLiveness(channelId)
            );
        } catch {
            return new ChannelStatus('stopped');
        }
        let best: ChannelStatus | null = null;
        for (const raw of Object.values(entries)) {
            const heartbeat = ChannelHeartbeat.parse(raw);
            if (!heartbeat.isFresh(now)) continue;
            if (heartbeat.status.state === 'connected') return heartbeat.status;
            if (!best || best.state === 'stopped') best = heartbeat.status;
        }
        return best ?? new ChannelStatus('stopped');
    }

    async listSeenChatIds(channelId: string): Promise<string[]> {
        const fields = await this.messageBus.registryGetAll(
            MessageBusKeys.channelSeenChats(channelId)
        );
        return Object.keys(fields).sort();
    }

    private async require(channelId: string): Promise<ChannelRecord> {
        const record = await this.storage.getChannel(channelId);
        if (!record) throw new ChannelError(`Channel '${channelId}' not found.`, 404);
        return record;
    }

    private async notify(channelId: string): Promise<void> {
        try {
            await this.messageBus.publish(MessageBusKeys.channelLifecycle(), {
                channel_id: channelId,
            });
        } catch {
            // Periodic reconcile recovers a lost best-effort notification.
        }
    }

    readonly set_enabled = this.setEnabled.bind(this);
    readonly get_status = this.getStatus.bind(this);
    readonly list_seen_chat_ids = this.listSeenChatIds.bind(this);
}
