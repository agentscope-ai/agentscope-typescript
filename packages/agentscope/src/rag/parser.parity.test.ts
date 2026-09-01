import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    ImageParser,
    PDFParser,
    TextParser,
    guessImageMediaType,
    tableToJSON,
    tableToMarkdown,
} from './parser';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64'
);

describe('RAG parser Python parity', () => {
    test('text parser accepts bytes, decoded text, and paths', async () => {
        const parser = new TextParser();
        expect((await parser.parse(Buffer.from('hello'), 'x.txt'))[0]).toEqual(
            expect.objectContaining({
                content: expect.objectContaining({ type: 'text', text: 'hello' }),
                source: 'x.txt',
                metadata: {},
            })
        );
        expect((await parser.parse('preset', 'x.md'))[0].content).toEqual(
            expect.objectContaining({ text: 'preset' })
        );
        const directory = await mkdtemp(join(tmpdir(), 'agentscope-rag-'));
        const path = join(directory, 'input.txt');
        try {
            await writeFile(path, 'from disk');
            expect((await parser.parse(path, 'x.txt'))[0].content).toEqual(
                expect.objectContaining({ text: 'from disk' })
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
        await expect(new TextParser('ascii').parse(Buffer.from([0xff]), 'bad.txt')).rejects.toThrow(
            'Failed to decode'
        );
    });

    test('image parser sniffs and wraps bytes', async () => {
        const section = (await new ImageParser().parse(PNG, 'pixel.png'))[0];
        expect(section).toEqual(
            expect.objectContaining({
                content: expect.objectContaining({
                    type: 'data',
                    name: 'pixel.png',
                    source: {
                        type: 'base64',
                        data: PNG.toString('base64'),
                        media_type: 'image/png',
                    },
                }),
                source: 'pixel.png',
                metadata: { media_type: 'image/png' },
            })
        );
        expect(guessImageMediaType(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
        expect(guessImageMediaType(Buffer.from('GIF89a'))).toBe('image/gif');
        expect(guessImageMediaType(Buffer.from('BM'))).toBe('image/bmp');
        expect(guessImageMediaType(Buffer.from('RIFFxxxxWEBPx'))).toBe('image/webp');
    });

    test('table renderers escape cells and preserve JSON', () => {
        const table = [
            ['A|B', String.raw`Path \| label`],
            ['1|2', 'Line 1\r\nLine 2'],
        ];
        expect(tableToMarkdown(table)).toBe(
            '| A\\|B | Path \\\\\\| label |\n| --- | --- |\n| 1\\|2 | Line 1<br>Line 2 |\n'
        );
        expect(
            tableToJSON([
                ['A', 'B'],
                ['1', '2'],
            ])
        ).toBe('<system-info>A table loaded as a JSON array:</system-info>\n[["A","B"],["1","2"]]');
    });

    test('PDF parser rejects invalid bytes and exposes canonical types', async () => {
        await expect(new PDFParser().parse(Buffer.from('not a pdf'), 'broken.pdf')).rejects.toThrow(
            'Failed to parse'
        );
        expect(PDFParser.supportedExtensions).toEqual(['.pdf']);
        expect(TextParser.supportedExtensions).toEqual([
            '.csv',
            '.htm',
            '.html',
            '.json',
            '.markdown',
            '.md',
            '.rst',
            '.txt',
            '.xml',
            '.yaml',
            '.yml',
        ]);
    });
});
