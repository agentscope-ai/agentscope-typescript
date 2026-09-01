import { z } from 'zod';

import { RegisteredTool, ToolChoice } from './types';
import { removeSchemaTitles } from './utils';

const tool = {
    name: 'search',
    description: 'Search records.',
    inputSchema: {
        type: 'object' as const,
        title: 'SearchParams',
        properties: {
            query: { type: 'string', title: 'Query' },
        },
        required: ['query'],
    },
};

describe('tool registration contracts', () => {
    test('models Python ToolChoice defaults', () => {
        expect(new ToolChoice({ mode: 'auto' })).toEqual({ mode: 'auto', tools: null });
        expect(new ToolChoice({ mode: 'search', tools: ['search'] })).toEqual({
            mode: 'search',
            tools: ['search'],
        });
    });

    test('recursively strips generated titles', () => {
        expect(
            removeSchemaTitles({
                title: 'Root',
                type: 'object',
                properties: { value: { title: 'Value', type: 'string' } },
                items: { title: 'Item', type: 'string' },
                additionalProperties: { title: 'Extra', type: 'number' },
                $defs: { Child: { title: 'Child', type: 'object' } },
            })
        ).toEqual({
            type: 'object',
            properties: { value: { type: 'string' } },
            items: { type: 'string' },
            additionalProperties: { type: 'number' },
            $defs: { Child: { type: 'object' } },
        });
    });

    test('builds detached schemas and merges extensions', () => {
        const registered = new RegisteredTool({ tool });
        const schema = registered.getToolSchema({
            extendedSchema: {
                type: 'object',
                properties: { limit: { type: 'integer' } },
                required: ['limit'],
                $defs: { Page: { type: 'object' } },
            },
        });
        expect(schema).toEqual({
            type: 'function',
            function: {
                name: 'search',
                description: 'Search records.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        limit: { type: 'integer' },
                    },
                    required: ['query', 'limit'],
                    $defs: { Page: { type: 'object' } },
                },
            },
        });
        expect(tool.inputSchema).toHaveProperty('title', 'SearchParams');
    });

    test('supports Zod schemas and rejects invalid or conflicting schemas', () => {
        expect(
            new RegisteredTool({
                tool: { ...tool, inputSchema: z.object({ query: z.string() }) },
            }).getToolSchema().function.parameters
        ).toMatchObject({ type: 'object', required: ['query'] });
        expect(
            () =>
                new RegisteredTool({
                    tool: {
                        ...tool,
                        inputSchema: { type: 'string' } as never,
                    },
                })
        ).toThrow('Invalid inputSchema');
        expect(() =>
            new RegisteredTool({ tool }).getToolSchema({
                extendedSchema: {
                    type: 'object',
                    properties: { query: { type: 'number' } },
                },
            })
        ).toThrow('already exists');
    });
});
