/* eslint-disable jsdoc/require-jsdoc */

import { TextBlock } from '../message';
import {
    PermissionBehavior,
    createPermissionDecision,
    type PermissionContext,
    type PermissionDecision,
} from '../permission';
import { ToolBase, ToolChunk } from '../tool';
import type { ToolInputSchema } from '../type';
import type { Mem0Middleware } from './mem0';

abstract class Mem0MemoryToolBase extends ToolBase {
    protected readonly middleware: Mem0Middleware;

    constructor(middleware: Mem0Middleware) {
        super();
        this.middleware = middleware;
    }

    async checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'auto-allowed: mem0 long-term memory tool',
        });
    }
}

class SearchMemoryTool extends Mem0MemoryToolBase {
    readonly name = 'search_memory';
    readonly description =
        'Retrieve memories based on short, targeted search keywords. Each keyword is issued ' +
        'as an independent query; results are merged and deduplicated.';
    readonly inputSchema: ToolInputSchema = {
        type: 'object',
        properties: {
            keywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Short, targeted search phrases such as a person name, a specific date, ' +
                    'a location, or a phrase describing what to retrieve from memory.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum number of memories to retrieve per keyword.',
                default: 5,
            },
        },
        required: ['keywords'],
    };
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const keywords = Array.isArray(input.keywords)
            ? input.keywords.filter((value): value is string => typeof value === 'string')
            : [];
        const limit = typeof input.limit === 'number' ? input.limit : 5;
        if (keywords.length === 0) return textChunk('(no keywords supplied — nothing to search)');
        try {
            const results = await Promise.all(
                keywords.map(keyword =>
                    this.middleware.searchMemory(keyword, {
                        userId: this.middleware.userId,
                        agentId: this.middleware.searchAgentId,
                        topK: limit,
                    })
                )
            );
            const merged = [...new Set(results.flat())];
            return merged.length
                ? textChunk(merged.map(memory => '- ' + memory).join('\n'))
                : textChunk('(no relevant memories found)');
        } catch (error) {
            return errorChunk('Error retrieving memory: ' + errorMessage(error));
        }
    }
}

class AddMemoryTool extends Mem0MemoryToolBase {
    readonly name = 'add_memory';
    readonly description =
        'Record important, durable information that may be useful later. Only the provided ' +
        'content is persisted; thinking is retained in the tool result for auditability.';
    readonly inputSchema: ToolInputSchema = {
        type: 'object',
        properties: {
            thinking: {
                type: 'string',
                description:
                    'Reasoning about why this information is worth remembering. This is not ' +
                    'persisted to mem0.',
            },
            content: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Specific facts to remember. Each item should be a complete, standalone sentence.',
            },
        },
        required: ['thinking', 'content'],
    };
    readonly isConcurrencySafe = false;
    readonly isReadOnly = false;

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const thinking = typeof input.thinking === 'string' ? input.thinking : '';
        const content = Array.isArray(input.content)
            ? input.content.filter((value): value is string => typeof value === 'string')
            : [];
        if (content.length === 0) return errorChunk('content is empty — nothing to record.');
        try {
            const result = await this.middleware.addMemoryWithFallback(content.join('\n'), {
                userId: this.middleware.userId,
                agentId: this.middleware.agentId,
            });
            const rationale = thinking ? ' (rationale: ' + thinking + ')' : '';
            return textChunk(
                'Successfully recorded to memory' + rationale + ' → ' + formatResult(result)
            );
        } catch (error) {
            return errorChunk('Error recording memory: ' + errorMessage(error));
        }
    }
}

export function buildMem0MemoryTools(middleware: Mem0Middleware): ToolBase[] {
    return [new SearchMemoryTool(middleware), new AddMemoryTool(middleware)];
}

function textChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })] });
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({
        content: [TextBlock({ text: message })],
        state: 'error',
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatResult(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
