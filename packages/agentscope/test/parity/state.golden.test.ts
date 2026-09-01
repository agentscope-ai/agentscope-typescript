import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseAgentState, parseTask } from '../../src/state';

interface StateFixture {
    python_commit: string;
    task: unknown;
    state: unknown;
}

const fixturePath = path.join(__dirname, 'fixtures/state.python.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as StateFixture;

describe('Python state golden fixture', () => {
    test('is tied to the pinned Python source commit', () => {
        expect(fixture.python_commit).toBe('de163b34b909edaba3c174190ad7e1a355e7849f');
    });

    test('round-trips the Python Task dump exactly', () => {
        expect(parseTask(fixture.task)).toEqual(fixture.task);
    });

    test('round-trips the Python AgentState dump exactly', () => {
        expect(parseAgentState(fixture.state).toJSON()).toEqual(fixture.state);
    });
});
