import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseAgentEvent } from '../../src/event';
import { parseContentBlock, parseMsg } from '../../src/message';

interface GoldenFixture {
    python_commit: string;
    blocks: unknown[];
    messages: unknown[];
    events: unknown[];
}

const fixturePath = path.join(__dirname, 'fixtures/message-event.python.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture;

describe('Python message/event golden fixture', () => {
    test('is tied to the pinned Python source commit', () => {
        expect(fixture.python_commit).toBe('de163b34b909edaba3c174190ad7e1a355e7849f');
    });

    test('round-trips Python content block dumps exactly', () => {
        expect(fixture.blocks.map(parseContentBlock)).toEqual(fixture.blocks);
    });

    test('round-trips Python message dumps exactly', () => {
        expect(fixture.messages.map(parseMsg)).toEqual(fixture.messages);
    });

    test('round-trips Python event dumps exactly', () => {
        expect(fixture.events.map(parseAgentEvent)).toEqual(fixture.events);
    });
});
