/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { TextBlock } from '../message';
import type { PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import type { BackendBase } from './backend';
import { LocalBackend, normalizeNewlines } from './backend';
import { ToolBase } from './base';
import type { ToolMiddlewareBase } from './base';
import { ToolChunk } from './response';

const SHELL_CANDIDATES = ['pwsh', 'powershell.exe'];

export interface PowerShellToolOptions {
    cwd?: string;
    backend?: BackendBase;
    middlewares?: ToolMiddlewareBase[];
}

/** Execute PowerShell source through a workspace backend. */
export class PowerShellTool extends ToolBase {
    readonly name = 'PowerShell';
    readonly description = `Executes a PowerShell command and returns its output.

Each command starts in the configured working directory, but session state does not persist. Commands run without loading the user's PowerShell profile. The timeout defaults to 120000ms and is capped at 600000ms.`;
    readonly inputSchema = z.object({
        command: z.string(),
        description: z.string().default(''),
        timeout: z.number().int().min(0).default(120000),
    });
    readonly isReadOnly = false;
    readonly isConcurrencySafe = false;
    private readonly cwd?: string;
    private readonly backend: BackendBase;
    private executable: string | null = null;

    constructor(options: PowerShellToolOptions = {}) {
        super(options);
        this.cwd = options.cwd;
        this.backend = options.backend ?? new LocalBackend();
    }

    async checkPermissions(): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.ASK,
            message: 'Execute PowerShell command',
            decisionReason: 'PowerShell command validation is not enabled',
        });
    }

    override async generateSuggestions(): Promise<PermissionRule[]> {
        return [];
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const timeout = Math.min(parsed.timeout, 600000);
        const userCommand = Buffer.from(parsed.command, 'utf16le').toString('base64');
        const script =
            '$ProgressPreference = [System.Management.Automation.ActionPreference]::SilentlyContinue\n' +
            '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n' +
            '$AgentScopeCommand = [System.Text.Encoding]::Unicode.GetString(' +
            `[System.Convert]::FromBase64String('${userCommand}'))\n` +
            '& ([ScriptBlock]::Create($AgentScopeCommand))';
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        let result;
        try {
            result = await this.backend.execShell(
                [
                    await this.resolveExecutable(),
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-EncodedCommand',
                    encoded,
                ],
                { cwd: this.cwd, timeout: timeout / 1000 }
            );
        } catch (error) {
            return errorChunk(
                `Command failed: ${parsed.command}\nError: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        const stdout = normalizeNewlines(result.stdout.toString('utf8'));
        const stderr = normalizeNewlines(result.stderr.toString('utf8'));
        if (result.exitCode === -1 && result.stderr.equals(Buffer.from('timed out'))) {
            return errorChunk(`Command timed out after ${timeout}ms: ${parsed.command}`);
        }
        if (!result.ok()) {
            let output = `Command failed: ${parsed.command}\n`;
            if (stdout) output += `\nStdout:\n${stdout}`;
            if (stderr) output += `\nStderr:\n${stderr}`;
            return errorChunk(truncate(output));
        }
        return new ToolChunk({
            content: [
                TextBlock({ text: truncate(stdout + (stdout && stderr ? '\n' : '') + stderr) }),
            ],
        });
    }

    private async resolveExecutable(): Promise<string> {
        if (this.executable) return this.executable;
        for (const candidate of SHELL_CANDIDATES) {
            const result = await this.backend.execShell(
                [candidate, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
                { timeout: 10 }
            );
            if (result.exitCode !== 127) {
                this.executable = candidate;
                return candidate;
            }
        }
        this.executable = 'powershell.exe';
        return this.executable;
    }
}

/**
 * TypeScript factory for the PowerShell builtin.
 * @param options
 */
export function PowerShell(options: PowerShellToolOptions = {}): PowerShellTool {
    return new PowerShellTool(options);
}

function truncate(value: string): string {
    return value.length > 30000 ? `${value.slice(0, 30000)}\n... (output truncated)` : value;
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })], state: 'error' });
}
