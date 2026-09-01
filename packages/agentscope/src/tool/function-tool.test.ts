/* eslint-disable jsdoc/require-jsdoc */
import { z } from 'zod';

import { TextBlock } from '../message';
import {
    PermissionBehavior,
    createPermissionContext,
    createPermissionDecision,
} from '../permission';
import { FunctionTool } from './function-tool';
import { ToolChunk } from './response';

async function collect(result: ToolChunk | AsyncGenerator<ToolChunk>): Promise<ToolChunk[]> {
    if (result instanceof ToolChunk) return [result];
    const chunks: ToolChunk[] = [];
    for await (const chunk of result) chunks.push(chunk);
    return chunks;
}

describe('FunctionTool', () => {
    test('uses TypeScript metadata and normalizes JSON results', async () => {
        const tool = new FunctionTool({
            func: ({ a, b }: { a: number; b: number }) => ({ result: a + b }),
            name: 'add',
            description: 'Add numbers.',
            inputSchema: z.object({ a: z.number(), b: z.number() }),
            isReadOnly: true,
        });
        expect(tool).toMatchObject({
            name: 'add',
            description: 'Add numbers.',
            isConcurrencySafe: true,
            isReadOnly: true,
            isStateInjected: false,
        });
        const [chunk] = await collect(await tool.invoke({ a: 2, b: 3 }));
        expect(chunk.content[0]).toMatchObject({ text: '{"result":5}' });
    });

    test('preserves chunks and converts sync and async streams lazily', async () => {
        const direct = new ToolChunk({ content: [TextBlock({ text: 'direct' })] });
        const preserve = new FunctionTool({ func: () => direct });
        expect(await preserve.invoke({})).toBe(direct);

        const sync = new FunctionTool({
            func: function* () {
                yield 'one';
                yield { two: 2 };
            },
        });
        expect(
            (await collect(await sync.invoke({}))).map(
                chunk => (chunk.content[0] as { text: string }).text
            )
        ).toEqual(['one', '{"two":2}']);

        const asyncTool = new FunctionTool({
            func: async function* () {
                yield 'three';
                yield direct;
            },
        });
        const chunks = await collect(await asyncTool.invoke({}));
        expect(chunks[0].content[0]).toMatchObject({ text: 'three' });
        expect(chunks[1]).toBe(direct);
    });

    test('maps undefined to Python None JSON and asks by default', async () => {
        const tool = new FunctionTool({ func: () => undefined });
        const result = (await tool.invoke({})) as ToolChunk;
        expect(result.content[0]).toMatchObject({ text: 'null' });
        expect(await tool.checkPermissions({}, createPermissionContext())).toMatchObject({
            behavior: PermissionBehavior.ASK,
            message: 'Custom function tools must be explicitly allowed by the user.',
        });
    });

    test('honors an explicit permission decision', async () => {
        const permission = createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'setMode is always allowed.',
        });
        const tool = new FunctionTool({ func: () => 'ok', permission });

        expect(await tool.checkPermissions({}, createPermissionContext())).toEqual(permission);
    });
});
