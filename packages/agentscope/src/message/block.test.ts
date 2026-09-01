import {
    Base64Source,
    DataBlock,
    HintBlock,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
    URLSource,
} from './block';
import { parseContentBlock } from './schema';
import { setIdFactory, setTimestampFactory } from '../_utils/common';

const TIMESTAMP = '2026-09-01T12:34:56.123456';

describe('Python-compatible content block factories', () => {
    beforeEach(() => {
        setIdFactory(() => 'generated-id');
        setTimestampFactory(() => TIMESTAMP);
    });

    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('fills every Python model default', () => {
        expect(TextBlock({ text: 'hello' })).toEqual({
            type: 'text',
            text: 'hello',
            id: 'generated-id',
            created_at: TIMESTAMP,
            finished_at: null,
        });
        expect(ThinkingBlock({ thinking: 'reason', signature: 'provider-value' })).toEqual({
            type: 'thinking',
            thinking: 'reason',
            signature: 'provider-value',
            id: 'generated-id',
            created_at: TIMESTAMP,
            finished_at: null,
        });
        expect(
            DataBlock({
                source: Base64Source({ data: 'aGVsbG8=', media_type: 'text/plain' }),
            })
        ).toEqual({
            type: 'data',
            id: 'generated-id',
            source: { type: 'base64', data: 'aGVsbG8=', media_type: 'text/plain' },
            name: null,
            created_at: TIMESTAMP,
            finished_at: null,
        });
        expect(HintBlock({ hint: 'hint' })).toEqual({
            type: 'hint',
            hint: 'hint',
            id: 'generated-id',
            source: null,
            created_at: TIMESTAMP,
            finished_at: TIMESTAMP,
        });
        expect(HintBlock({ hint: 'unfinished', finished_at: null }).finished_at).toBeNull();
        expect(ToolCallBlock({ id: 'call', name: 'read', input: '{}' })).toEqual({
            type: 'tool_call',
            id: 'call',
            name: 'read',
            input: '{}',
            state: 'pending',
            suggested_rules: [],
            created_at: TIMESTAMP,
            finished_at: null,
        });
        expect(ToolResultBlock({ id: 'call', name: 'read', output: 'ok' })).toEqual({
            type: 'tool_result',
            id: 'call',
            name: 'read',
            output: 'ok',
            state: 'running',
            metadata: {},
            created_at: TIMESTAMP,
            finished_at: null,
        });
    });

    test('validates URL sources at runtime', () => {
        expect(
            URLSource({ url: 'https://example.com/image.png', media_type: 'image/png' })
        ).toEqual({
            type: 'url',
            url: 'https://example.com/image.png',
            media_type: 'image/png',
        });
        expect(() => URLSource({ url: 'not a URL', media_type: 'image/png' })).toThrow();
    });

    test('parses untrusted snake_case wire blocks and applies defaults', () => {
        expect(parseContentBlock({ type: 'text', text: 'hello' })).toEqual({
            type: 'text',
            text: 'hello',
            id: 'generated-id',
            created_at: TIMESTAMP,
            finished_at: null,
        });
        expect(() => parseContentBlock({ type: 'tool_call', id: '1' })).toThrow();
        expect(() => parseContentBlock({ type: 'unknown' })).toThrow();
    });
});
