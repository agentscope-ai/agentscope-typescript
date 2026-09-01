import { BashCommandParser } from './bash-parser';

describe('BashCommandParser', () => {
    const parser = new BashCommandParser();

    test('extracts and deduplicates prefixes across compounds', () => {
        expect(parser.extractCommandPrefixes("git add . && git commit -m 'fix'")).toEqual([
            'git add',
            'git commit',
        ]);
        expect(parser.extractCommandPrefixes('NODE_ENV=prod npm run build')).toEqual(['npm run']);
        expect(parser.extractCommandPrefixes('SECRET=x npm run build')).toEqual([]);
        expect(parser.extractCommandPrefixes('npm run a && npm run b && npm test')).toEqual([
            'npm run',
            'npm test',
        ]);
        expect(parser.extractCommandPrefixes('ls -la | grep x')).toEqual([]);
    });

    test('classifies read-only and mutating commands conservatively', () => {
        for (const command of [
            'git status',
            'git log --oneline',
            "find . -name '*.py'",
            'ls && cat file',
            'docker inspect id',
        ]) {
            expect(parser.isReadOnlyCommand(command)).toBe(true);
        }
        for (const command of [
            'git commit -m x',
            'find . -delete',
            'ls && touch file',
            'cat file > output',
            '',
        ]) {
            expect(parser.isReadOnlyCommand(command)).toBe(false);
        }
    });

    test('extracts file paths and redirections with Python edge semantics', () => {
        expect(parser.extractFilePaths('rm -rf /tmp/a && cp x y > log')).toEqual([
            ['rm', '/tmp/a'],
            ['redirect', 'log'],
            ['cp', 'x'],
            ['cp', 'y'],
        ]);
        expect(parser.extractFilePaths('chmod 755 /usr/bin/tool')).toEqual([
            ['chmod', '/usr/bin/tool'],
        ]);
        expect(parser.extractFilePaths('chmod +x script.sh')).toEqual([
            ['chmod', '+x'],
            ['chmod', 'script.sh'],
        ]);
        expect(parser.extractFilePaths('rm "file with spaces"')).toEqual([]);
        expect(parser.extractFilePaths("sed -i 's/a/b/' file.txt")).toEqual([['sed', 'file.txt']]);
        expect(parser.extractRedirections('cmd > out 2> err &> all')).toEqual([
            'out',
            'err',
            'all',
        ]);
    });

    test('detects dynamic syntax and dangerous commands', () => {
        expect(parser.checkInjectionRisk('ls $(pwd)')).toContain('command_substitution');
        expect(parser.checkInjectionRisk('diff <(ls a) <(ls b)')).toContain('process_substitution');
        expect(parser.checkInjectionRisk('for f in *; do cat $f; done')).toContain('for_statement');
        expect(parser.checkInjectionRisk('(cd /tmp && ls)')).toContain('subshell');
        expect(parser.checkInjectionRisk('ls && cat file')).toBeNull();
        expect(parser.checkDangerousCommand('git add .')).toBeNull();
        expect(parser.checkDangerousCommand('dd if=x of=y')).toBe('dd');
        expect(parser.checkDangerousCommand('sudo rm file')).toBe('sudo rm');
    });

    test('enforces the sed allowlist and denylist', () => {
        expect(parser.checkSedConstraints("sed -n '5p' file", ['.env'])).toBeNull();
        expect(parser.checkSedConstraints("sed 's/a/b/g' file", ['.env'])).toBeNull();
        expect(parser.checkSedConstraints("sed 's/a/b/e' file", ['.env'])).toContain(
            'execute operation'
        );
        expect(parser.checkSedConstraints("sed -i 's/a/b/' .env", ['.env'])).toContain(
            'dangerous file'
        );
        expect(parser.checkSedConstraints("sed -r 's/a/b/' file", ['.env'])).toContain(
            'flag -r not allowed'
        );
    });
});
