/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { logger } from '@agentscope-ai/agentscope/logger';

import type { MessageBus } from '../message-bus';
import { MessageBusKeys } from '../message-bus';
import type { ChannelRecord, StorageBase } from '../storage';
import {
    ChannelBase,
    ChannelHeartbeat,
    LIVENESS_TTL_SECONDS,
    type ChannelInboundEvent,
} from './base';
import type { ChannelGateway } from './gateway';
import type { ChannelTypeRegistry } from './registry';

export const LIVENESS_REFRESH_MS = 10_000;

interface ChannelInstance {
    channel: ChannelBase;
    controller: AbortController;
    promise: Promise<void>;
    version: string;
    done: boolean;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const complete = (): void => {
            signal.removeEventListener('abort', abort);
            resolve();
        };
        const timeout = setTimeout(complete, milliseconds);
        const abort = (): void => {
            clearTimeout(timeout);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}

/** Reconcile this node's live channel connections against persistent records. */
export class ChannelLifecycleDispatcher {
    private readonly instances = new Map<string, ChannelInstance>();
    private readonly nodeId: string;
    private controller: AbortController | null = null;
    private tasks: Promise<void>[] = [];

    constructor(
        private readonly storage: StorageBase,
        private readonly messageBus: MessageBus,
        private readonly typeRegistry: ChannelTypeRegistry,
        private readonly gateway: ChannelGateway,
        options: { nodeId?: string; refreshMilliseconds?: number } = {}
    ) {
        this.nodeId =
            options.nodeId ?? `${hostname()}:${randomUUID().replaceAll('-', '').slice(0, 8)}`;
        this.refreshMilliseconds = options.refreshMilliseconds ?? LIVENESS_REFRESH_MS;
    }

    private readonly refreshMilliseconds: number;

    get instanceCount(): number {
        return this.instances.size;
    }

    async open(): Promise<this> {
        if (this.controller) return this;
        this.controller = new AbortController();
        await this.reconcile();
        await this.publishStatus();
        this.tasks = [this.listen(this.controller.signal), this.periodic(this.controller.signal)];
        return this;
    }

    async close(): Promise<void> {
        const controller = this.controller;
        if (!controller) return;
        this.controller = null;
        controller.abort();
        await Promise.allSettled(this.tasks);
        this.tasks = [];
        for (const channelId of [...this.instances.keys()]) await this.stop(channelId);
    }

    async reconcile(): Promise<void> {
        let records: ChannelRecord[];
        try {
            records = await this.storage.listAllChannels();
        } catch (error) {
            logger.error('channel reconcile: failed to list channels: %s', error);
            return;
        }
        const desired = new Map(
            records.filter(record => record.enabled).map(record => [record.id, record])
        );
        for (const channelId of [...this.instances.keys()]) {
            if (!desired.has(channelId)) await this.stop(channelId);
        }
        for (const [channelId, record] of desired) {
            const instance = this.instances.get(channelId);
            if (!instance || instance.version !== record.updated_at || instance.done) {
                if (instance) await this.stop(channelId);
                await this.start(record);
            }
        }
    }

    private async start(record: ChannelRecord): Promise<void> {
        try {
            const channel = this.typeRegistry.createChannel(
                record.channel_type,
                record.id,
                record.credentials,
                record.platform_config
            );
            const controller = new AbortController();
            const instance = {
                channel,
                controller,
                version: record.updated_at,
                done: false,
            } as ChannelInstance;
            instance.promise = channel
                .startListening(this.gateway.process, controller.signal)
                .catch(error => {
                    if (!controller.signal.aborted) {
                        logger.error("channel '%s' listener failed: %s", record.id, error);
                    }
                })
                .finally(() => {
                    instance.done = true;
                });
            this.instances.set(record.id, instance);
            logger.info("channel '%s' (%s) started", record.id, record.channel_type);
        } catch (error) {
            logger.error("channel '%s' failed to start: %s", record.id, error);
        }
    }

    private async stop(channelId: string): Promise<void> {
        const instance = this.instances.get(channelId);
        if (!instance) return;
        this.instances.delete(channelId);
        instance.controller.abort();
        await instance.promise;
        try {
            await this.messageBus.registryDelete(
                MessageBusKeys.channelLiveness(channelId),
                this.nodeId
            );
        } catch (error) {
            logger.debug("channel '%s' status withdrawal failed: %s", channelId, error);
        }
        logger.info("channel '%s' stopped", channelId);
    }

    private async listen(signal: AbortSignal): Promise<void> {
        let backoff = 1_000;
        while (!signal.aborted) {
            try {
                for await (const _event of this.messageBus.subscribe(
                    MessageBusKeys.channelLifecycle(),
                    { signal }
                )) {
                    backoff = 1_000;
                    await this.reconcile();
                }
            } catch (error) {
                if (signal.aborted) return;
                logger.warning('channel lifecycle subscription lost: %s', error);
                await delay(backoff, signal).catch(() => {});
                backoff = Math.min(backoff * 2, 30_000);
            }
        }
    }

    private async periodic(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                await delay(this.refreshMilliseconds, signal);
            } catch {
                return;
            }
            await this.reconcile();
            await this.publishStatus();
        }
    }

    async publishStatus(now = Date.now() / 1000): Promise<void> {
        for (const [channelId, instance] of this.instances) {
            try {
                await this.messageBus.registrySet(
                    MessageBusKeys.channelLiveness(channelId),
                    this.nodeId,
                    JSON.stringify(new ChannelHeartbeat(instance.channel.status, now)),
                    { ttlSeconds: LIVENESS_TTL_SECONDS }
                );
            } catch (error) {
                logger.warning("channel '%s' status heartbeat failed: %s", channelId, error);
            }
        }
    }

    async dispatch(event: ChannelInboundEvent, channelId: string): Promise<void> {
        if (this.instances.has(channelId)) await this.gateway.process(event);
    }
}
