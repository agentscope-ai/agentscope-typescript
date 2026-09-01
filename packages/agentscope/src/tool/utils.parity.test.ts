import { createPythonUnifiedDiff, fnmatchPath } from './utils';

describe('tool utility Python parity', () => {
    test('matches Python fnmatch patterns across path separators', () => {
        expect(
            fnmatchPath('C:\\Users\\Alice\\project\\src\\agent.ts', 'C:/Users/Alice/project/**')
        ).toBe(true);
        expect(fnmatchPath('/tmp/project/src/agent.py', '*.py')).toBe(true);
        expect(fnmatchPath('agent.py', 'agent.?y')).toBe(true);
        expect(fnmatchPath('agent.py', 'agent.[!jt]y')).toBe(true);
        expect(fnmatchPath('agent.ts', 'agent.[!jt]s')).toBe(false);
        expect(fnmatchPath(']', '[]]')).toBe(true);
        expect(fnmatchPath('^', '[^]')).toBe(true);
    });

    test('preserves raw Python-style diff headers for Windows paths', () => {
        const oldName = 'a/C:\\Users\\Alice\\project\\agent.ts';
        const newName = 'b/C:\\Users\\Alice\\project\\agent.ts';
        const diff = createPythonUnifiedDiff(oldName, newName, 'old\n', 'new\n');

        expect(diff).toContain(`--- ${oldName}\n+++ ${newName}\n`);
        expect(diff).not.toContain(`"${oldName}"`);
    });
});
