import { createMsg } from './message';
import { setIdFactory, setTimestampFactory } from '../_utils/common';

describe('message entity factories', () => {
    afterEach(() => {
        setIdFactory(() => crypto.randomUUID().replaceAll('-', ''));
        setTimestampFactory(() => new Date().toISOString());
    });

    test('custom factories affect both messages and generated content blocks', () => {
        setIdFactory(() => 'custom-entity-id');
        setTimestampFactory(() => '2026-09-01T12:34:56.123456');

        expect(createMsg({ name: 'test', content: 'hello', role: 'user' })).toEqual({
            id: 'custom-entity-id',
            name: 'test',
            role: 'user',
            content: [
                {
                    id: 'custom-entity-id',
                    type: 'text',
                    text: 'hello',
                    created_at: '2026-09-01T12:34:56.123456',
                },
            ],
            metadata: {},
            created_at: '2026-09-01T12:34:56.123456',
            finished_at: undefined,
            usage: undefined,
        });
    });

    test('default IDs use Python-compatible UUID hex format', () => {
        const message = createMsg({ name: 'test', content: 'hello', role: 'user' });

        expect(message.id).toMatch(/^[0-9a-f]{32}$/);
        expect(message.content[0].id).toMatch(/^[0-9a-f]{32}$/);
    });
});
