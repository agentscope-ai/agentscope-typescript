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
import type { ReMeMiddleware } from './reme';

class ReMeMemorySearchTool extends ToolBase {
    readonly name = 'memory_search';
    readonly description = 'Retrieve memories from past conversations relevant to a query.';
    readonly inputSchema: ToolInputSchema;
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;
    private readonly middleware: ReMeMiddleware;

    constructor(middleware: ReMeMiddleware) {
        super();
        this.middleware = middleware;
        this.inputSchema = {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        "What to retrieve from memory — for example a person's name, " +
                        'a preference, or a past decision.',
                },
                limit: {
                    type: 'integer',
                    description: 'Maximum number of memories to retrieve.',
                    default: middleware.parameters.topK,
                },
            },
            required: ['query'],
        };
    }

    async checkPermissions(
        _toolInput: Record<string, unknown>,
        _context: PermissionContext
    ): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'auto-allowed: ReMe long-term memory tool',
        });
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const query = typeof input.query === 'string' ? input.query : '';
        const limit = typeof input.limit === 'number' ? input.limit : undefined;
        if (!query) return textChunk('(no query supplied — nothing to search)');
        try {
            const memories = await this.middleware.searchMemory(query, limit);
            return memories.length
                ? textChunk(memories.map(memory => '- ' + memory).join('\n'))
                : textChunk('(no relevant memories found)');
        } catch (error) {
            return errorChunk('Error retrieving memory: ' + errorMessage(error));
        }
    }
}

export function buildReMeMemoryTools(middleware: ReMeMiddleware): ToolBase[] {
    return [new ReMeMemorySearchTool(middleware)];
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
