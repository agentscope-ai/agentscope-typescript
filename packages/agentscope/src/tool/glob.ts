/* eslint-disable jsdoc/require-jsdoc */

import { minimatch } from 'minimatch';
import { z } from 'zod';

import { TextBlock } from '../message';
import type { PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior, createPermissionDecision } from '../permission';
import type { BackendBase } from './backend';
import { LocalBackend } from './backend';
import { ToolBase } from './base';
import type { ToolMiddlewareBase } from './base';
import { ToolChunk } from './response';
import { fnmatchPath } from './utils';

export interface GlobToolOptions {
    backend?: BackendBase;
    middlewares?: ToolMiddlewareBase[];
}

/** Python-compatible recursive file globber. */
export class GlobTool extends ToolBase {
    readonly name = 'Glob';
    readonly description = `Fast file pattern matching tool that works with any codebase size.

Supports glob patterns like "**/*.js" or "src/**/*.ts" and returns matching file paths sorted by modification time (newest first).`;
    readonly inputSchema = z.object({
        pattern: z.string().describe('The glob pattern to match.'),
        path: z.string().optional().describe('The base directory to search.'),
    });
    readonly isReadOnly = true;
    readonly isConcurrencySafe = true;
    private readonly backend: BackendBase;

    constructor(options: GlobToolOptions = {}) {
        super(options);
        this.backend = options.backend ?? new LocalBackend();
    }

    async checkPermissions(): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.PASSTHROUGH,
            message: 'Glob pattern matching is read-only.',
        });
    }

    override async matchRule(
        ruleContent: string,
        toolInput: Record<string, unknown>
    ): Promise<boolean> {
        const searchPath = typeof toolInput.path === 'string' ? toolInput.path : '';
        const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : '';
        return (
            (searchPath !== '' && fnmatchPath(searchPath, ruleContent)) ||
            (pattern !== '' && fnmatchPath(pattern, ruleContent))
        );
    }

    override async generateSuggestions(
        toolInput: Record<string, unknown>
    ): Promise<PermissionRule[]> {
        const cwd = await this.backend.getCwd();
        const inputPath = typeof toolInput.path === 'string' ? toolInput.path : cwd;
        const absolute = this.backend.absolutePath(inputPath, cwd);
        return [
            {
                tool_name: this.name,
                rule_content: `${absolute.replace(/[\\/]+$/, '')}/**`,
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ];
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const baseDirectory = parsed.path ?? (await this.backend.getCwd());
        if (!(await this.backend.isDirectory(baseDirectory))) {
            return new ToolChunk({
                content: [TextBlock({ text: `Directory not found: ${baseDirectory}` })],
                state: 'error',
            });
        }
        const normalizedPattern = parsed.pattern.replace(/\\/g, '/');
        const matches: Array<{ filePath: string; mtime: number }> = [];
        await this.collect(baseDirectory, '', normalizedPattern, matches);
        matches.sort((left, right) => right.mtime - left.mtime);
        return new ToolChunk({
            content: [
                TextBlock({
                    text:
                        matches.length === 0
                            ? `No files found matching pattern: ${parsed.pattern}`
                            : matches.map(match => match.filePath).join('\n'),
                }),
            ],
        });
    }

    private async collect(
        directory: string,
        relativeDirectory: string,
        pattern: string,
        matches: Array<{ filePath: string; mtime: number }>
    ): Promise<void> {
        for (const entry of await this.backend.scanDirectory(directory)) {
            const filePath = this.backend.joinPath(directory, entry.name);
            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;
            if (entry.isDir) {
                await this.collect(filePath, relativePath, pattern, matches);
            } else if (minimatch(relativePath, pattern, { dot: true })) {
                matches.push({ filePath, mtime: entry.mtime ?? 0 });
            }
        }
    }
}

/**
 * Preserve the existing TypeScript factory API while returning ToolBase.
 * @param options
 */
export function Glob(options: GlobToolOptions = {}): GlobTool {
    return new GlobTool(options);
}
