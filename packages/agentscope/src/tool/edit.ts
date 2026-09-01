/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { TextBlock } from '../message';
import type { PermissionContext, PermissionDecision, PermissionRule } from '../permission';
import { PermissionBehavior, PermissionMode, createPermissionDecision } from '../permission';
import type { AgentState } from '../state';
import type { BackendBase } from './backend';
import { LocalBackend, normalizeNewlines } from './backend';
import { ToolBase } from './base';
import type { ToolMiddlewareBase } from './base';
import { ToolChunk } from './response';
import { createPythonUnifiedDiff, fnmatchPath } from './utils';

export interface EditToolOptions {
    backend?: BackendBase;
    dangerousFiles?: string[];
    dangerousDirectories?: string[];
    middlewares?: ToolMiddlewareBase[];
}

/** Python-compatible exact string replacement tool. */
export class EditTool extends ToolBase {
    readonly name = 'Edit';
    readonly description = `Performs exact string replacements in files.

Usage:
- You must use your Read tool at least once in the conversation before editing.
- Preserve exact indentation and never include the Read line-number prefix.
- ALWAYS prefer editing existing files in the codebase.
- The edit will FAIL if old_string is not unique unless replace_all is true.`;
    readonly inputSchema = z.object({
        file_path: z.string().describe('The absolute path to the file to edit.'),
        old_string: z.string().describe('The exact string to replace.'),
        new_string: z.string().describe('The replacement string.'),
        replace_all: z.boolean().default(false),
    });
    readonly isReadOnly = false;
    readonly isConcurrencySafe = false;
    override isStateInjected = true;
    private readonly backend: BackendBase;

    constructor(options: EditToolOptions = {}) {
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
                message: `Permission required: Edit operation on sensitive file ${filePath}`,
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
                message: `Permission granted for editing ${filePath} (in working directory)`,
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
        return filePath !== '' && fnmatchPath(filePath, ruleContent);
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
        if (!(await this.backend.fileExists(filePath))) {
            return errorChunk(`Error: File not found: ${filePath}`);
        }
        if (parsed.old_string === parsed.new_string) {
            return errorChunk(
                'Error: old_string and new_string are identical. No changes to make.'
            );
        }

        const state = input._agent_state as AgentState | undefined;
        let content: string;
        if (state) {
            const mtime = await this.backend.statMtime(filePath);
            const cached = await state.toolContext.getCache({ filePath, mtime });
            if (!cached) {
                return errorChunk(
                    'Error: To edit a file, you must first read it using the Read tool.'
                );
            }
            content = cached.lines.join('');
        } else {
            try {
                content = normalizeNewlines(
                    (await this.backend.readFile(filePath)).toString('utf8')
                );
            } catch (error) {
                return errorChunk(`Error reading file: ${errorMessage(error)}`);
            }
        }

        const occurrences = countOccurrences(content, parsed.old_string);
        if (occurrences === 0) {
            return errorChunk(`Error: old_string not found in ${filePath}`);
        }
        if (occurrences > 1 && !parsed.replace_all) {
            return errorChunk(
                `Error: old_string appears ${occurrences} times in ${filePath}. ` +
                    'Set replace_all=true to replace all occurrences, or make old_string more specific.'
            );
        }

        const updated = parsed.replace_all
            ? content.split(parsed.old_string).join(parsed.new_string)
            : content.replace(parsed.old_string, parsed.new_string);
        try {
            await this.backend.writeFile(filePath, Buffer.from(updated, 'utf8'));
        } catch (error) {
            return errorChunk(`Error writing file: ${errorMessage(error)}`);
        }
        const replaced = parsed.replace_all ? occurrences : 1;
        const replacementMessage = parsed.replace_all
            ? `all ${occurrences} occurrences`
            : '1 occurrence';
        const diff = createPythonUnifiedDiff(`a/${filePath}`, `b/${filePath}`, content, updated);
        return new ToolChunk({
            content: [
                TextBlock({
                    text: `Successfully replaced ${replacementMessage} in ${filePath}`,
                }),
            ],
            metadata: { diff, file_path: filePath, occurrences: replaced },
        });
    }
}

/**
 * Preserve the existing TypeScript factory API while returning ToolBase.
 * @param options
 */
export function Edit(options: EditToolOptions = {}): EditTool {
    return new EditTool(options);
}

function countOccurrences(value: string, needle: string): number {
    if (needle === '') return value.length + 1;
    return value.split(needle).length - 1;
}

function errorChunk(message: string): ToolChunk {
    return new ToolChunk({ content: [TextBlock({ text: message })], state: 'error' });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
