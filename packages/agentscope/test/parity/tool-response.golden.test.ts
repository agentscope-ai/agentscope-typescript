import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseToolChunk, parseToolResponse } from '../../src/tool';

interface ToolResponseFixture {
    python_commit: string;
    chunk: unknown;
    response: unknown;
}

const fixturePath = path.join(__dirname, 'fixtures/tool-response.python.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ToolResponseFixture;

describe('Python tool-response golden fixture', () => {
    test('is tied to the pinned Python source commit', () => {
        expect(fixture.python_commit).toBe('de163b34b909edaba3c174190ad7e1a355e7849f');
    });

    test('round-trips ToolChunk and ToolResponse wire payloads exactly', () => {
        expect(parseToolChunk(fixture.chunk).toJSON()).toEqual(fixture.chunk);
        expect(parseToolResponse(fixture.response).toJSON()).toEqual(fixture.response);
    });
});
