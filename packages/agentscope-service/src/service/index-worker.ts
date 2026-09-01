/* eslint-disable jsdoc/require-jsdoc */

import type { ChunkerBase, ParserBase, Section } from '@agentscope-ai/agentscope/rag';
import { ApproxTokenChunker } from '@agentscope-ai/agentscope/rag';
import { lookup as lookupMediaType } from 'mime-types';

import type { BlobStoreBase, KnowledgeBaseManagerBase } from '../rag';
import type { KnowledgeBaseRecord, StorageBase } from '../storage';

interface ParserConstructor {
    supportedMediaTypes?: readonly string[];
}

interface ChunkerConstructor {
    new (parameters?: Record<string, unknown>): ChunkerBase<object>;
}

export type ParserRegistry = ParserBase[] | Record<string, ParserBase>;
export type ParserExecutor = (
    parser: ParserBase,
    bytes: Uint8Array,
    filename: string
) => Promise<Section[]>;

class Semaphore {
    private available: number;
    private readonly waiters: Array<() => void> = [];

    constructor(capacity: number) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error('maxConcurrency must be a positive integer.');
        }
        this.available = capacity;
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.available === 0) await new Promise<void>(resolve => this.waiters.push(resolve));
        else this.available -= 1;
        try {
            return await operation();
        } finally {
            const waiter = this.waiters.shift();
            if (waiter) waiter();
            else this.available += 1;
        }
    }
}

/** Lease-coordinated parse, chunk and vector-index pipeline. */
export class IndexWorker {
    private readonly parsers: Map<string, ParserBase>;
    private readonly chunkers = new Map<string, ChunkerConstructor>();
    private readonly semaphore: Semaphore;
    private readonly renewIntervalMs: number;

    constructor(
        private readonly storage: StorageBase,
        private readonly blobStore: BlobStoreBase,
        private readonly manager: KnowledgeBaseManagerBase,
        parsers: ParserRegistry,
        private readonly nodeId: string,
        options: {
            chunkers?: ChunkerConstructor[];
            maxConcurrency?: number;
            leaseTtlMs?: number;
            parserExecutor?: ParserExecutor | null;
        } = {}
    ) {
        this.parsers = buildParserRegistry(parsers);
        for (const Chunker of options.chunkers ?? [ApproxTokenChunker]) {
            this.chunkers.set(new Chunker({}).chunkerType, Chunker);
        }
        this.semaphore = new Semaphore(options.maxConcurrency ?? 4);
        this.leaseTtlMs = options.leaseTtlMs ?? 90_000;
        this.renewIntervalMs = Math.max(this.leaseTtlMs / 2, 5_000);
        this.parserExecutor = options.parserExecutor ?? null;
    }

    private readonly leaseTtlMs: number;
    private readonly parserExecutor: ParserExecutor | null;

    async process(userId: string, knowledgeBaseId: string, documentId: string): Promise<void> {
        const acquired = await this.storage.acquireKnowledgeDocumentLease({
            userId,
            knowledgeBaseId,
            documentId,
            processingNode: this.nodeId,
            leaseTtlMs: this.leaseTtlMs,
        });
        if (!acquired) return;

        const controller = new AbortController();
        let lostLease = false;
        const heartbeat = this.heartbeat(
            userId,
            knowledgeBaseId,
            documentId,
            controller.signal,
            () => {
                lostLease = true;
            }
        );
        try {
            await this.semaphore.run(() =>
                this.runPipeline(userId, knowledgeBaseId, documentId, () => lostLease)
            );
        } catch (error) {
            await this.markError(userId, knowledgeBaseId, documentId, error);
        } finally {
            controller.abort();
            await heartbeat;
            await this.storage.releaseKnowledgeDocumentLease({
                userId,
                knowledgeBaseId,
                documentId,
                processingNode: this.nodeId,
            });
        }
    }

    private async runPipeline(
        userId: string,
        knowledgeBaseId: string,
        documentId: string,
        lostLease: () => boolean
    ): Promise<void> {
        const document = await this.storage.getKnowledgeDocument(
            userId,
            knowledgeBaseId,
            documentId
        );
        if (!document) return;
        const knowledgeBase = await this.manager.getKnowledgeBase(userId, knowledgeBaseId);
        if (!knowledgeBase) return;
        const chunker = this.resolveChunker(knowledgeBase);
        const mediaType =
            document.data.content_type ?? lookupMediaType(document.data.filename) ?? null;
        if (!mediaType) {
            throw new Error(`Cannot determine media type for '${document.data.filename}'.`);
        }
        const parser = this.parsers.get(mediaType);
        if (!parser) throw new Error(`No parser registered for media type '${mediaType}'.`);

        await this.storage.updateKnowledgeDocumentStatus(
            userId,
            knowledgeBaseId,
            documentId,
            'parsing'
        );
        const bytes = await this.readBlob(document.data.blob_uri);
        const sections = this.parserExecutor
            ? await this.parserExecutor(parser, bytes, document.data.filename)
            : await parser.parse(bytes, document.data.filename);
        this.assertLease(documentId, lostLease);

        await this.storage.updateKnowledgeDocumentStatus(
            userId,
            knowledgeBaseId,
            documentId,
            'chunking'
        );
        const chunks = await chunker.chunk(sections);
        this.assertLease(documentId, lostLease);

        await this.storage.updateKnowledgeDocumentStatus(
            userId,
            knowledgeBaseId,
            documentId,
            'indexing'
        );
        const knowledge = await this.manager.getKnowledge(userId, knowledgeBaseId);
        this.assertLease(documentId, lostLease);
        await knowledge.deleteDocument(documentId);
        this.assertLease(documentId, lostLease);
        await knowledge.insertDocument(chunks, documentId, {
            filename: document.data.filename,
            media_type: mediaType,
            size_bytes: document.data.size,
        });
        this.assertLease(documentId, lostLease);
        await this.storage.updateKnowledgeDocumentStatus(
            userId,
            knowledgeBaseId,
            documentId,
            'ready',
            { chunkCount: chunks.length }
        );
    }

    private resolveChunker(record: KnowledgeBaseRecord): ChunkerBase<object> {
        const config = record.data.chunker_config;
        if (!config) return new ApproxTokenChunker();
        const Chunker = this.chunkers.get(config.type);
        if (!Chunker) return new ApproxTokenChunker();
        try {
            return new Chunker(config.parameters);
        } catch {
            return new ApproxTokenChunker();
        }
    }

    private async readBlob(uri: string): Promise<Uint8Array> {
        const reader = await this.blobStore.open(uri);
        const chunks: Buffer[] = [];
        try {
            while (true) {
                const chunk = await reader.read(1 << 20);
                if (chunk.byteLength === 0) break;
                chunks.push(Buffer.from(chunk));
            }
        } finally {
            await reader.close();
        }
        return Buffer.concat(chunks);
    }

    private async heartbeat(
        userId: string,
        knowledgeBaseId: string,
        documentId: string,
        signal: AbortSignal,
        onLost: () => void
    ): Promise<void> {
        while (!(await wait(this.renewIntervalMs, signal))) {
            const renewed = await this.storage.renewKnowledgeDocumentLease({
                userId,
                knowledgeBaseId,
                documentId,
                processingNode: this.nodeId,
                leaseTtlMs: this.leaseTtlMs,
            });
            if (!renewed) {
                onLost();
                return;
            }
        }
    }

    private assertLease(documentId: string, lostLease: () => boolean): void {
        if (lostLease()) {
            throw new Error(
                `Lost lease on ${documentId} during processing; another worker has taken over.`
            );
        }
    }

    private async markError(
        userId: string,
        knowledgeBaseId: string,
        documentId: string,
        error: unknown
    ): Promise<void> {
        try {
            await this.storage.updateKnowledgeDocumentStatus(
                userId,
                knowledgeBaseId,
                documentId,
                'error',
                { error: sanitizeIndexError(error) }
            );
        } catch {
            // This is the terminal error sink; persistence failure cannot be recovered here.
        }
    }
}

export function buildParserRegistry(parsers: ParserRegistry): Map<string, ParserBase> {
    if (!Array.isArray(parsers)) return new Map(Object.entries(parsers));
    const registry = new Map<string, ParserBase>();
    for (const parser of parsers) {
        const constructor = parser.constructor as typeof ParserBase & ParserConstructor;
        for (const mediaType of constructor.supportedMediaTypes ?? []) {
            registry.set(mediaType, parser);
        }
    }
    return registry;
}

export function sanitizeIndexError(error: unknown): string {
    const name = error instanceof Error ? error.constructor.name : 'Error';
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split(/\r?\n/, 1)[0].trim();
    return firstLine ? `${name}: ${firstLine.slice(0, 240)}` : name;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
        if (signal.aborted) return resolve(true);
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve(false);
        }, milliseconds);
        const abort = (): void => {
            clearTimeout(timer);
            resolve(true);
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}
