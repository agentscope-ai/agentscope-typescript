/* eslint-disable jsdoc/require-jsdoc */

import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';

import { TextBlock } from '../message';
import type { PermissionContext, PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior, PermissionMode, createPermissionDecision } from '../permission';
import type { AgentState } from '../state';
import type { BackendBase } from './backend';
import { LocalBackend } from './backend';
import { ToolBase } from './base';
import type { ToolMiddlewareBase } from './base';
import { ToolChunk } from './response';

export interface WriteToolOptions {
    backend?: BackendBase;
    dangerousFiles?: string[];
    dangerousDirectories?: string[];
    middlewares?: ToolMiddlewareBase[];
}

/** Python-compatible builtin file writer. */
export class WriteTool extends ToolBase {
    readonly name = 'Write';
    readonly description = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;
    readonly inputSchema = z.object({
        file_path: z.string().describe('The absolute path to the file to write.'),
        content: z.string().describe('The content to write to the file.'),
    });
    readonly isReadOnly = false;
    readonly isConcurrencySafe = false;
    override isStateInjected = true;
    private readonly backend: BackendBase;

    constructor(options: WriteToolOptions = {}) {
        super(options);
        this.backend = options.backend ?? new LocalBackend();
    }

    async checkPermissions(
        toolInput: Record<string, unknown>,
        context: PermissionContext
    ): Promise<PermissionDecision> {
        const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
        if (!filePath) {
            return createPermissionDecision({
                behavior: PermissionBehavior.PASSTHROUGH,
                message: 'No file path provided',
            });
        }
        if (this.isDangerousPath(filePath)) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ASK,
                message: `Permission required: Write operation on sensitive file ${filePath}`,
                decisionReason: 'Safety check: dangerous file or directory',
                bypassImmune: true,
            });
        }
        if (
            [PermissionMode.ACCEPT_EDITS, PermissionMode.DONT_ASK].includes(context.mode) &&
            this.pathInAllowedWorkingPath(filePath, context)
        ) {
            return createPermissionDecision({
                behavior: PermissionBehavior.ALLOW,
                message: `Permission granted for writing ${filePath} (in working directory)`,
                decisionReason: 'File is in working directory and not a dangerous path',
            });
        }
        return createPermissionDecision({
            behavior: PermissionBehavior.PASSTHROUGH,
            message: '',
        });
    }

    override async matchRule(
        ruleContent: string,
        toolInput: Record<string, unknown>
    ): Promise<boolean> {
        const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
        return filePath !== '' && globMatches(filePath, ruleContent);
    }

    override async generateSuggestions(
        toolInput: Record<string, unknown>
    ): Promise<PermissionRule[]> {
        const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
        if (!filePath) return [];
        const parent = this.backend.dirname(filePath);
        return [
            {
                tool_name: this.name,
                rule_content: parent ? `${parent.replace(/[\\/]+$/, '')}/**` : '**',
                behavior: PermissionBehavior.ALLOW,
                source: 'suggested',
            },
        ];
    }

    async call(input: Record<string, unknown>): Promise<ToolChunk> {
        const parsed = this.inputSchema.parse(input);
        const filePath = parsed.file_path;
        if (!this.backend.isAbsolute(filePath)) {
            return errorChunk(`Error: file_path must be an absolute path, got: ${filePath}`);
        }

        const state = input._agent_state as AgentState | undefined;
        const fileExisted = await this.backend.fileExists(filePath);
        if (fileExisted && state) {
            const mtime = await this.backend.statMtime(filePath);
            if (!(await state.toolContext.getCache({ filePath, mtime }))) {
                return errorChunk(
                    `Error: File ${filePath} exists but has not been read yet. ` +
                        'You must read the file first before writing to it.'
                );
            }
        }

        let previousContent = '';
        if (fileExisted) {
            try {
                previousContent = (await this.backend.readFile(filePath)).toString('utf8');
            } catch {
                previousContent = '';
            }
        }
        await this.backend.writeFile(filePath, Buffer.from(parsed.content, 'utf8'));
        const oldName = fileExisted ? `a/${filePath}` : '/dev/null';
        const diff = createTwoFilesPatch(
            oldName,
            `b/${filePath}`,
            previousContent,
            parsed.content,
            '',
            '',
            {
                context: 3,
            }
        ).replace(/^===================================================================\n/, '');
        return new ToolChunk({
            content: [
                TextBlock({
                    text:
                        `The file ${filePath} has been written successfully ` +
                        `(${parsed.content.split('\n').length} lines).`,
                }),
            ],
            metadata: { diff, file_path: filePath, occurrences: 1 },
        });
    }
}

/**
 * Preserve the existing TypeScript factory API while returning ToolBase.
 * @param options
 */
export function Write(options: WriteToolOptions = {}): WriteTool {
    return new WriteTool(options);
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })], state: 'error' });
}

function globMatches(value: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = escaped.replace(/\*\*/g, '\0').replace(/\*/g, '[^/\\\\]*').replace(/\0/g, '.*');
    return new RegExp(`^${regex}$`).test(value);
}
