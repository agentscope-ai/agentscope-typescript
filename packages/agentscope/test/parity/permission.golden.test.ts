import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    parsePermissionContext,
    parsePermissionDecision,
    parsePermissionRule,
} from '../../src/permission';

interface PermissionFixture {
    python_commit: string;
    rule: unknown;
    context: unknown;
    decision: unknown;
}

const fixturePath = path.join(__dirname, 'fixtures/permission.python.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as PermissionFixture;

describe('Python permission golden fixture', () => {
    test('is tied to the pinned Python source commit', () => {
        expect(fixture.python_commit).toBe('61cdeae4ffe63182f3343229aa6fbd868e30b0c5');
    });

    test('round-trips Python permission wire payloads exactly', () => {
        expect(parsePermissionRule(fixture.rule)).toEqual(fixture.rule);
        expect(parsePermissionContext(fixture.context)).toEqual(fixture.context);
        expect(parsePermissionDecision(fixture.decision)).toEqual(fixture.decision);
    });
});
