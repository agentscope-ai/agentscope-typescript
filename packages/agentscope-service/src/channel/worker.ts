/* eslint-disable jsdoc/require-param */

import { logger } from '@agentscope-ai/agentscope/logger';

import { AsyncLifecycleStack } from '../lifespan';
import type { MessageBus } from '../message-bus';
import type { StorageBase } from '../storage';
import type { WorkspaceManagerBase } from '../workspace-manager';
import type { ChannelConstructor } from './base';
import { ChannelLifecycleDispatcher } from './dispatcher';
import { ChannelGateway } from './gateway';
import { ChannelTypeRegistry } from './registry';

/** Run the dedicated process that owns all configured long-lived channel connections. */
export async function runChannelWorker(options: {
    storage: StorageBase;
    messageBus: MessageBus;
    workspaceManager: WorkspaceManagerBase;
    channels: ChannelConstructor[];
    signal?: AbortSignal;
}): Promise<void> {
    const lifecycle = new AsyncLifecycleStack();
    const stop = new AbortController();
    const requestStop = (): void => stop.abort();
    const externalStop = (): void => stop.abort(options.signal?.reason);
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    options.signal?.addEventListener('abort', externalStop, { once: true });
    if (options.signal?.aborted) externalStop();
    try {
        await options.storage.open();
        lifecycle.defer(() => options.storage.close());
        await options.messageBus.open();
        lifecycle.defer(() => options.messageBus.close());
        options.workspaceManager.bindStorage(options.storage);
        await options.workspaceManager.open();
        lifecycle.defer(() => options.workspaceManager.closeManager());

        const dispatcher = new ChannelLifecycleDispatcher(
            options.storage,
            options.messageBus,
            new ChannelTypeRegistry(options.channels),
            new ChannelGateway(options.storage, options.messageBus, options.workspaceManager)
        );
        await dispatcher.open();
        lifecycle.defer(() => dispatcher.close());
        logger.info('Channel worker ready (%d types)', options.channels.length);
        if (!stop.signal.aborted) {
            await new Promise<void>(resolve =>
                stop.signal.addEventListener('abort', () => resolve(), { once: true })
            );
        }
    } finally {
        logger.info('Channel worker shutting down');
        process.removeListener('SIGINT', requestStop);
        process.removeListener('SIGTERM', requestStop);
        options.signal?.removeEventListener('abort', externalStop);
        await lifecycle.close();
    }
}

export const run_channel_worker = runChannelWorker;
