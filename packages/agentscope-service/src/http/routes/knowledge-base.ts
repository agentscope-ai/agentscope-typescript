/* eslint-disable jsdoc/require-description, jsdoc/require-returns */

import { CredentialFactory } from '@agentscope-ai/agentscope/credential';
import { RAGParameters } from '@agentscope-ai/agentscope/middleware';
import type { ParserBase } from '@agentscope-ai/agentscope/rag';
import { z } from 'zod';

import { signDownloadToken, verifyDownloadToken } from '../../service';
import type { KnowledgeDocumentRecord } from '../../storage';
import { HTTPError } from '../errors';
import {
    emptyResponse,
    iterableResponse,
    jsonResponse,
    quoteHeaderFilename,
    streamingContentType,
} from '../response';
import type { AgentScopeHTTPRouter, HTTPContext } from '../router';
import {
    CreateKnowledgeBaseRequestSchema,
    DocumentChunksQuerySchema,
    DocumentDownloadQuerySchema,
    DocumentStatusQuerySchema,
    KnowledgeBaseListQuerySchema,
    KnowledgeDocumentListQuerySchema,
    SearchKnowledgeBaseRequestSchema,
    UpdateKnowledgeBaseRequestSchema,
} from '../schemas';

const INLINE_MEDIA_TYPES = new Set([
    'text/plain',
    'text/markdown',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
]);

/**
 * Register knowledge-base metadata, document, search, and download routes.
 * @param router
 */
export function registerKnowledgeBaseRoutes(router: AgentScopeHTTPRouter): void {
    registerCapabilities(router);
    registerKnowledgeBases(router);
    registerDocuments(router);
}

/**
 *
 * @param router
 */
function registerCapabilities(router: AgentScopeHTTPRouter): void {
    router.get('/knowledge_bases/embedding_models', async context => {
        const userId = context.userId();
        const manager = requireKnowledgeManager(context);
        const policy = await manager.getDimensionPolicy();
        const credentials = await context.app.services.resourceAccess.listResource(
            userId,
            'credential'
        );
        const providers = [];
        for (const credential of credentials) {
            try {
                const instance = CredentialFactory.fromDict(credential.data);
                const models = instance
                    .listEmbeddingModels()
                    .map(card => policy.filterCard(card))
                    .filter(card => card !== null);
                if (models.length > 0) providers.push({ credential, models });
            } catch {}
        }
        return jsonResponse({ providers, policy });
    });
    router.get('/knowledge_bases/chunkers', context => {
        context.userId();
        const chunkers = (context.app.knowledgeChunkers ?? []).map(Chunker => {
            const instance = new Chunker({});
            return {
                type: instance.chunkerType,
                parameter_schema: instance.parameterSchema,
            };
        });
        return jsonResponse({ chunkers });
    });
    router.get('/knowledge_bases/middleware/parameters_schema', context => {
        context.userId();
        return jsonResponse({ parameter_schema: RAGParameters.modelJsonSchema() });
    });
    router.get('/knowledge_bases/supported_content_types', context => {
        context.userId();
        const parsers = context.app.knowledgeParsers;
        const values = Array.isArray(parsers) ? parsers : Object.values(parsers ?? {});
        const mediaTypes = new Set<string>();
        const extensions = new Set<string>();
        for (const parser of values) {
            const Parser = parser.constructor as typeof ParserBase;
            for (const value of Parser.supportedMediaTypes) mediaTypes.add(value);
            for (const value of Parser.supportedExtensions) extensions.add(value);
        }
        return jsonResponse({
            media_types: [...mediaTypes].sort(),
            extensions: [...extensions].sort(),
        });
    });
}

/**
 *
 * @param router
 */
function registerKnowledgeBases(router: AgentScopeHTTPRouter): void {
    router.post('/knowledge_bases/', async context => {
        const body = (await context.json(CreateKnowledgeBaseRequestSchema)) as z.output<
            typeof CreateKnowledgeBaseRequestSchema
        >;
        const record = await requireKnowledgeService(context).createKnowledgeBase({
            userId: context.userId(),
            name: body.name,
            description: body.description,
            embeddingModelConfig: body.embedding_model_config,
            chunkerConfig: body.chunker_config,
        });
        return jsonResponse({ knowledge_base_id: record.id }, 201);
    });
    router.get('/knowledge_bases/', async context => {
        const query = context.query(KnowledgeBaseListQuerySchema) as z.output<
            typeof KnowledgeBaseListQuerySchema
        >;
        const [knowledgeBases, total] = await requireKnowledgeService(
            context
        ).listKnowledgeBaseViews(context.userId(), {
            knowledgeBaseId: query.id,
            name: query.name,
            page: query.page,
            pageSize: query.page_size,
            orderBy: query.orderby,
            descending: query.desc,
        });
        return jsonResponse({
            knowledge_bases: knowledgeBases,
            total,
            page: query.page,
            page_size: query.page_size,
        });
    });
    router.patch('/knowledge_bases/{knowledge_base_id}', async context => {
        const body = (await context.json(UpdateKnowledgeBaseRequestSchema)) as z.output<
            typeof UpdateKnowledgeBaseRequestSchema
        >;
        const record = await requireKnowledgeService(context).updateKnowledgeBase(
            context.userId(),
            context.params.knowledge_base_id,
            body
        );
        const { data, ...envelope } = record;
        const { collection_name: _collectionName, ...safeData } = data;
        return jsonResponse({ ...envelope, ...safeData, editable: true });
    });
    router.delete('/knowledge_bases/{knowledge_base_id}', async context => {
        await requireKnowledgeService(context).deleteKnowledgeBase(
            context.userId(),
            context.params.knowledge_base_id
        );
        return emptyResponse();
    });
}

/**
 *
 * @param router
 */
function registerDocuments(router: AgentScopeHTTPRouter): void {
    router.get('/knowledge_bases/{knowledge_base_id}/documents', async context => {
        const query = context.query(KnowledgeDocumentListQuerySchema) as z.output<
            typeof KnowledgeDocumentListQuerySchema
        >;
        const [documents, total] = await requireKnowledgeService(context).listDocuments(
            context.userId(),
            context.params.knowledge_base_id,
            {
                documentId: query.id,
                keywords: query.keywords,
                status: query.status,
                page: query.page,
                pageSize: query.page_size,
                orderBy: query.orderby,
                descending: query.desc,
            }
        );
        return jsonResponse({
            documents: documents.map(documentView),
            total,
            page: query.page,
            page_size: query.page_size,
        });
    });
    router.get('/knowledge_bases/{knowledge_base_id}/documents/status', async context => {
        const { ids } = context.query(DocumentStatusQuerySchema) as z.output<
            typeof DocumentStatusQuerySchema
        >;
        const records = await requireKnowledgeService(context).getDocumentStatus(
            context.userId(),
            context.params.knowledge_base_id,
            ids
                .split(',')
                .map(value => value.trim())
                .filter(Boolean)
        );
        return jsonResponse({ items: records.map(documentView) });
    });
    router.post('/knowledge_bases/{knowledge_base_id}/documents', async context => {
        let form: FormData;
        try {
            form = await context.request.formData();
        } catch {
            throw new HTTPError(422, 'Invalid multipart form data.');
        }
        const file = form.get('file');
        if (!(file instanceof File)) throw new HTTPError(422, 'Field required: file');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const record = await requireKnowledgeService(context).registerDocument({
            userId: context.userId(),
            knowledgeBaseId: context.params.knowledge_base_id,
            filename: file.name || 'uploaded_file',
            stream: new BufferReader(bytes),
            size: file.size,
            contentType: String(form.get('content_type') || file.type || '') || null,
        });
        return jsonResponse(
            {
                document_id: record.id,
                filename: record.data.filename,
                status: record.status,
            },
            201
        );
    });
    router.delete('/knowledge_bases/{knowledge_base_id}/documents/{document_id}', async context => {
        await requireKnowledgeService(context).deleteDocument(
            context.userId(),
            context.params.knowledge_base_id,
            context.params.document_id
        );
        return emptyResponse();
    });
    router.post('/knowledge_bases/{knowledge_base_id}/search', async context => {
        const body = (await context.json(SearchKnowledgeBaseRequestSchema)) as z.output<
            typeof SearchKnowledgeBaseRequestSchema
        >;
        const results = await requireKnowledgeService(context).search(
            context.userId(),
            context.params.knowledge_base_id,
            body.query,
            body.top_k
        );
        return jsonResponse({ results, total: results.length });
    });
    router.get(
        '/knowledge_bases/{knowledge_base_id}/documents/{document_id}/chunks',
        async context => {
            const query = context.query(DocumentChunksQuerySchema) as z.output<
                typeof DocumentChunksQuerySchema
            >;
            const [chunks, total] = await requireKnowledgeService(context).listDocumentChunks(
                context.userId(),
                context.params.knowledge_base_id,
                context.params.document_id,
                { page: query.page, pageSize: query.page_size }
            );
            return jsonResponse({ chunks, total, page: query.page, page_size: query.page_size });
        }
    );
    router.post(
        '/knowledge_bases/{knowledge_base_id}/documents/{document_id}/download_token',
        async context => {
            await requireKnowledgeService(context).getDocument(
                context.userId(),
                context.params.knowledge_base_id,
                context.params.document_id
            );
            const result = signDownloadToken(
                context.app.downloadSecret,
                context.userId(),
                documentTokenPath(context),
                600
            );
            return jsonResponse({ token: result.token, expires_at: result.expiresAt });
        }
    );
    router.get('/knowledge_bases/{knowledge_base_id}/documents/{document_id}', async context => {
        const query = context.query(DocumentDownloadQuerySchema) as z.output<
            typeof DocumentDownloadQuerySchema
        >;
        let userId = context.request.headers.get('x-user-id');
        if (query.token) {
            try {
                userId = verifyDownloadToken(
                    context.app.downloadSecret,
                    query.token,
                    documentTokenPath(context)
                );
            } catch (error) {
                throw new HTTPError(401, error instanceof Error ? error.message : String(error));
            }
        }
        if (!userId) throw new HTTPError(401, 'X-User-ID header or download token is required.');
        const { document, size, content } = await requireKnowledgeService(
            context
        ).streamDocumentContent(
            userId,
            context.params.knowledge_base_id,
            context.params.document_id
        );
        const mediaType =
            document.data.content_type?.split(';')[0].trim().toLowerCase() ||
            'application/octet-stream';
        const disposition =
            !query.download && INLINE_MEDIA_TYPES.has(mediaType) ? 'inline' : 'attachment';
        const headers = new Headers({
            'content-type': streamingContentType(mediaType),
            'content-disposition': `${disposition}; filename*=UTF-8''${quoteHeaderFilename(document.data.filename || 'download')}`,
            'cache-control': 'private, max-age=60',
            'x-content-type-options': 'nosniff',
        });
        if (size !== null) headers.set('content-length', String(size));
        return iterableResponse(content, { headers });
    });
}

/**
 *
 * @param context
 */
function requireKnowledgeService(context: HTTPContext) {
    const service = context.app.services.knowledgeBase;
    if (!service) throw new HTTPError(503, 'Knowledge base feature is disabled.');
    return service;
}

/**
 *
 * @param context
 */
function requireKnowledgeManager(context: HTTPContext) {
    if (!context.app.knowledgeBaseManager) {
        throw new HTTPError(503, 'Knowledge base feature is disabled.');
    }
    return context.app.knowledgeBaseManager;
}

/**
 *
 * @param record
 */
function documentView(record: KnowledgeDocumentRecord) {
    return {
        id: record.id,
        filename: record.data.filename,
        size: record.data.size,
        content_type: record.data.content_type,
        chunk_count: record.data.chunk_count,
        status: record.status,
        error: record.data.error,
        created_at: record.created_at,
        updated_at: record.updated_at,
    };
}

/**
 *
 * @param context
 */
function documentTokenPath(context: HTTPContext): string {
    return `kb/${context.params.knowledge_base_id}/${context.params.document_id}`;
}

/**
 *
 */
class BufferReader {
    private offset = 0;
    /**
     *
     * @param value
     */
    constructor(private readonly value: Uint8Array) {}
    /**
     *
     * @param size
     */
    read(size: number): Uint8Array | null {
        if (this.offset >= this.value.byteLength) return null;
        const chunk = this.value.subarray(this.offset, this.offset + size);
        this.offset += chunk.byteLength;
        return chunk;
    }
}
