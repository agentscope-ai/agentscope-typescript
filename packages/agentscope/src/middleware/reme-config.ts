/* eslint-disable jsdoc/require-jsdoc */

export type ReMeConfig = Record<string, unknown>;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function objectSchema(
    properties: Record<string, unknown>,
    required: string[] = []
): Record<string, unknown> {
    return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
    };
}

function job(
    step: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
    stepOptions: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        backend: 'base',
        description,
        parameters: objectSchema(properties, required),
        steps: [{ backend: step, ...stepOptions }],
    };
}

function dreamSteps(): Record<string, unknown>[] {
    return [
        {
            backend: 'dream_extract_step',
            file_catalog: 'dream',
            topic_session_id: 'interests',
            scan_days: 2,
            max_units: 5,
        },
        { backend: 'dream_integrate_step' },
        {
            backend: 'dream_topics_step',
            topic_count: 3,
            topic_diversity_days: 7,
        },
        { backend: 'dream_finish_step', file_catalog: 'dream' },
    ];
}

function memoryJobs(): Record<string, unknown> {
    const string = { type: 'string' };
    return {
        index_update_loop: {
            backend: 'background',
            max_file_bytes: MAX_FILE_BYTES,
            watch_dirs: ['daily_dir', 'digest_dir'],
            watch_suffixes: ['md'],
            steps: [
                {
                    backend: 'init_changes_step',
                    monitor_type: 'file_store',
                    monitor_name: 'default',
                    dispatch_steps: ['update_index_step'],
                },
                {
                    backend: 'watch_changes_step',
                    dispatch_steps: [{ backend: 'update_index_step', persist: false }],
                },
            ],
        },
        search: job(
            'search_step',
            'Search conversation memory cards.',
            {
                query: string,
                limit: { type: 'integer', default: 5 },
                min_score: { type: 'number', default: 0.0 },
            },
            ['query'],
            { vector_weight: 0.7, candidate_multiplier: 3.0, expand_links: false }
        ),
        reindex: {
            backend: 'base',
            description: 'Rebuild the conversation-memory search index.',
            max_file_bytes: MAX_FILE_BYTES,
            watch_dirs: ['daily_dir', 'digest_dir'],
            watch_suffixes: ['md'],
            parameters: objectSchema({}),
            steps: [
                { backend: 'clear_store_step' },
                {
                    backend: 'init_changes_step',
                    monitor_type: 'file_store',
                    monitor_name: 'default',
                    dispatch_steps: ['update_index_step'],
                },
            ],
        },
        auto_memory: job(
            'auto_memory_step',
            'Record conversation facts into a daily memory card.',
            {
                messages: { type: 'array', items: { type: 'object' } },
                session_id: { type: 'string', default: '' },
                memory_hint: string,
            },
            ['messages']
        ),
        dream_cron: {
            backend: 'cron',
            cron: '0 23 * * *',
            steps: dreamSteps(),
        },
        auto_dream: {
            backend: 'base',
            description:
                'Consolidate daily conversation memory into digest nodes and interest topics.',
            parameters: objectSchema({
                date: { type: 'string', default: '' },
                hint: { type: 'string', default: '' },
                scan_days: { type: 'integer', default: 2 },
                max_units: { type: 'integer', default: 5 },
                topic_count: { type: 'integer', default: 3 },
                topic_diversity_days: { type: 'integer', default: 7 },
            }),
            steps: dreamSteps(),
        },
        node_search: job(
            'node_search_step',
            'Find related digest nodes during dream consolidation.',
            { query: string, limit: { type: 'integer', default: 20 } },
            ['query'],
            { vector_weight: 0.7, candidate_multiplier: 5.0 }
        ),
        daily_list: job('daily_list_step', 'List memory cards under one day.', {
            date: { type: 'string', default: '' },
        }),
        frontmatter_update: job(
            'frontmatter_update_step',
            "Merge fields into a memory card's frontmatter.",
            { path: string, metadata: { type: 'object' } },
            ['path', 'metadata']
        ),
        frontmatter_read: job(
            'frontmatter_read_step',
            "Read a memory card's frontmatter.",
            { path: string },
            ['path']
        ),
        move: job(
            'move_step',
            'Rename a memory card.',
            {
                src_path: string,
                dst_path: string,
                overwrite: { type: 'boolean', default: false },
                retarget: { type: 'boolean', default: true },
            },
            ['src_path', 'dst_path']
        ),
        read: job(
            'read_step',
            'Read a memory card.',
            {
                path: string,
                start_line: { type: 'integer' },
                end_line: { type: 'integer' },
            },
            ['path'],
            { with_neighbors: false }
        ),
        write: job(
            'write_step',
            'Write a memory card with frontmatter.',
            {
                path: string,
                name: string,
                description: string,
                content: string,
                metadata: { type: 'object' },
            },
            ['path', 'name', 'description', 'content']
        ),
        daily_write: job(
            'daily_write_step',
            'Create a daily conversation memory card.',
            {
                name: string,
                description: string,
                session_id: string,
                content: string,
                date: { type: 'string', default: '' },
                metadata: { type: 'object' },
            },
            ['name', 'description', 'session_id', 'content']
        ),
        edit: job(
            'edit_step',
            'Replace text in a memory card.',
            {
                path: string,
                old: string,
                new: { type: 'string', default: '' },
            },
            ['path', 'old', 'new']
        ),
    };
}

function memoryComponents(embeddingDimensions?: number | null): Record<string, unknown> {
    const components: Record<string, Record<string, Record<string, unknown>>> = {
        tokenizer: { default: { backend: 'regex' } },
        as_llm: {
            default: {
                backend: process.env.LLM_BACKEND ?? 'openai',
                model: process.env.LLM_MODEL_NAME ?? 'qwen3.7-plus',
                stream: true,
                context_size: 200_000,
                max_retries: 3,
                credential: {
                    api_key: process.env.LLM_API_KEY ?? '',
                    base_url: process.env.LLM_BASE_URL ?? '',
                },
                parameters: { max_tokens: 65_536, thinking_enable: false },
            },
        },
        agent_wrapper: {
            default: {
                backend: 'agentscope',
                as_llm: 'default',
                builtin_tools: false,
                permission_mode: 'bypass',
                react_config: { max_iters: 30 },
                context_config: {
                    trigger_ratio: 0.8,
                    reserve_ratio: 0.1,
                    tool_result_limit: 50_000,
                },
                model_config: { max_retries: 1 },
            },
        },
        file_graph: { default: { backend: 'local' } },
        file_catalog: { dream: { backend: 'local' } },
        file_chunker: {
            markdown: { backend: 'markdown', supported_extensions: ['md'] },
        },
        keyword_index: { default: { backend: 'bm25', tokenizer: 'default' } },
        file_store: {
            default: {
                backend: 'local',
                store_name: 'local',
                embedding_store: '',
                keyword_index: 'default',
                file_graph: 'default',
            },
        },
    };

    if (embeddingDimensions != null) {
        components.as_embedding = {
            default: {
                backend: 'openai',
                model: 'agentscope-injected',
                dimensions: embeddingDimensions,
                credential: { api_key: '', base_url: '' },
                parameters: {},
            },
        };
        components.embedding_store = {
            default: {
                backend: 'local',
                as_embedding: 'default',
                enable_cache: true,
                max_cache_size: 3_000,
                max_input_length: 8_192,
                max_batch_size: 10,
            },
        };
        components.file_store.default.embedding_store = 'default';
    }
    return components;
}

/**
 * Build a fresh AgentScope-owned minimal ReMe application configuration.
 * @param options Configuration inputs.
 * @param options.workspaceDir Camel-case workspace path.
 * @param options.workspace_dir Python-compatible workspace path.
 * @param options.embeddingDimensions Camel-case embedding dimensions.
 * @param options.embedding_dimensions Python-compatible embedding dimensions.
 * @returns A standalone ReMe application configuration.
 */
export function buildReMeAppConfig(options: {
    workspaceDir?: string;
    workspace_dir?: string;
    embeddingDimensions?: number | null;
    embedding_dimensions?: number | null;
}): ReMeConfig {
    const workspaceDir = options.workspaceDir ?? options.workspace_dir;
    if (!workspaceDir) throw new Error('workspaceDir is required.');
    return {
        workspace_dir: workspaceDir,
        enable_logo: false,
        log_to_console: false,
        service: { backend: 'http' },
        jobs: memoryJobs(),
        components: memoryComponents(
            options.embeddingDimensions ?? options.embedding_dimensions ?? null
        ),
    };
}
