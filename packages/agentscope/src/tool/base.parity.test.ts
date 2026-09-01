/* eslint-disable jsdoc/require-jsdoc */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TextBlock } from '../message';
import {
    PermissionBehavior,
    createPermissionContext,
    createPermissionDecision,
} from '../permission';
import { ToolBase, ToolMiddlewareBase } from './base';
import { ToolChunk } from './response';

class EchoTool extends ToolBase {
    readonly name = 'Echo';
    readonly description = 'Echo input.';
    readonly inputSchema = { type: 'object' as const, properties: {} };
    readonly isConcurrencySafe = true;
    readonly isReadOnly = true;

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        return new ToolChunk({ content: [TextBlock({ text: JSON.stringify(input) })] });
    }

    checkPermissions() {
        return createPermissionDecision({
            behavior: PermissionBehavior.ALLOW,
            message: 'allowed',
        });
    }
}

class RecordingMiddleware extends ToolMiddlewareBase {
    constructor(
        private readonly label: string,
        private readonly order: string[],
        private readonly injected?: Record<string, unknown>
    ) {
        super();
    }

    async *onToolCall({ input, next }: Parameters<ToolMiddlewareBase['onToolCall']>[0]) {
        this.order.push(`${this.label}-pre`);
        yield* next({ ...input, ...this.injected });
        this.order.push(`${this.label}-post`);
    }
}

describe('ToolBase', () => {
    test('returns a direct chunk without middleware', async () => {
        const result = await new EchoTool().invoke({ value: 1 });
        expect(result).toBeInstanceOf(ToolChunk);
        expect((result as ToolChunk).content[0]).toMatchObject({ text: '{"value":1}' });
    });

    test('wraps execution in onion order and lets middleware rewrite input', async () => {
        const order: string[] = [];
        const tool = new EchoTool({
            middlewares: [
                new RecordingMiddleware('outer', order),
                new RecordingMiddleware('inner', order, { injected: true }),
            ],
        });
        const result = await tool.invoke({ original: true });
        const chunks: ToolChunk[] = [];
        for await (const chunk of result as AsyncGenerator<ToolChunk>) chunks.push(chunk);

        expect(chunks[0].content[0]).toMatchObject({
            text: '{"original":true,"injected":true}',
        });
        expect(order).toEqual(['outer-pre', 'inner-pre', 'inner-post', 'outer-post']);
    });

    test('supports middleware short-circuiting', async () => {
        let called = false;
        const middleware = new (class extends ToolMiddlewareBase {
            async *onToolCall() {
                yield new ToolChunk({ content: [TextBlock({ text: 'short' })] });
            }
        })();
        const tool = new (class extends EchoTool {
            async call(input: Record<string, unknown>) {
                called = true;
                return super.call(input);
            }
        })({ middlewares: [middleware] });
        const result = await tool.invoke({});
        const chunks: ToolChunk[] = [];
        for await (const chunk of result as AsyncGenerator<ToolChunk>) chunks.push(chunk);
        expect(called).toBe(false);
        expect(chunks[0].content[0]).toMatchObject({ text: 'short' });
    });

    test('implements default rule, suggestions, and read-only behavior', async () => {
        const tool = new EchoTool();
        await expect(tool.checkReadOnly({})).resolves.toBe(true);
        await expect(tool.matchRule('specific', {})).resolves.toBe(false);
        await expect(tool.generateSuggestions({})).resolves.toEqual([
            {
                tool_name: 'Echo',
                rule_content: null,
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ]);
    });

    test('recognizes dangerous paths case-insensitively', () => {
        const tool = new EchoTool();
        expect(tool.isDangerousPath('/home/user/.BASHRC')).toBe(true);
        expect(tool.isDangerousPath('/home/user/.Git/config')).toBe(true);
        expect(tool.isDangerousPath('/home/user/project/main.ts')).toBe(false);
    });

    test('resolves symlinked working directories before comparison', () => {
        const parent = mkdtempSync(path.join(tmpdir(), 'agentscope-tool-'));
        const real = path.join(parent, 'real');
        const link = path.join(parent, 'link');
        mkdirSync(real);
        symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
        try {
            const context = createPermissionContext();
            context.working_directories[real] = { path: real, source: 'test' };
            expect(
                new EchoTool().pathInAllowedWorkingPath(path.join(link, 'file.txt'), context)
            ).toBe(true);
        } finally {
            rmSync(parent, { recursive: true, force: true });
        }
    });
});
