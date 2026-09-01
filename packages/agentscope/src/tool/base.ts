import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { PermissionContext, PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior } from '../permission/runtime';
import type { ToolInputSchema } from '../type';
import type { ToolChunk, ToolResponse } from './response';

export type ToolCallOutput =
    | string
    | ToolChunk
    | ToolResponse
    | Generator<string | ToolChunk | ToolResponse>
    | AsyncGenerator<string | ToolChunk | ToolResponse>;

/** Legacy structural tool contract retained during the ToolBase migration. */
export interface Tool {
    name: string;
    description: string;
    inputSchema: z.ZodObject | ToolInputSchema;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call?: (input: any) => ToolCallOutput | Promise<ToolCallOutput>;
    requireUserConfirm?: boolean;
}

export type ToolChunkStream = AsyncGenerator<ToolChunk, void, void>;
export type ToolNextHandler = (input: Record<string, unknown>) => ToolChunkStream;

export interface ToolMiddlewareCall {
    tool: ToolBase;
    input: Record<string, unknown>;
    next: ToolNextHandler;
}

/** Base class for onion-style tool middleware. */
export abstract class ToolMiddlewareBase {
    /**
     * Intercept one invocation and optionally rewrite, transform, or short-circuit it.
     * @param call Middleware call context.
     * @returns An async stream of chunks.
     */
    abstract onToolCall(call: ToolMiddlewareCall): ToolChunkStream;
}

export interface ToolBaseOptions {
    middlewares?: ToolMiddlewareBase[];
    dangerousFiles?: string[];
    dangerousDirectories?: string[];
}

const DANGEROUS_FILES = [
    '.gitconfig',
    '.gitmodules',
    '.bashrc',
    '.bash_profile',
    '.zshrc',
    '.zprofile',
    '.profile',
    '.ssh/config',
    '.ssh/authorized_keys',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.env',
    '.envrc',
    '.env.local',
    '.env.development',
    '.env.development.local',
    '.env.test',
    '.env.test.local',
    '.env.staging',
    '.env.production',
    '.env.production.local',
];

const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.ssh'];

/** Extensible tool protocol aligned with Python ToolBase. */
export abstract class ToolBase {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly inputSchema: z.ZodObject | ToolInputSchema;
    abstract readonly isConcurrencySafe: boolean;
    abstract readonly isReadOnly: boolean;

    isExternalTool: boolean = false;
    isStateInjected: boolean = false;
    isMcp: boolean = false;
    mcpName: string | null = null;
    readonly dangerousFiles: string[];
    readonly dangerousDirectories: string[];
    private readonly middlewares: ToolMiddlewareBase[];

    /**
     * Initialize a tool with optional middleware.
     * @param options Tool configuration.
     */
    constructor(options: ToolBaseOptions = {}) {
        this.middlewares = options.middlewares ?? [];
        this.dangerousFiles = [...(options.dangerousFiles ?? DANGEROUS_FILES)];
        this.dangerousDirectories = [...(options.dangerousDirectories ?? DANGEROUS_DIRECTORIES)];
    }

    /**
     * Execute tool logic. Subclasses override this method.
     * @param _input Validated tool input.
     * @returns A chunk or stream of chunks.
     */
    async call(_input: Record<string, unknown>): Promise<ToolChunk | ToolChunkStream> {
        if (!this.isExternalTool) {
            throw new Error(`${this.constructor.name} does not implement call`);
        }
        throw new Error(
            `${this.constructor.name} is an external tool and should not be called directly`
        );
    }

    /**
     * Invoke this tool through its middleware onion.
     * @param input Validated tool input.
     * @returns A direct chunk without middleware, otherwise a normalized stream.
     */
    async invoke(input: Record<string, unknown>): Promise<ToolChunk | ToolChunkStream> {
        if (this.middlewares.length === 0) return this.call(input);
        return this.executeMiddleware(0, input);
    }

    /** Check tool-specific permissions. */
    abstract checkPermissions(
        toolInput: Record<string, unknown>,
        context: PermissionContext
    ): PermissionDecision | Promise<PermissionDecision>;

    /**
     * Determine whether one invocation is read-only.
     * @param _toolInput Tool input.
     * @returns The static read-only declaration by default.
     */
    async checkReadOnly(_toolInput: Record<string, unknown>): Promise<boolean> {
        return this.isReadOnly;
    }

    /**
     * Match a specific permission rule. Tool-level null rules are handled by the engine.
     * @param _ruleContent Rule content.
     * @param _toolInput Tool input.
     * @returns False unless a concrete tool provides matching semantics.
     */
    async matchRule(_ruleContent: string, _toolInput: Record<string, unknown>): Promise<boolean> {
        return false;
    }

    /**
     * Suggest a tool-level allow rule.
     * @param _toolInput Tool input.
     * @returns One Python-compatible suggested rule.
     */
    async generateSuggestions(_toolInput: Record<string, unknown>): Promise<PermissionRule[]> {
        return [
            {
                tool_name: this.name,
                rule_content: null,
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ];
    }

    /**
     * Check whether a path resolves inside cwd or an additional working directory.
     * @param filePath Candidate path.
     * @param context Permission context.
     * @returns Whether the resolved path is allowed.
     */
    pathInAllowedWorkingPath(filePath: string, context: PermissionContext): boolean {
        const candidate = resolveRealPath(filePath);
        return [process.cwd(), ...Object.keys(context.working_directories)].some(directory => {
            const workingDirectory = resolveRealPath(directory);
            const relative = path.relative(workingDirectory, candidate);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });
    }

    /**
     * Check whether a path targets a sensitive file or directory.
     * @param filePath Candidate path.
     * @returns Whether explicit permission is required.
     */
    isDangerousPath(filePath: string): boolean {
        const normalized = path.resolve(expandHome(filePath));
        const parts = normalized.split(path.sep).map(part => part.toLowerCase());
        const filename = path.basename(normalized).toLowerCase();
        return (
            this.dangerousFiles.some(item => item.toLowerCase() === filename) ||
            this.dangerousDirectories.some(item => parts.includes(item.toLowerCase()))
        );
    }

    /**
     * Normalize the remaining middleware and tool call into one stream.
     * @param index
     * @param input
     */
    private async *executeMiddleware(
        index: number,
        input: Record<string, unknown>
    ): ToolChunkStream {
        if (index >= this.middlewares.length) {
            const result = await this.call(input);
            if (isAsyncIterable(result)) yield* result;
            else yield result;
            return;
        }
        const middleware = this.middlewares[index];
        yield* middleware.onToolCall({
            tool: this,
            input: { ...input },
            next: nextInput => this.executeMiddleware(index + 1, nextInput),
        });
    }
}

/**
 * Return whether a value can be consumed with `for await`.
 * @param value
 * @returns Whether the value is an async chunk stream.
 */
function isAsyncIterable(value: unknown): value is ToolChunkStream {
    return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Expand a leading home marker without relying on shell behavior.
 * @param value
 * @returns The path with a leading home marker expanded.
 */
function expandHome(value: string): string {
    if (value === '~') return homedir();
    if (value.startsWith(`~${path.sep}`)) return path.join(homedir(), value.slice(2));
    return value;
}

/**
 * Resolve symlinks in the longest existing prefix of a possibly new path.
 * @param value
 * @returns A normalized real path.
 */
function resolveRealPath(value: string): string {
    const absolute = path.resolve(expandHome(value));
    const missing: string[] = [];
    let current = absolute;
    while (!existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return absolute;
        missing.unshift(path.basename(current));
        current = parent;
    }
    return path.join(realpathSync(current), ...missing);
}
