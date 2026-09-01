/* eslint-disable jsdoc/require-jsdoc */

import { Agent } from './agent';
import { QueueModel } from './test-helpers';
import { Base64Source, DataBlock, TextBlock, ToolResultBlock, getContentBlocks } from '../message';
import type { DataBlock as DataBlockType, TextBlock as TextBlockType } from '../message';

type OutputBlock = TextBlockType | DataBlockType;
interface CompressionAgent {
    splitToolResult(result: ToolResultBlock): Promise<[ToolResultBlock, ToolResultBlock | null]>;
}

function agentWithCounter(counter: (blocks: OutputBlock[]) => number): CompressionAgent {
    const model = new QueueModel();
    model.countTokens = jest.fn(async ({ messages }) =>
        counter(getContentBlocks(messages[0]) as OutputBlock[])
    );
    return new Agent({
        name: 'test',
        systemPrompt: 'test',
        model,
        contextConfig: { toolResultLimit: 100 },
    }) as unknown as CompressionAgent;
}

function result(output: OutputBlock[]): ToolResultBlock {
    return ToolResultBlock({ id: 'call', name: 'tool', output, state: 'success' });
}

function text(id: string, value: string): TextBlockType {
    return TextBlock({ id, text: value });
}

function data(id: string): DataBlockType {
    return DataBlock({
        id,
        source: Base64Source({ data: 'base64data', media_type: 'image/png' }),
    });
}

function plain(block: OutputBlock): Record<string, unknown> {
    if (block.type === 'text') return { type: 'text', id: block.id, text: block.text };
    return { type: 'data', id: block.id, name: block.name, source: block.source };
}

function outputOf(block: ToolResultBlock | null): Record<string, unknown>[] {
    expect(block).not.toBeNull();
    return (block!.output as OutputBlock[]).map(plain);
}

describe('tool-result compression Python parity', () => {
    test.each([50, 100])('preserves the original result at %i tokens', async tokens => {
        const agent = agentWithCounter(() => tokens);
        const original = result([text('one', 'short'), text('two', 'text')]);

        const [reserved, offloaded] = await agent.splitToolResult(original);

        expect(reserved).toBe(original);
        expect(offloaded).toBeNull();
    });

    test('splits and merges a text boundary in the last block', async () => {
        const agent = agentWithCounter(blocks =>
            blocks.reduce(
                (total, block) => total + (block.type === 'text' ? block.text.length : 0),
                0
            )
        );
        const original = result([
            text('block1', 'A'.repeat(20)),
            text('block2', 'B'.repeat(20)),
            text('block3', 'C'.repeat(100)),
        ]);

        const [reserved, offloaded] = await agent.splitToolResult(original);

        expect(reserved).toMatchObject({ id: 'call', name: 'tool', state: 'success' });
        expect(offloaded).toMatchObject({ id: 'call', name: 'tool', state: 'success' });
        expect(outputOf(reserved)).toEqual([
            { type: 'text', id: 'block1', text: 'A'.repeat(20) },
            { type: 'text', id: 'block2', text: 'B'.repeat(20) + 'C'.repeat(60) },
        ]);
        expect(outputOf(offloaded)).toEqual([{ type: 'text', id: 'block3', text: 'C'.repeat(40) }]);
    });

    test('moves an inseparable data boundary in the last block', async () => {
        const agent = agentWithCounter(blocks => (blocks.length === 3 ? 150 : 80));
        const original = result([
            text('block1', 'A'.repeat(20)),
            text('block2', 'B'.repeat(20)),
            data('block3'),
        ]);

        const [reserved, offloaded] = await agent.splitToolResult(original);

        expect(outputOf(reserved)).toEqual([
            { type: 'text', id: 'block1', text: 'A'.repeat(20) },
            { type: 'text', id: 'block2', text: 'B'.repeat(20) },
        ]);
        expect(outputOf(offloaded)).toEqual([
            {
                type: 'data',
                id: 'block3',
                name: null,
                source: { type: 'base64', data: 'base64data', media_type: 'image/png' },
            },
        ]);
    });

    test('keeps an exactly-full first text block and offloads the rest', async () => {
        const agent = agentWithCounter(blocks =>
            blocks.reduce(
                (total, block) => total + (block.type === 'text' ? block.text.length : 0),
                0
            )
        );
        const original = result([
            text('block1', 'A'.repeat(100)),
            text('block2', 'B'.repeat(20)),
            text('block3', 'C'.repeat(20)),
        ]);

        const [reserved, offloaded] = await agent.splitToolResult(original);

        expect(outputOf(reserved)).toEqual([{ type: 'text', id: 'block1', text: 'A'.repeat(100) }]);
        expect(outputOf(offloaded)).toEqual([
            { type: 'text', id: 'block2', text: 'B'.repeat(20) },
            { type: 'text', id: 'block3', text: 'C'.repeat(20) },
        ]);
    });

    test.each([
        ['first', [data('block1'), text('block2', 'B'.repeat(20)), text('block3', 'C'.repeat(20))]],
        [
            'middle',
            [text('block1', 'A'.repeat(20)), data('block2'), text('block3', 'C'.repeat(20))],
        ],
    ] as const)(
        'preserves a %s data block while splitting the final text',
        async (_name, blocks) => {
            const agent = agentWithCounter(candidate => {
                if (candidate.length === 3) return 150;
                if (candidate.length === 2) return 80;
                if (candidate.length === 1) return 60;
                return 50;
            });

            const [reserved, offloaded] = await agent.splitToolResult(result([...blocks]));

            expect(outputOf(reserved)).toEqual([
                plain(blocks[0]),
                ...(blocks[1].type === 'text'
                    ? [{ type: 'text', id: 'block2', text: 'B'.repeat(20) + 'C'.repeat(5) }]
                    : [plain(blocks[1]), { type: 'text', id: 'block3', text: 'C'.repeat(5) }]),
            ]);
            expect(outputOf(offloaded)).toEqual([
                { type: 'text', id: 'block3', text: 'C'.repeat(15) },
            ]);
        }
    );

    test('splits and merges a text boundary in the middle block', async () => {
        const agent = agentWithCounter(blocks =>
            blocks.reduce(
                (total, block) => total + (block.type === 'text' ? block.text.length : 0),
                0
            )
        );
        const original = result([
            text('block1', 'A'.repeat(20)),
            text('block2', 'B'.repeat(100)),
            text('block3', 'C'.repeat(20)),
        ]);

        const [reserved, offloaded] = await agent.splitToolResult(original);

        expect(outputOf(reserved)).toEqual([
            { type: 'text', id: 'block1', text: 'A'.repeat(20) + 'B'.repeat(80) },
        ]);
        expect(outputOf(offloaded)).toEqual([
            { type: 'text', id: 'block3', text: 'B'.repeat(20) + 'C'.repeat(20) },
        ]);
    });
});
