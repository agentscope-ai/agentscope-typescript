/* eslint-disable jsdoc/require-jsdoc */

const SAFE_COMMANDS = new Set([
    'echo',
    'cat',
    'ls',
    'pwd',
    'cd',
    'true',
    'false',
    'printf',
    'grep',
    'tee',
]);
const SAFE_ENVIRONMENT_VARIABLES = new Set([
    'NODE_ENV',
    'PYTHONUNBUFFERED',
    'RUST_LOG',
    'LANG',
    'TERM',
    'NO_COLOR',
    'FORCE_COLOR',
    'DEBUG',
    'VERBOSE',
    'CI',
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'EDITOR',
    'PAGER',
    'TZ',
    'LC_ALL',
    'LC_CTYPE',
    'COLUMNS',
    'LINES',
    'CLICOLOR',
    'CLICOLOR_FORCE',
]);
const READ_ONLY_COMMANDS = new Set([
    'ls',
    'cat',
    'head',
    'tail',
    'less',
    'more',
    'file',
    'stat',
    'wc',
    'grep',
    'rg',
    'ag',
    'ack',
    'find',
    'tree',
    'pwd',
    'which',
    'whereis',
    'type',
    'git status',
    'git log',
    'git diff',
    'git show',
    'git branch',
    'git tag',
    'git remote',
    'git ls-files',
    'git ls-tree',
    'git cat-file',
    'git rev-parse',
    'git rev-list',
    'git describe',
    'git shortlog',
    'git blame',
    'git grep',
    'git reflog',
    'git config --get',
    'git config --list',
    'docker ps',
    'docker images',
    'docker inspect',
    'docker logs',
    'docker version',
    'docker info',
    'gh repo view',
    'gh issue list',
    'gh pr list',
    'gh status',
    'python --version',
    'python -V',
    'node --version',
    'node -v',
    'npm list',
    'npm ls',
    'pip list',
    'pip show',
]);
const FIND_MUTATING_PREDICATES = new Set([
    '-delete',
    '-exec',
    '-execdir',
    '-fls',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-ok',
    '-okdir',
]);
const FILE_COMMANDS = new Set([
    'rm',
    'mv',
    'cp',
    'chmod',
    'chown',
    'chgrp',
    'touch',
    'ln',
    'sed',
    'mkdir',
    'rmdir',
]);
const DANGEROUS_COMMANDS = [
    'rm -rf',
    'sudo rm',
    'dd',
    'mkfs',
    'fdisk',
    'format',
    'chmod 777',
    'chmod -R 777',
    'chown -R',
    'kill -9',
    '> /dev/',
];

interface ShellToken {
    value: string;
    quoted: boolean;
    operator: boolean;
}

/** Conservative Bash syntax utilities used by permission checks. */
export class BashCommandParser {
    /**
     * Return whether every simple command is statically read-only.
     * @param command
     */
    isReadOnlyCommand(command: string): boolean {
        const value = command.trim();
        if (!value || /(?:^|\s)(?:>|>>|2>|&>)/.test(value)) return false;
        return this.splitCompoundCommand(value).every(part => this.isSingleReadOnly(part));
    }

    /**
     * Extract file-command arguments and output-redirection targets.
     * @param command
     */
    extractFilePaths(command: string): Array<[string, string]> {
        const result: Array<[string, string]> = [];
        for (const subcommand of this.splitCompoundCommand(command)) {
            const tokens = lexShell(subcommand);
            for (let index = 0; index < tokens.length; index += 1) {
                const token = tokens[index];
                if (isRedirection(token.value) && tokens[index + 1]) {
                    result.push(['redirect', tokens[index + 1].value]);
                    index += 1;
                }
            }
            const commandIndex = tokens.findIndex(
                token => !token.operator && !isAssignment(token.value)
            );
            if (commandIndex === -1) continue;
            const name = tokens[commandIndex].value;
            if (!FILE_COMMANDS.has(name)) continue;
            let expressionSkipped = name !== 'sed';
            const argumentsAndOperators = tokens.slice(commandIndex + 1);
            for (let index = 0; index < argumentsAndOperators.length; index += 1) {
                const token = argumentsAndOperators[index];
                if (isRedirection(token.value)) {
                    index += 1;
                    continue;
                }
                if (token.operator) continue;
                if (token.value.startsWith('-')) continue;
                if (name === 'sed' && !expressionSkipped) {
                    expressionSkipped = true;
                    continue;
                }
                if (token.quoted) continue;
                if (name === 'chmod' && /^\d+$/.test(token.value)) continue;
                result.push([name, token.value]);
            }
        }
        return result;
    }

    /**
     * Extract output redirection targets in source order.
     * @param command
     */
    extractRedirections(command: string): string[] {
        const tokens = lexShell(command);
        const result: string[] = [];
        for (let index = 0; index < tokens.length - 1; index += 1) {
            if (isRedirection(tokens[index].value)) result.push(tokens[index + 1].value);
        }
        return result;
    }

    /**
     * Extract up to five unique command/subcommand prefixes.
     * @param command
     * @param maxPrefixes
     */
    extractCommandPrefixes(command: string, maxPrefixes = 5): string[] {
        const result: string[] = [];
        for (const subcommand of this.splitCompoundCommand(command).slice(0, maxPrefixes)) {
            const tokens = lexShell(subcommand).filter(token => !token.operator);
            const assignments: string[] = [];
            while (tokens.length && isAssignment(tokens[0].value)) {
                assignments.push(tokens.shift()!.value.split('=', 1)[0]);
            }
            if (assignments.some(name => !SAFE_ENVIRONMENT_VARIABLES.has(name))) continue;
            if (tokens.length < 2 || SAFE_COMMANDS.has(tokens[0].value.toLowerCase())) continue;
            const prefix = `${tokens[0].value} ${tokens[1].value}`;
            if (!result.includes(prefix)) result.push(prefix);
            if (result.length >= maxPrefixes) break;
        }
        return result;
    }

    /**
     * Split &&, ||, semicolon, and pipelines outside quoted strings.
     * @param command
     */
    splitCompoundCommand(command: string): string[] {
        const result: string[] = [];
        let start = 0;
        let quote: "'" | '"' | null = null;
        let escaped = false;
        for (let index = 0; index < command.length; index += 1) {
            const character = command[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === '\\' && quote !== "'") {
                escaped = true;
                continue;
            }
            if (quote) {
                if (character === quote) quote = null;
                continue;
            }
            if (character === "'" || character === '"') {
                quote = character;
                continue;
            }
            const two = command.slice(index, index + 2);
            if (two === '&&' || two === '||') {
                if (command.slice(start, index).trim())
                    result.push(command.slice(start, index).trim());
                start = index + 2;
                index += 1;
            } else if (character === ';' || character === '|') {
                if (command.slice(start, index).trim())
                    result.push(command.slice(start, index).trim());
                start = index + 1;
            }
        }
        if (command.slice(start).trim()) result.push(command.slice(start).trim());
        return result.length ? result : [command];
    }

    /**
     * Return the first configured dangerous command pattern.
     * @param command
     */
    checkDangerousCommand(command: string): string | null {
        const normalized = command.trim().replace(/\s+/g, ' ');
        for (const pattern of DANGEROUS_COMMANDS) {
            if (!pattern.includes(' ') && pattern.length <= 4) {
                if (new RegExp(`\\b${escapeRegex(pattern)}\\b`).test(normalized)) return pattern;
            } else if (normalized.includes(pattern)) return pattern;
        }
        return null;
    }

    /**
     * Validate sed against Python's narrow read/substitution allowlist.
     * @param command
     * @param dangerousFiles
     */
    checkSedConstraints(command: string, dangerousFiles: string[]): string | null {
        if (!/(?:^|\s|\/)sed(?:\s|$)/.test(command)) return null;
        const tokens = lexShell(command)
            .filter(token => !token.operator)
            .map(token => token.value);
        const sedIndex = tokens.findIndex(token => token === 'sed' || token.endsWith('/sed'));
        if (sedIndex === -1) return null;
        const flags: string[] = [];
        const expressions: string[] = [];
        const files: string[] = [];
        let foundExpression = false;
        for (let index = sedIndex + 1; index < tokens.length; index += 1) {
            const argument = tokens[index];
            if (argument === '-e' || argument === '--expression') {
                if (tokens[index + 1]) expressions.push(tokens[++index]);
            } else if (argument === '--in-place') {
                flags.push('i');
            } else if (argument.startsWith('-') && !argument.startsWith('--')) {
                flags.push(...argument.slice(1));
            } else if (!foundExpression) {
                expressions.push(argument);
                foundExpression = true;
            } else {
                files.push(argument);
            }
        }
        if (!expressions.length) return 'sed command missing expression';
        for (const flag of flags) {
            if (!new Set(['n', 'E', 'e', 'i']).has(flag)) return `sed flag -${flag} not allowed`;
        }
        for (const expression of expressions) {
            if (/\/[wW](?:\s+\S+|$)/.test(expression))
                return 'sed write operation (w/W) not allowed';
            if (/\/[eE](?:\s|$)/.test(expression)) return 'sed execute operation (e/E) not allowed';
            if (/[{}]/.test(expression)) return 'sed curly braces not allowed';
            if (expression.startsWith('!')) return 'sed negation (!) not allowed';
            if (expression.includes('#') && !expression.startsWith('s#'))
                return 'sed comments not allowed';
            if (flags.includes('n') && /^(?:\d+p|\d+,\d+p)$/.test(expression)) continue;
            if (/^s([/|#]).*\1[gp\d]*$/.test(expression)) continue;
            return `sed expression '${expression}' not in allowlist`;
        }
        if (flags.includes('i')) {
            for (const file of files) {
                if (dangerousFiles.some(value => file.includes(value) || file.endsWith(value))) {
                    return `sed -i modifying dangerous file: ${file}`;
                }
            }
        }
        return null;
    }

    /**
     * Detect shell structures whose behavior cannot be statically analyzed.
     * @param command
     */
    checkInjectionRisk(command: string): string | null {
        const visible = maskSingleQuoted(command);
        const checks: Array<[RegExp, string]> = [
            [/(?:^|[;&|\s])for\s+\w+\s+in\b/, 'for_statement'],
            [/(?:^|[;&|\s])while\s+/, 'while_statement'],
            [/(?:^|[;&|\s])until\s+/, 'until_statement'],
            [/(?:^|[;&|\s])if\s+/, 'if_statement'],
            [/(?:^|[;&|\s])case\s+/, 'case_statement'],
            [/(?:\bfunction\s+\w+|\b\w+\s*\(\)\s*\{)/, 'function_definition'],
            [/\[\[/, 'test_command'],
            [/<\(|>\(/, 'process_substitution'],
            [/\$\(|`/, 'command_substitution'],
            [/\$\{/, 'expansion'],
            [/(?:^|[;&|]\s*)\(/, 'subshell'],
        ];
        for (const [pattern, type] of checks) {
            if (pattern.test(visible)) {
                return `Command contains ${type} which cannot be statically analyzed`;
            }
        }
        return null;
    }

    private isSingleReadOnly(command: string): boolean {
        if (!command) return false;
        const tokens = lexShell(command)
            .filter(token => !token.operator)
            .map(token => token.value);
        let index = 0;
        while (index < tokens.length && isAssignment(tokens[index])) index += 1;
        if (index >= tokens.length) return false;
        const normalized = tokens.slice(index).join(' ');
        if (tokens[index] === 'find' && tokens.some(token => FIND_MUTATING_PREDICATES.has(token))) {
            return false;
        }
        for (const readOnly of READ_ONLY_COMMANDS) {
            if (normalized === readOnly || normalized.startsWith(`${readOnly} `)) return true;
        }
        return SAFE_COMMANDS.has(tokens[index]);
    }
}

function lexShell(command: string): ShellToken[] {
    const result: ShellToken[] = [];
    let value = '';
    let quoted = false;
    let quote: "'" | '"' | null = null;
    let escaped = false;
    const flush = (): void => {
        if (value !== '') result.push({ value, quoted, operator: false });
        value = '';
        quoted = false;
    };
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (escaped) {
            value += character;
            escaped = false;
            continue;
        }
        if (character === '\\' && quote !== "'" && !/^[A-Za-z]:/.test(value)) {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote) quote = null;
            else value += character;
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            quoted = true;
            continue;
        }
        if (/\s/.test(character)) {
            flush();
            continue;
        }
        const candidates = ['&&', '||', '>>', '2>', '&>', ';', '|', '>'];
        const operator = candidates.find(item => command.startsWith(item, index));
        if (operator) {
            flush();
            result.push({ value: operator, quoted: false, operator: true });
            index += operator.length - 1;
            continue;
        }
        value += character;
    }
    if (escaped) value += '\\';
    flush();
    return result;
}

function isAssignment(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isRedirection(value: string): boolean {
    return ['>', '>>', '2>', '&>'].includes(value);
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskSingleQuoted(command: string): string {
    let result = '';
    let quoted = false;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (character === "'" && command[index - 1] !== '\\') {
            quoted = !quoted;
            result += ' ';
        } else result += quoted ? ' ' : character;
    }
    return result;
}
