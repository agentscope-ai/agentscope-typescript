import { z } from 'zod';

import { ChunkerConfigSchema, EmbeddingModelConfigSchema } from '../../storage';

export const CreateKnowledgeBaseRequestSchema = z.object({
    name: z.string(),
    description: z.string().default(''),
    embedding_model_config: EmbeddingModelConfigSchema,
    chunker_config: ChunkerConfigSchema.nullable().optional(),
});

export const UpdateKnowledgeBaseRequestSchema = z.object({
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
});

const booleanQuery = z.preprocess(value => {
    if (typeof value !== 'string') return value;
    const normalized = value.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'off', 'no'].includes(normalized)) return false;
    return value;
}, z.boolean());

export const KnowledgeBaseListQuerySchema = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(128).default(30),
    orderby: z.enum(['create_time', 'update_time']).default('create_time'),
    desc: booleanQuery.default(true),
});

export const KnowledgeDocumentListQuerySchema = z.object({
    id: z.string().optional(),
    keywords: z.string().optional(),
    status: z.enum(['pending', 'parsing', 'chunking', 'indexing', 'ready', 'error']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(128).default(30),
    orderby: z.enum(['create_time', 'update_time']).default('create_time'),
    desc: booleanQuery.default(true),
});

export const DocumentStatusQuerySchema = z.object({ ids: z.string() });
export const DocumentChunksQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(128).default(30),
});
export const SearchKnowledgeBaseRequestSchema = z.object({
    query: z.string(),
    top_k: z.number().int().min(1).max(50).default(5),
});

export const DocumentDownloadQuerySchema = z.object({
    download: booleanQuery.default(false),
    token: z.string().optional(),
});
