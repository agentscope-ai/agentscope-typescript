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

const VCS_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
const DEFAULT_HEAD_LIMIT = 250;

export interface GrepToolOptions {
    backend?: BackendBase;
    middlewares?: ToolMiddlewareBase[];
}

/** Python-compatible ripgrep wrapper. */
export class GrepTool extends ToolBase {
    readonly name = 'Grep';
    readonly description = `A powerful search tool built on ripgrep.

- ALWAYS use Grep for search tasks. NEVER invoke grep or rg as a Bash command.
- Supports full regex syntax, file glob/type filters, context, multiline mode, pagination, and three output modes.`;
    readonly inputSchema = z.object({
        pattern: z.string(),
        path: z.string().optional(),
        output_mode: z
            .enum(['content', 'files_with_matches', 'count'])
            .default('files_with_matches'),
        glob: z.string().optional(),
        type: z.string().optional(),
        '-A': z.number().int().optional(),
        '-B': z.number().int().optional(),
        '-C': z.number().int().optional(),
        context: z.number().int().optional(),
        n: z.boolean().default(true),
        i: z.boolean().default(false),
        case_insensitive: z.boolean().default(false),
        multiline: z.boolean().default(false),
        head_limit: z.number().int().optional(),
        offset: z.number().int().default(0),
    });
    readonly isReadOnly = true;
    readonly isConcurrencySafe = true;
    private readonly backend: BackendBase;

    constructor(options: GrepToolOptions = {}) {
        super(options);
        this.backend = options.backend ?? new LocalBackend();
    }

    async checkPermissions(): Promise<PermissionDecision> {
        return createPermissionDecision({
            behavior: PermissionBehavior.PASSTHROUGH,
            message: 'Grep search is read-only.',
        });
    }

    override async matchRule(
        ruleContent: string,
        toolInput: Record<string, unknown>
    ): Promise<boolean> {
        const searchPath =
            typeof toolInput.path === 'string' ? toolInput.path : await this.backend.getCwd();
        return minimatch(searchPath, ruleContent, { dot: true });
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
        if (parsed.head_limit !== undefined && parsed.head_limit < 0) {
            return errorChunk('Error: head_limit must be non-negative.');
        }
        if (parsed.offset < 0) return errorChunk('Error: offset must be non-negative.');
        const searchPath = parsed.path ?? (await this.backend.getCwd());
        const args = ['--hidden'];
        for (const directory of VCS_DIRECTORIES) args.push('--glob', `!${directory}`);
        args.push('--max-columns', '500');
        if (parsed.multiline) args.push('-U', '--multiline-dotall');
        if (parsed.i || parsed.case_insensitive) args.push('-i');
        if (parsed.output_mode === 'files_with_matches') args.push('-l');
        else if (parsed.output_mode === 'count') args.push('-c');
        if (parsed.n && parsed.output_mode === 'content') args.push('-n');
        if (parsed.output_mode === 'content') {
            if (parsed.context !== undefined) args.push('-C', String(parsed.context));
            else if (parsed['-C'] !== undefined) args.push('-C', String(parsed['-C']));
            else {
                if (parsed['-B'] !== undefined) args.push('-B', String(parsed['-B']));
                if (parsed['-A'] !== undefined) args.push('-A', String(parsed['-A']));
            }
        }
        if (parsed.pattern.startsWith('-')) args.push('-e', parsed.pattern);
        else args.push(parsed.pattern);
        if (parsed.type) args.push('--type', parsed.type);
        if (parsed.glob) {
            for (const pattern of splitGlobPatterns(parsed.glob)) args.push('--glob', pattern);
        }

        const result = await this.backend.execShell(['rg', ...args, searchPath], { timeout: 30 });
        if (result.exitCode === -1 && result.stderr.equals(Buffer.from('timed out'))) {
            return errorChunk(
                'Ripgrep search timed out after 30 seconds. Try searching a more specific path or pattern.'
            );
        }
        if (![0, 1].includes(result.exitCode)) {
            return errorChunk(
                `ripgrep error (code ${result.exitCode}): ${result.stderr.toString('utf8').trim()}`
            );
        }
        const results = result.stdout
            .toString('utf8')
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean);
        if (results.length === 0) {
            return new ToolChunk({
                content: [TextBlock({ text: `No matches found for pattern: ${parsed.pattern}` })],
                state: 'success',
            });
        }
        const limit = parsed.head_limit === 0 ? null : (parsed.head_limit ?? DEFAULT_HEAD_LIMIT);
        const sliced =
            limit === null
                ? results.slice(parsed.offset)
                : results.slice(parsed.offset, parsed.offset + limit);
        const truncated = limit !== null && results.length - parsed.offset > limit;
        let suffix = '';
        if (truncated) {
            suffix = `\n\n[Showing results with pagination = limit: ${limit}`;
            if (parsed.offset) suffix += `, offset: ${parsed.offset}`;
            suffix += ']';
        }
        return new ToolChunk({
            content: [TextBlock({ text: sliced.join('\n') + suffix })],
            state: 'success',
        });
    }
}

/**
 * Preserve the existing TypeScript factory API while returning ToolBase.
 * @param options
 */
export function Grep(options: GrepToolOptions = {}): GrepTool {
    return new GrepTool(options);
}

function splitGlobPatterns(value: string): string[] {
    const result: string[] = [];
    for (const raw of value.split(/\s+/).filter(Boolean)) {
        if (raw.includes('{') && raw.includes('}')) result.push(raw);
        else result.push(...raw.split(',').filter(Boolean));
    }
    return result;
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })], state: 'error' });
}
