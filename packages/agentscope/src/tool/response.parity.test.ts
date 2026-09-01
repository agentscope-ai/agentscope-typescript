import { setIdFactory, setTimestampFactory } from '../_utils/common';
import { Base64Source, DataBlock, TextBlock, URLSource } from '../message';
import { ToolChunk, ToolResponse } from './response';

describe('ToolChunk and ToolResponse', () => {
    beforeEach(() => {
        let id = 0;
        setIdFactory(() => `id-${++id}`);
        setTimestampFactory(() => '2026-09-01T12:00:00.000000');
    });

    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('fills Python ToolChunk defaults and emits snake-case JSON', () => {
        const chunk = new ToolChunk({ content: [TextBlock({ text: 'hello' })] });
        expect(chunk.toJSON()).toEqual({
            content: [
                {
                    type: 'text',
                    text: 'hello',
                    id: 'id-1',
                    created_at: '2026-09-01T12:00:00.000000',
                    finished_at: null,
                },
            ],
            state: 'running',
            is_last: true,
            metadata: {},
            id: 'id-2',
        });
    });

    test('merges text chunks and metadata into a complete response', () => {
        const response = new ToolResponse({ id: 'response' });
        response.appendChunk(
            new ToolChunk({
                content: [TextBlock({ id: 'text', text: 'one' })],
                metadata: { first: 1 },
            })
        );
        response.appendChunk(
            new ToolChunk({
                content: [TextBlock({ id: 'text', text: 'two' })],
                state: 'interrupted',
                metadata: { second: 2 },
            })
        );

        expect(response.toJSON()).toEqual({
            content: [expect.objectContaining({ type: 'text', id: 'text', text: 'onetwo' })],
            state: 'interrupted',
            metadata: { first: 1, second: 2 },
            id: 'response',
        });
    });

    test('merges independently padded base64 chunks by decoded bytes', () => {
        const response = new ToolResponse();
        response.appendChunk(
            new ToolChunk({
                content: [
                    DataBlock({
                        id: 'image',
                        source: Base64Source({
                            data: Buffer.from('hello').toString('base64'),
                            media_type: 'image/png',
                        }),
                    }),
                ],
            })
        );
        response.appendChunk(
            new ToolChunk({
                content: [
                    DataBlock({
                        id: 'image',
                        name: 'latest',
                        source: Base64Source({
                            data: Buffer.from('world').toString('base64'),
                            media_type: 'image/jpeg',
                        }),
                    }),
                ],
            })
        );

        const block = response.content[0] as DataBlock;
        expect(Buffer.from((block.source as Base64Source).data, 'base64').toString()).toBe(
            'helloworld'
        );
        expect(block.name).toBe('latest');
        expect(block.source.media_type).toBe('image/jpeg');
    });

    test('rejects URL data accumulation and protects error state priority', () => {
        const response = new ToolResponse();
        response.appendChunk(new ToolChunk({ content: [], state: 'error' }));
        response.appendChunk(new ToolChunk({ content: [], state: 'denied' }));
        expect(response.state).toBe('error');

        response.appendChunk(
            new ToolChunk({
                content: [
                    DataBlock({
                        id: 'url',
                        source: URLSource({
                            url: 'https://example.com/a',
                            media_type: 'text/plain',
                        }),
                    }),
                ],
            })
        );
        expect(() =>
            response.appendChunk(
                new ToolChunk({
                    content: [
                        DataBlock({
                            id: 'url',
                            source: URLSource({
                                url: 'https://example.com/b',
                                media_type: 'text/plain',
                            }),
                        }),
                    ],
                })
            )
        ).toThrow('Cannot append DataBlock with URL source or different source types');
    });

    test('renames colliding blocks of different types and merges adjacent text', () => {
        const response = new ToolResponse();
        response.appendChunk(
            new ToolChunk({
                content: [
                    TextBlock({ id: 'shared', text: 'a' }),
                    TextBlock({ id: 'other', text: 'b' }),
                ],
            })
        );
        response.appendChunk(
            new ToolChunk({
                content: [
                    DataBlock({
                        id: 'shared',
                        source: Base64Source({ data: 'Yw==', media_type: 'text/plain' }),
                    }),
                ],
            })
        );
        expect(response.content).toHaveLength(2);
        expect(response.content[0]).toMatchObject({ type: 'text', text: 'ab' });
        expect(response.content[1].id).not.toBe('shared');
    });
});
