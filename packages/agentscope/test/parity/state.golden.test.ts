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
        expect(fixture.python_commit).toBe('61cdeae4ffe63182f3343229aa6fbd868e30b0c5');
    });

    test('round-trips the Python Task dump exactly', () => {
        expect(parseTask(fixture.task)).toEqual(fixture.task);
    });

    test('round-trips the Python AgentState dump exactly', () => {
        expect(parseAgentState(fixture.state).toJSON()).toEqual(fixture.state);
    });
});
