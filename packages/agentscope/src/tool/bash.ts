/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { TextBlock } from '../message';
import type { PermissionContext, PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior, PermissionMode, createPermissionDecision } from '../permission';
import type { BackendBase } from './backend';
import { LocalBackend, normalizeNewlines } from './backend';
import { ToolBase } from './base';
import type { ToolChunkStream, ToolMiddlewareBase } from './base';
import { BashCommandParser } from './bash-parser';
import { ToolChunk } from './response';

const FILESYSTEM_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']);

export interface BashToolOptions {
    cwd?: string;
    backend?: BackendBase;
    dangerousFiles?: string[];
    dangerousDirectories?: string[];
    middlewares?: ToolMiddlewareBase[];
}

/** Python-compatible Bash execution and permission tool. */
export class BashTool extends ToolBase {
    readonly name = 'Bash';
    readonly description = `Executes a bash command and returns its output.

The working directory persists between commands, but shell state does not. Prefer Glob, Grep, Read, Edit, and Write for filesystem operations. The timeout defaults to 120000ms and is capped at 600000ms.`;
    readonly inputSchema = z.object({
        command: z.string(),
        description: z.string().default(''),
        timeout: z.number().int().min(0).default(120000),
    });
    readonly isReadOnly = false;
    readonly isConcurrencySafe = false;
    private readonly parser = new BashCommandParser();
    private readonly backend: BackendBase;
    private readonly cwd?: string;

    constructor(options: BashToolOptions = {}) {
        super(options);
        this.backend = options.backend ?? new LocalBackend();
        this.cwd = options.cwd;
    }

    override async checkReadOnly(toolInput: Record<string, unknown>): Promise<boolean> {
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        if (!command || this.parser.checkInjectionRisk(command)) return false;
        return this.parser.isReadOnlyCommand(command);
    }

    async checkPermissions(
        toolInput: Record<string, unknown>,
        context: PermissionContext
    ): Promise<PermissionDecision> {
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        if (!command) {
            return createPermissionDecision({
                behavior: PermissionBehavior.PASSTHROUGH,
                message: 'Empty command',
            });
        }
        const injection = this.parser.checkInjectionRisk(command);
        if (injection) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: `Permission required: ${injection}`,
                decisionReason:
                    'Safety check: command contains dynamic expansion that cannot be statically analyzed',
                bypassImmune: true,
            });
        }
        if (this.parser.isReadOnlyCommand(command)) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ALLOW,
                message: 'Permission granted for read-only command',
                decisionReason: 'Read-only command is allowed',
            });
        }
        const dangerousCommand = this.parser.checkDangerousCommand(command);
        if (dangerousCommand) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: `Permission required: Command contains dangerous pattern: ${dangerousCommand}`,
                decisionReason: 'Safety check: dangerous command pattern detected',
                bypassImmune: true,
            });
        }
        const sedError = this.parser.checkSedConstraints(command, this.dangerousFiles);
        if (sedError) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: `Permission required: ${sedError}`,
                decisionReason: 'Safety check: sed in-place modification of dangerous file',
                bypassImmune: true,
            });
        }
        const dangerousPaths = this.parser
            .extractFilePaths(command)
            .map(([, filePath]) => filePath)
            .filter(filePath => this.isDangerousPath(filePath));
        if (dangerousPaths.length) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: `Permission required: Bash command operates on sensitive paths: ${dangerousPaths.join(', ')}`,
                decisionReason: 'Safety check: dangerous file or directory in bash command',
                bypassImmune: true,
            });
        }
        const dangerousRemoval = await this.checkDangerousRemovalPath(command);
        if (dangerousRemoval) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message:
                    `Dangerous removal operation detected: '${dangerousRemoval}'\n\n` +
                    'This command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.',
                decisionReason: 'Safety check: dangerous removal of critical system path',
                bypassImmune: true,
            });
        }
        if ([PermissionMode.ACCEPT_EDITS, PermissionMode.DONT_ASK].includes(context.mode)) {
            const baseCommand = command.trim().split(/\s+/, 1)[0];
            const targets = this.parser.extractFilePaths(command).map(([, filePath]) => filePath);
            if (
                FILESYSTEM_COMMANDS.has(baseCommand) &&
                targets.length > 0 &&
                targets.every(filePath => this.pathInAllowedWorkingPath(filePath, context))
            ) {
                return createPermissionDecision({
                    behavior: PermissionBehavior.ALLOW,
                    message:
                        `Permission granted for '${baseCommand}' command ` +
                        '(filesystem command, all targets in working directory)',
                    decisionReason:
                        `Filesystem command '${baseCommand}' is auto-allowed because ` +
                        'all target paths are within a working directory',
                });
            }
        }
        return createPermissionDecision({
            behavior: PermissionBehavior.PASSTHROUGH,
            message: `Execute bash command: ${command}`,
        });
    }

    override async matchRule(
        ruleContent: string,
        toolInput: Record<string, unknown>
    ): Promise<boolean> {
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        if (ruleContent.endsWith(':*')) {
            const prefix = ruleContent.slice(0, -2).trim();
            return command === prefix || command.startsWith(`${prefix} `);
        }
        if (!hasUnescapedWildcard(ruleContent)) {
            const literal = ruleContent
                .replace(/\\\\/g, '\0')
                .replace(/\\\*/g, '*')
                .replace(/\0/g, '\\');
            return command.includes(literal);
        }
        let pattern = ruleContent.replace(/\\\\/g, '\0B').replace(/\\\*/g, '\0S');
        pattern = escapeRegexExceptAsterisk(pattern).replace(/\*/g, '.*');
        pattern = pattern.replace(/\0S/g, '\\*').replace(/\0B/g, '\\\\');
        if (pattern.endsWith('.*')) {
            const base = pattern.slice(0, -2).trimEnd();
            if (new RegExp(`^${base}$`).test(command)) return true;
        }
        try {
            return new RegExp(`^${pattern}$`).test(command);
        } catch {
            return command.includes(ruleContent.replace(/\*/g, ''));
        }
    }

    override async generateSuggestions(
        toolInput: Record<string, unknown>
    ): Promise<PermissionRule[]> {
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        return this.parser.extractCommandPrefixes(command, 5).map(prefix => ({
            tool_name: this.name,
            rule_content: `${prefix}:*`,
            behavior: PermissionBehavior.ALLOW,
            source: 'suggested',
        }));
    }

    async call(input: Record<string, unknown>): Promise<ToolChunkStream> {
        const parsed = this.inputSchema.parse(input);
        return this.execute(parsed.command, Math.min(parsed.timeout, 600000));
    }

    private async *execute(command: string, timeout: number): ToolChunkStream {
        try {
            const shell = this.backend.osName === 'nt' ? ['cmd', '/c'] : ['/bin/sh', '-c'];
            const result = await this.backend.execShell([...shell, command], {
                cwd: this.cwd,
                timeout: timeout / 1000,
            });
            const stdout = normalizeNewlines(result.stdout.toString('utf8'));
            const stderr = normalizeNewlines(result.stderr.toString('utf8'));
            if (result.exitCode === -1 && result.stderr.equals(Buffer.from('timed out'))) {
                yield errorChunk(`Command timed out after ${timeout}ms: ${command}`);
                return;
            }
            if (!result.ok()) {
                let output = `Command failed: ${command}\n`;
                if (stdout) output += `\nStdout:\n${stdout}`;
                if (stderr) output += `\nStderr:\n${stderr}`;
                yield errorChunk(truncate(output));
                return;
            }
            yield new ToolChunk({
                content: [
                    TextBlock({
                        text: truncate(stdout + (stdout && stderr ? '\n' : '') + stderr),
                    }),
                ],
            });
        } catch (error) {
            yield errorChunk(
                `Command failed: ${command}\nError: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async checkDangerousRemovalPath(command: string): Promise<string | null> {
        for (const subcommand of this.parser.splitCompoundCommand(command)) {
            const tokens = subcommand.trim().split(/\s+/);
            if (!['rm', 'rmdir'].includes(tokens[0])) continue;
            for (const token of tokens.slice(1)) {
                if (token.startsWith('-')) continue;
                const filePath = token.replace(/^['"]|['"]$/g, '');
                if (await this.isDangerousRemovalPath(filePath)) return filePath;
            }
        }
        return null;
    }

    private async isDangerousRemovalPath(filePath: string): Promise<boolean> {
        if (['*', './*', '/'].includes(filePath)) return true;
        if (filePath.endsWith('/*') || filePath.endsWith('\\*')) return true;
        const expanded = await this.backend.expandUser(filePath);
        const absolute = this.backend.absolutePath(expanded, await this.backend.getCwd());
        if (absolute === (await this.backend.expandUser('~'))) return true;
        const parent = this.backend.dirname(absolute);
        if (absolute === parent) return true;
        return this.backend.dirname(parent) === parent;
    }
}

/**
 * Preserve the existing TypeScript factory API while returning ToolBase.
 * @param options
 */
export function Bash(options: BashToolOptions = {}): BashTool {
    return new BashTool(options);
}

function truncate(value: string): string {
    return value.length > 30000 ? `${value.slice(0, 30000)}\n... (output truncated)` : value;
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })], state: 'error' });
}

function hasUnescapedWildcard(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '\\') index += 1;
        else if (value[index] === '*') return true;
    }
    return false;
}

function escapeRegexExceptAsterisk(value: string): string {
    return value.replace(/[.^$+?{}[\]|()]/g, '\\$&');
}
