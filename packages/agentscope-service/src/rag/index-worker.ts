/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { logger } from '@agentscope-ai/agentscope/logger';
import type { ChunkerBase, ParserBase } from '@agentscope-ai/agentscope/rag';

import { AsyncLifecycleStack } from '../lifespan';
import type { MessageBus } from '../message-bus';
import { IndexTaskConsumer, IndexWorker, type ParserExecutor } from '../service';
import type { StorageBase } from '../storage';
import type { BlobStoreBase } from './blob-store';
import type { KnowledgeBaseManagerBase } from './knowledge-base-manager';

export interface RunIndexWorkerOptions {
    storage: StorageBase;
    messageBus: MessageBus;
    blobStore: BlobStoreBase;
    knowledgeBaseManager: KnowledgeBaseManagerBase;
    parsers: ParserBase[] | Record<string, ParserBase>;
    chunkers?: Array<new (parameters?: Record<string, unknown>) => ChunkerBase<object>>;
    nodeId?: string;
    workerMaxConcurrency?: number;
    consumerMaxBatch?: number;
    parserExecutor?: ParserExecutor | null;
    signal?: AbortSignal;
}

/** Run an out-of-process index consumer until cancellation. */
export async function runWorker(options: RunIndexWorkerOptions): Promise<void> {
    const nodeId = options.nodeId ?? `${hostname()}:${randomUUID().slice(0, 8)}`;
    const stack = new AsyncLifecycleStack();
    const ownedController = options.signal ? null : new AbortController();
    const signal = options.signal ?? ownedController!.signal;
    const stop = (): void => ownedController?.abort();
    if (ownedController) {
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    }
    try {
        await options.storage.open();
        stack.defer(() => options.storage.close());
        await options.messageBus.open();
        stack.defer(() => options.messageBus.close());
        await options.blobStore.openStore();
        stack.defer(() => options.blobStore.closeStore());
        await options.knowledgeBaseManager.open();
        stack.defer(() => options.knowledgeBaseManager.close());

        const worker = new IndexWorker(
            options.storage,
            options.blobStore,
            options.knowledgeBaseManager,
            options.parsers,
            nodeId,
            {
                chunkers: options.chunkers,
                maxConcurrency: options.workerMaxConcurrency ?? 4,
                parserExecutor: options.parserExecutor,
            }
        );
        const consumer = await new IndexTaskConsumer(
            options.messageBus,
            worker,
            options.consumerMaxBatch ?? 32
        ).start();
        stack.defer(() => consumer.stop());
        logger.info(
            'Index worker %s ready (max_concurrency=%d, max_batch=%d)',
            nodeId,
            options.workerMaxConcurrency ?? 4,
            options.consumerMaxBatch ?? 32
        );
        await aborted(signal);
    } finally {
        logger.info('Index worker %s shutting down', nodeId);
        if (ownedController) {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
        }
        await stack.close();
    }
}

export type WorkerBootstrap = () => RunIndexWorkerOptions | Promise<RunIndexWorkerOptions>;

export async function resolveWorkerBootstrap(reference: string): Promise<WorkerBootstrap> {
    const separator = reference.lastIndexOf(':');
    if (separator <= 0 || separator === reference.length - 1) {
        throw new Error(
            `AGENTSCOPE_WORKER_BOOTSTRAP must be in 'module:export' form, got ${JSON.stringify(reference)}.`
        );
    }
    const moduleName = reference.slice(0, separator);
    const exportName = reference.slice(separator + 1);
    const loaded = (await import(moduleName)) as Record<string, unknown>;
    const factory = loaded[exportName];
    if (typeof factory !== 'function') {
        throw new Error(`Worker bootstrap export '${exportName}' is not callable.`);
    }
    return factory as WorkerBootstrap;
}

export async function runWorkerFromEnvironment(
    environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
    const reference = environment.AGENTSCOPE_WORKER_BOOTSTRAP;
    if (!reference) {
        throw new Error(
            "AGENTSCOPE_WORKER_BOOTSTRAP is required — set it to 'package.module:callable' that returns options for runWorker."
        );
    }
    const bootstrap = await resolveWorkerBootstrap(reference);
    await runWorker(await bootstrap());
}

function aborted(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
    );
}
