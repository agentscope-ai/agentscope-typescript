import { ApproxTokenChunker, Section } from './index';

import { Base64Source, DataBlock, TextBlock } from '../message';

describe('ApproxTokenChunker Python parity', () => {
    test('keeps a short section as one complete chunk', async () => {
        const chunks = await new ApproxTokenChunker({ chunk_size: 512, overlap: 50 }).chunk([
            Section({
                content: TextBlock({ text: 'Hello world!' }),
                source: 'a.txt',
                metadata: { page: 1 },
            }),
        ]);
        expect(chunks).toEqual([
            expect.objectContaining({
                content: expect.objectContaining({ type: 'text', text: 'Hello world!' }),
                source: 'a.txt',
                chunk_index: 0,
                total_chunks: 1,
                metadata: { page: 1 },
            }),
        ]);
    });

    test('uses UTF-8 byte windows with overlap', async () => {
        const text = 'abcdefghij'.repeat(20);
        const chunks = await new ApproxTokenChunker({ chunk_size: 10, overlap: 2 }).chunk([
            Section({ content: TextBlock({ text }), source: 'b.txt' }),
        ]);
        expect(
            chunks.map(chunk => ({
                text: chunk.content.type === 'text' ? chunk.content.text : '',
                source: chunk.source,
                chunk_index: chunk.chunk_index,
                total_chunks: chunk.total_chunks,
                metadata: chunk.metadata,
            }))
        ).toEqual(
            [0, 32, 64, 96, 128, 160].map((start, chunk_index) => ({
                text: text.slice(start, start + 40),
                source: 'b.txt',
                chunk_index,
                total_chunks: 6,
                metadata: {},
            }))
        );
    });

    test('passes data blocks through and never merges sections', async () => {
        const data = DataBlock({
            source: Base64Source({ data: 'aGk=', media_type: 'image/png' }),
        });
        const chunks = await new ApproxTokenChunker({ chunk_size: 10, overlap: 2 }).chunk([
            Section({ content: TextBlock({ text: 'x'.repeat(100) }), source: 'c.pdf' }),
            Section({ content: data, source: 'c.pdf', metadata: { page: 2 } }),
        ]);
        expect(chunks.map(chunk => chunk.total_chunks)).toEqual([4, 4, 4, 4]);
        expect(chunks.map(chunk => chunk.chunk_index)).toEqual([0, 1, 2, 3]);
        expect(chunks.at(-1)).toEqual({
            content: data,
            source: 'c.pdf',
            chunk_index: 3,
            total_chunks: 4,
            metadata: { page: 2 },
        });
        expect(chunks.at(-1)!.content).toBe(data);
    });

    test('validates parameters and handles multibyte characters', () => {
        expect(() => new ApproxTokenChunker({ chunk_size: 0 })).toThrow();
        expect(() => new ApproxTokenChunker({ chunk_size: 4, overlap: 4 })).toThrow(
            'overlap must be less than chunk_size'
        );
        expect(new ApproxTokenChunker({ chunk_size: 1, overlap: 0 }).splitText('你a你a')).toEqual([
            '你a',
            '你a',
        ]);
    });
});
