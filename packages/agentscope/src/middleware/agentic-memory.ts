/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { _estimateBytes, _estimateTokens } from '../_utils';
import type { Agent } from '../agent';
import { HintBlock, SystemMsg, UserMsg, getTextContent, type Msg } from '../message';
import type { ChatModelBase } from '../model';
import { BackendBase, LocalBackend } from '../tool';
import {
    DEFAULT_MEMORY_INSTRUCTIONS,
    DEFAULT_RETRIEVAL_INSTRUCTIONS,
} from './agentic-memory-prompts';
import { MiddlewareBase } from './base';
import type { AgentStream, ReasoningHookInput, ReasoningStream, ReplyHookInput } from './base';

interface MemoryFileHeader {
    filename: string;
    path: string;
    description: string | null;
    type: string | null;
    mtime: number | null;
}

interface TrackedRetrieval {
    promise: Promise<string | null>;
    settled: boolean;
    value: string | null;
}

export interface AgenticMemoryParametersOptions {
    memoryMaxTokens?: number;
    memory_max_tokens?: number;
    memoryInstructions?: string;
    memory_instructions?: string;
    retrievalAsync?: boolean;
    retrieval_async?: boolean;
    retrievalModel?: ChatModelBase | null;
    retrieval_model?: ChatModelBase | null;
    retrievalMaxTokensPerMd?: number;
    retrieval_max_tokens_per_md?: number;
    retrievalMaxFiles?: number;
    retrieval_max_files?: number;
    retrievalMaxTokensPerFrontmatter?: number;
    retrieval_max_tokens_per_frontmatter?: number;
    retrievalInstructions?: string;
    retrieval_instructions?: string;
}

/** Frozen user-tunable parameters for filesystem-backed long-term memory. */
export class AgenticMemoryParameters {
    readonly memoryMaxTokens: number;
    readonly memoryInstructions: string;
    readonly retrievalAsync: boolean;
    readonly retrievalModel: ChatModelBase | null;
    readonly retrievalMaxTokensPerMd: number;
    readonly retrievalMaxFiles: number;
    readonly retrievalMaxTokensPerFrontmatter: number;
    readonly retrievalInstructions: string;

    constructor(options: AgenticMemoryParametersOptions = {}) {
        this.memoryMaxTokens = options.memoryMaxTokens ?? options.memory_max_tokens ?? 4_000;
        this.memoryInstructions =
            options.memoryInstructions ??
            options.memory_instructions ??
            DEFAULT_MEMORY_INSTRUCTIONS;
        this.retrievalAsync = options.retrievalAsync ?? options.retrieval_async ?? true;
        this.retrievalModel = options.retrievalModel ?? options.retrieval_model ?? null;
        this.retrievalMaxTokensPerMd =
            options.retrievalMaxTokensPerMd ?? options.retrieval_max_tokens_per_md ?? 2_000;
        this.retrievalMaxFiles = options.retrievalMaxFiles ?? options.retrieval_max_files ?? 200;
        this.retrievalMaxTokensPerFrontmatter =
            options.retrievalMaxTokensPerFrontmatter ??
            options.retrieval_max_tokens_per_frontmatter ??
            256;
        this.retrievalInstructions =
            options.retrievalInstructions ??
            options.retrieval_instructions ??
            DEFAULT_RETRIEVAL_INSTRUCTIONS;
        this.validate();
        Object.freeze(this);
    }

    toJSON(): Record<string, unknown> {
        return {
            memory_max_tokens: this.memoryMaxTokens,
            memory_instructions: this.memoryInstructions,
            retrieval_async: this.retrievalAsync,
            retrieval_model: this.retrievalModel,
            retrieval_max_tokens_per_md: this.retrievalMaxTokensPerMd,
            retrieval_max_files: this.retrievalMaxFiles,
            retrieval_max_tokens_per_frontmatter: this.retrievalMaxTokensPerFrontmatter,
            retrieval_instructions: this.retrievalInstructions,
        };
    }

    private validate(): void {
        for (const [name, value] of [
            ['memory_max_tokens', this.memoryMaxTokens],
            ['retrieval_max_tokens_per_md', this.retrievalMaxTokensPerMd],
            ['retrieval_max_files', this.retrievalMaxFiles],
            ['retrieval_max_tokens_per_frontmatter', this.retrievalMaxTokensPerFrontmatter],
        ] as const) {
            if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
        }
    }
}

export interface AgenticMemoryMiddlewareOptions {
    workdir: string;
    memoryDir?: string;
    memory_dir?: string;
    parameters?: AgenticMemoryParameters | AgenticMemoryParametersOptions | null;
    backend?: BackendBase | null;
}

/** Markdown-based long-term memory with asynchronous relevance retrieval. */
export class AgenticMemoryMiddleware extends MiddlewareBase {
    static readonly Parameters = AgenticMemoryParameters;
    static readonly FILENAME_MEMORY_MD = 'MEMORY.md';
    private static readonly frontmatterPattern = /^\s*---\s*\n(?<body>.*?)\n---\s*\n/s;
    private static readonly fieldPattern = /^(?<key>\w+)\s*:\s*(?<value>.+)$/gm;

    private readonly workdir: string;
    private readonly memoryDirName: string;
    private readonly parameters: AgenticMemoryParameters;
    private readonly backend: BackendBase;
    private cachedInput: string | null = null;
    private retrievalTask: TrackedRetrieval | null = null;

    constructor(options: AgenticMemoryMiddlewareOptions) {
        super();
        this.workdir = options.workdir;
        this.memoryDirName = options.memoryDir ?? options.memory_dir ?? 'Memory';
        this.parameters =
            options.parameters instanceof AgenticMemoryParameters
                ? options.parameters
                : new AgenticMemoryParameters(options.parameters ?? {});
        this.backend = options.backend ?? new LocalBackend();
    }

    static truncateIfNeeded(content: string, maxLength: number): string {
        if (maxLength <= 0) return '';
        const tokens = _estimateTokens(content);
        if (tokens <= maxLength) return content;
        let index = Math.floor((maxLength / tokens) * content.length);
        while (index > 0 && _estimateTokens(content.slice(0, index)) > maxLength) {
            index = Math.max(0, index - 10);
        }
        return content.slice(0, index);
    }

    async onSystemPrompt(_agent: Agent, currentPrompt: string): Promise<string> {
        await this.ensureLayout();
        const content = (await this.getMemoryMdContent()) ?? '';
        let snapshot = AgenticMemoryMiddleware.truncateIfNeeded(
            content,
            this.parameters.memoryMaxTokens
        );
        if (snapshot.length !== content.length) {
            const remainingLines = snapshot.split('\n').length;
            const omittedLines = content.split('\n').length - remainingLines;
            snapshot +=
                '\n<<<TRUNCATED>>>\n<system-reminder>The remaining ' +
                `${omittedLines} lines have been omitted due to context length limits. ` +
                `Use the \`Read\` tool with offset \`${remainingLines}\` to access the rest ` +
                `of '${this.getMemoryMdPath()}'.</system-reminder>`;
        }
        if (!snapshot) {
            snapshot =
                'Your MEMORY.md is currently empty. When you save new memories, they will appear here.';
        }
        const instructions = this.parameters.memoryInstructions.replaceAll(
            '{memory_dir}',
            this.getMemoryDir()
        );
        return `${currentPrompt}\n\n${instructions}\n## MEMORY.md\n${snapshot}`;
    }

    async *onReply(agent: Agent, input: ReplyHookInput, next: () => AgentStream): AgentStream {
        if (this.parameters.retrievalAsync) {
            const messages = normalizeMessages(input.inputs);
            if (messages !== null) {
                this.cachedInput = messages
                    .flatMap(message => {
                        const content = getTextContent(message);
                        return content === null ? [] : [`${message.name}: ${content}`];
                    })
                    .join('\n');
            }
            if (this.cachedInput) this.retrievalTask = this.trackRetrieval(agent, this.cachedInput);
        }
        try {
            yield* next();
        } finally {
            this.retrievalTask = null;
            this.cachedInput = null;
        }
    }

    async *onReasoning(
        agent: Agent,
        _input: ReasoningHookInput,
        next: () => ReasoningStream
    ): ReasoningStream {
        const task = this.retrievalTask;
        if (task?.settled) {
            this.retrievalTask = null;
            if (task.value) {
                agent.state.appendContext({
                    name: agent.name,
                    blocks: [HintBlock({ hint: task.value })],
                });
            }
        }
        yield* next();
    }

    static formatManifest(headers: MemoryFileHeader[]): string {
        return headers
            .map(header => {
                const tag = header.type ? `[${header.type}] ` : '';
                const timestamp =
                    header.mtime === null
                        ? 'unknown'
                        : formatLocalDate(new Date(header.mtime * 1_000));
                const description = header.description ? `: ${header.description}` : '';
                return `- ${tag}${header.filename} (${timestamp})${description}`;
            })
            .join('\n');
    }

    private trackRetrieval(agent: Agent, query: string): TrackedRetrieval {
        const tracked: TrackedRetrieval = {
            promise: Promise.resolve(null),
            settled: false,
            value: null,
        };
        tracked.promise = this.retrieveRelevantFiles(agent, query)
            .catch(() => null)
            .then(value => {
                tracked.value = value;
                tracked.settled = true;
                return value;
            });
        return tracked;
    }

    private async retrieveRelevantFiles(agent: Agent, query: string): Promise<string | null> {
        await this.ensureLayout();
        const headers = await this.listMdFiles();
        if (headers.length === 0) return null;
        const validFilenames = new Set(headers.map(header => header.filename));
        const model = this.parameters.retrievalModel ?? agent.model;
        const response = await model.generateStructuredOutput({
            messages: [
                SystemMsg({ name: 'system', content: this.parameters.retrievalInstructions }),
                UserMsg({
                    name: 'user',
                    content:
                        `Query: ${query}\n\nAvailable memories:\n` +
                        AgenticMemoryMiddleware.formatManifest(headers),
                }),
            ],
            schema: z.object({
                selected_files: z
                    .array(z.string())
                    .describe(
                        "Filenames of the memory files to surface, relative to the memory directory (e.g. 'user_role.md'). Up to 5 entries."
                    ),
            }),
        });
        const raw = response.content.selected_files;
        const selected = (Array.isArray(raw) ? raw : [])
            .filter((item): item is string => typeof item === 'string' && validFilenames.has(item))
            .slice(0, 5);
        if (selected.length === 0) return null;

        const byFilename = new Map(headers.map(header => [header.filename, header]));
        const parts: string[] = [];
        for (const filename of selected) {
            const header = byFilename.get(filename)!;
            try {
                let content = (await this.backend.readFile(header.path)).toString('utf8');
                content = AgenticMemoryMiddleware.truncateIfNeeded(
                    content,
                    this.parameters.retrievalMaxTokensPerMd
                );
                let title = `Memory: ${header.path}:`;
                if (header.mtime !== null) {
                    const days = Math.max(
                        0,
                        Math.trunc((Date.now() / 1_000 - header.mtime) / 86_400)
                    );
                    const age =
                        days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
                    title = `Memory (saved ${age}): ${header.path}:`;
                }
                parts.push(`${title}\n\n${content}`);
            } catch {
                continue;
            }
        }
        return parts.length === 0 ? null : parts.join('\n\n---\n\n');
    }

    private async ensureLayout(): Promise<void> {
        const memoryMd = this.getMemoryMdPath();
        if (!(await this.backend.fileExists(memoryMd))) {
            await this.backend.writeFile(memoryMd, Buffer.alloc(0));
        }
    }

    private getMemoryDir(): string {
        return this.backend.joinPath(this.workdir, this.memoryDirName);
    }

    private getMemoryMdPath(): string {
        return this.backend.joinPath(
            this.getMemoryDir(),
            AgenticMemoryMiddleware.FILENAME_MEMORY_MD
        );
    }

    private async getMemoryMdContent(): Promise<string | null> {
        const memoryMd = this.getMemoryMdPath();
        if (!(await this.backend.fileExists(memoryMd))) return null;
        return (await this.backend.readFile(memoryMd)).toString('utf8');
    }

    static parseFrontmatterFields(content: string): Record<string, string> {
        const match = AgenticMemoryMiddleware.frontmatterPattern.exec(content);
        if (!match?.groups?.body) return {};
        const fields: Record<string, string> = {};
        AgenticMemoryMiddleware.fieldPattern.lastIndex = 0;
        for (const field of match.groups.body.matchAll(AgenticMemoryMiddleware.fieldPattern)) {
            if (field.groups) fields[field.groups.key] = field.groups.value.trim();
        }
        return fields;
    }

    private async listMdFiles(): Promise<MemoryFileHeader[]> {
        const memoryDir = this.getMemoryDir();
        let entries: string[];
        try {
            entries = await this.backend.listDirectory(memoryDir, true);
        } catch {
            return [];
        }
        const normalizedDir = this.backend.normalizePath(memoryDir);
        const markerPath = this.backend.joinPath(normalizedDir, '__memory_file__');
        const directoryPrefix = markerPath.slice(0, -'__memory_file__'.length);
        const headers: MemoryFileHeader[] = [];
        for (const entry of entries) {
            const normalizedEntry = this.backend.normalizePath(entry);
            let filename: string;
            let fullPath: string;
            if (this.backend.isAbsolute(normalizedEntry)) {
                if (!normalizedEntry.startsWith(directoryPrefix)) continue;
                filename = normalizedEntry.slice(directoryPrefix.length);
                fullPath = normalizedEntry;
            } else {
                filename = normalizedEntry;
                fullPath = this.backend.joinPath(memoryDir, filename);
            }
            if (
                !filename.endsWith('.md') ||
                filename === AgenticMemoryMiddleware.FILENAME_MEMORY_MD
            ) {
                continue;
            }
            try {
                const raw = await this.backend.readFile(fullPath);
                const snippet = raw
                    .subarray(0, _estimateBytes(this.parameters.retrievalMaxTokensPerFrontmatter))
                    .toString('utf8');
                const fields = AgenticMemoryMiddleware.parseFrontmatterFields(snippet);
                headers.push({
                    filename,
                    path: fullPath,
                    description: fields.description || null,
                    type: fields.type || null,
                    mtime: await this.backend.statMtime(fullPath),
                });
            } catch {
                continue;
            }
        }
        headers.sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0));
        return headers.slice(0, this.parameters.retrievalMaxFiles);
    }
}

function normalizeMessages(value: ReplyHookInput['inputs']): Msg[] | null {
    if (isMessage(value)) return [value];
    if (Array.isArray(value) && value.every(isMessage)) return value;
    return null;
}

function isMessage(value: unknown): value is Msg {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<Msg>;
    return (
        typeof candidate.name === 'string' &&
        (candidate.role === 'user' ||
            candidate.role === 'assistant' ||
            candidate.role === 'system') &&
        Array.isArray(candidate.content)
    );
}

function formatLocalDate(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export { DEFAULT_MEMORY_INSTRUCTIONS, DEFAULT_RETRIEVAL_INSTRUCTIONS };
