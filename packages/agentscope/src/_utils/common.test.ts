import { ToolJSONDecodeError } from '../exception';
import {
    _describeException,
    _estimateBytes,
    _estimateTokens,
    _executeAsyncOrSyncFunction,
    _flattenJsonSchema,
    _getBytesFromWebUrl,
    _getTimestamp,
    _generateId,
    _generateTimestamp,
    _isAsyncFunction,
    _jsonLoadsWithRepair,
    _mapTextToUuid,
    setIdFactory,
    setTimestampFactory,
} from './common';

describe('Python-compatible common utilities', () => {
    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('uses configurable entity ID and timestamp factories', () => {
        setIdFactory(() => 'custom-entity-id');
        setTimestampFactory(() => '2026-09-01T12:34:56.123456');

        expect(_generateId()).toBe('custom-entity-id');
        expect(_generateTimestamp()).toBe('2026-09-01T12:34:56.123456');
    });

    test('rejects non-callable factories at runtime', () => {
        expect(() => setIdFactory('bad' as unknown as () => string)).toThrow(
            'factory must be a callable, got string'
        );
        expect(() => setTimestampFactory(null as unknown as () => string)).toThrow(
            'factory must be a callable, got null'
        );
    });

    test('repairs incomplete tool JSON and rejects non-objects', () => {
        expect(_jsonLoadsWithRepair('{"city": "Hangzhou"')).toEqual({ city: 'Hangzhou' });
        expect(() => _jsonLoadsWithRepair('[]')).toThrow(ToolJSONDecodeError);
        expect(() => _jsonLoadsWithRepair('[]')).toThrow(
            'Your argument string is decoded by the following code snippet'
        );
    });

    test('flattens definitions, merges sibling keys, and handles cycles', () => {
        expect(
            _flattenJsonSchema({
                $defs: {
                    Name: { type: 'string' },
                    Node: {
                        type: 'object',
                        properties: { child: { $ref: '#/$defs/Node' } },
                    },
                },
                properties: {
                    name: { $ref: '#/$defs/Name', description: 'The name' },
                    root: { $ref: '#/$defs/Node' },
                },
            })
        ).toEqual({
            properties: {
                name: { type: 'string', description: 'The name' },
                root: {
                    type: 'object',
                    properties: {
                        child: {
                            type: 'object',
                            description: '(circular: Node)',
                        },
                    },
                },
            },
        });
    });

    test('returns the same schema reference when no definitions exist', () => {
        const schema = { type: 'object', properties: { value: { type: 'integer' } } };
        expect(_flattenJsonSchema(schema)).toBe(schema);
    });

    test('matches Python golden values for UUID and byte estimates', () => {
        expect(_mapTextToUuid('AgentScope')).toBe('48056fa7-de9a-3fc7-b6cd-163cfd5037dd');
        expect(_estimateTokens('你好AgentScope')).toBe(4);
        expect(_estimateBytes(3)).toBe(12);
    });

    test('describes aggregate leaves and empty errors', () => {
        const error = new AggregateError([new Error('first'), new Error(''), 'plain']);
        expect(_describeException(error)).toBe('first; Error; plain');
    });

    test('detects and executes synchronous and asynchronous callables', async () => {
        const syncFunction = (value: number): number => value + 1;
        const asyncFunction = async (value: number): Promise<number> => value + 2;
        const asyncGenerator = async function* (): AsyncGenerator<number> {
            yield 1;
        };

        expect(_isAsyncFunction(syncFunction)).toBe(false);
        expect(_isAsyncFunction(asyncFunction)).toBe(true);
        expect(_isAsyncFunction(asyncGenerator)).toBe(true);
        expect(_isAsyncFunction(Promise.resolve('done'))).toBe(true);
        await expect(_executeAsyncOrSyncFunction(syncFunction, 1)).resolves.toBe(2);
        await expect(_executeAsyncOrSyncFunction(asyncFunction, 1)).resolves.toBe(3);
    });

    test('creates Python-style display timestamps with optional suffixes', () => {
        expect(_getTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
        expect(_getTimestamp(true)).toMatch(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}_[0-9a-f]{6}$/
        );
    });

    test('fetches UTF-8 text and base64-encodes non-UTF-8 bytes', async () => {
        const originalFetch = globalThis.fetch;
        const responses = [
            new Response(new TextEncoder().encode('hello')),
            new Response(new Uint8Array([0xff, 0xfe])),
        ];
        globalThis.fetch = jest.fn(async () => responses.shift() as Response);

        try {
            await expect(_getBytesFromWebUrl('https://example.com/text')).resolves.toBe('hello');
            await expect(_getBytesFromWebUrl('https://example.com/binary')).resolves.toBe('//4=');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('retries failed byte requests and reports the final URL', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = jest.fn(async () => {
            throw new Error('offline');
        });

        try {
            await expect(_getBytesFromWebUrl('https://example.com/data', 2)).rejects.toThrow(
                'Failed to fetch bytes from URL `https://example.com/data` after 2 retries.'
            );
            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
