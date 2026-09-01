/* eslint-disable jsdoc/require-jsdoc */

import type { ChatModelBase } from '../model';

/** Structured summary fields used by context compression. */
export interface SummaryOutput {
    task_overview: string;
    current_state: string;
    important_discoveries: string;
    next_steps: string;
    context_to_preserve: string;
}

/** Python-compatible JSON schema for compressed context summaries. */
export const DEFAULT_SUMMARY_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        task_overview: {
            type: 'string',
            description:
                "The user's core request and success criteria.\n" +
                'Any clarifications or constraints they specified',
        },
        current_state: {
            type: 'string',
            description:
                'What has been completed so far.\n' +
                'File created, modified, or analyzed (with paths if relevant).\n' +
                'Key outputs or artifacts produced.',
        },
        important_discoveries: {
            type: 'string',
            description:
                'Technical constraints or requirements uncovered.\n' +
                'Decisions made and their rationale.\n' +
                'Errors encountered and how they were resolved.\n' +
                "What approaches were tried that didn't work (and why)",
        },
        next_steps: {
            type: 'string',
            description:
                'Specific actions needed to complete the task.\n' +
                'Any blockers or open questions to resolve.\n' +
                'Priority order if multiple steps remain',
        },
        context_to_preserve: {
            type: 'string',
            description:
                'User preferences or style requirements.\n' +
                "Domain-specific details that aren't obvious.\n" +
                'Any promises made to the user',
        },
    },
    required: [
        'task_overview',
        'current_state',
        'important_discoveries',
        'next_steps',
        'context_to_preserve',
    ],
};

/** Context compression and media retention configuration. */
export class ContextConfig {
    triggerRatio: number;
    reserveRatio: number;
    contextBufferRatio: number;
    compressionPrompt: string;
    summaryTemplate: string;
    summarySchema: Record<string, unknown>;
    toolResultLimit: number;
    compressionFallbackToTruncation: boolean;
    compressionToolEnabled: boolean;
    maxImageNum: number;

    constructor(options: Partial<ContextConfig> = {}) {
        this.triggerRatio = options.triggerRatio ?? 0.8;
        this.reserveRatio = options.reserveRatio ?? 0.1;
        this.contextBufferRatio = options.contextBufferRatio ?? 0.2;
        this.compressionPrompt =
            options.compressionPrompt ??
            '<system-hint>You have been working on the task described above. Now write a ' +
                'continuation summary that will allow you to resume ' +
                'work efficiently in a future context window where the conversation history ' +
                'will be replaced with this summary. Your summary should be structured, ' +
                'concise, and actionable.\nThe current time is {current_time}.\nThis summary ' +
                'may itself be summarized again later, and the conversation history it ' +
                'refers to will be gone, so every reference must be self-contained — resolve ' +
                'anything that depends on the vanished context into an absolute, ' +
                "fully-qualified form:\n- Time: convert relative expressions ('today', " +
                "'now', 'yesterday', 'tomorrow', 'recently') to absolute dates using the " +
                'current time above; re-anchor them even if an earlier summary already wrote ' +
                'them relatively.\n- Names & pointers: use file paths, symbol names, PR/issue ' +
                'numbers, IDs, URLs, and exact commands/error strings verbatim instead of ' +
                "'this file', 'the above', 'the second approach', 'the 5 failing tests'.\n" +
                '- In-flight work: record everything still pending, especially tools ' +
                'launched in the background whose results you are still waiting on — give ' +
                "each one's id and a short note of what it is doing — and mark each item's " +
                'owner (user request vs your own decision) and status (done / pending / ' +
                'blocked).\n</system-hint>';
        this.summaryTemplate =
            options.summaryTemplate ??
            '<system-info>Here is a summary of your previous work\n' +
                '# Task Overview\n{task_overview}\n\n# Current State\n{current_state}\n\n' +
                '# Important Discoveries\n{important_discoveries}\n\n' +
                '# Next Steps\n{next_steps}\n\n# Context to Preserve\n' +
                '{context_to_preserve}</system-info>';
        this.summarySchema = options.summarySchema ?? structuredClone(DEFAULT_SUMMARY_SCHEMA);
        this.toolResultLimit = options.toolResultLimit ?? 50000;
        this.compressionFallbackToTruncation = options.compressionFallbackToTruncation ?? true;
        this.compressionToolEnabled = options.compressionToolEnabled ?? false;
        this.maxImageNum = options.maxImageNum ?? 5;
        if (!(this.triggerRatio > 0 && this.triggerRatio <= 0.9)) {
            throw new Error('triggerRatio must be greater than 0 and at most 0.9.');
        }
        if (!(this.reserveRatio > 0 && this.reserveRatio < 0.9)) {
            throw new Error('reserveRatio must be greater than 0 and less than 0.9.');
        }
        if (this.contextBufferRatio < 0 || this.contextBufferRatio > 1) {
            throw new Error('contextBufferRatio must be between 0 and 1.');
        }
        if (!Number.isInteger(this.toolResultLimit)) {
            throw new Error('toolResultLimit must be an integer.');
        }
        if (!Number.isInteger(this.maxImageNum) || this.maxImageNum < 0) {
            throw new Error('maxImageNum must be a non-negative integer.');
        }
    }
}

/** Runtime-state injection configuration. */
export class InjectionConfig {
    injectRuntimeState: boolean;
    timezone: string;
    timeFormat: string;
    timeInterval: number;
    /** @deprecated Use ContextConfig.contextBufferRatio. */
    contextBufferRatio: number | null;
    toolRetriesLimit: number;
    toolRetriesHint: string;
    template: string;
    injectionSource: string;
    taskToolNames: string[];
    extraFields: Record<string, string>;
    emitHintEvent: boolean;

    constructor(options: Partial<InjectionConfig> = {}) {
        this.injectRuntimeState = options.injectRuntimeState ?? true;
        this.timezone = options.timezone ?? 'UTC';
        this.timeFormat = options.timeFormat ?? '%Y-%m-%dT%H:%M:%S';
        this.timeInterval = options.timeInterval ?? 0.5;
        this.contextBufferRatio = options.contextBufferRatio ?? null;
        this.toolRetriesLimit = options.toolRetriesLimit ?? 3;
        this.toolRetriesHint =
            options.toolRetriesHint ??
            "The last {count} calls to '{tool_name}' with the same arguments all failed. " +
                'Stop retrying the same call as-is, check the error message and try a ' +
                'different approach.';
        this.template =
            options.template ??
            '<system-reminder>Treat the following as the ground truth at this point of the ' +
                'conversation. Anything stated earlier is outdated, and a later reminder, if ' +
                'any, supersedes this one:\n{runtime_state}\n</system-reminder>';
        this.injectionSource =
            options.injectionSource ?? '{"label": "System", "sublabel": "Runtime State"}';
        this.taskToolNames = options.taskToolNames ?? [
            'TaskCreate',
            'TaskGet',
            'TaskList',
            'TaskUpdate',
        ];
        this.extraFields = options.extraFields ?? {};
        this.emitHintEvent = options.emitHintEvent ?? true;
        if (this.timeInterval < 0) throw new Error('timeInterval must be non-negative.');
        if (
            this.contextBufferRatio !== null &&
            (this.contextBufferRatio < 0 || this.contextBufferRatio > 1)
        ) {
            throw new Error('contextBufferRatio must be between 0 and 1.');
        }
        if (!Number.isInteger(this.toolRetriesLimit) || this.toolRetriesLimit < 3) {
            throw new Error('toolRetriesLimit must be an integer greater than or equal to 3.');
        }
        if (!this.template.includes('{runtime_state}')) {
            throw new Error(
                "The injection template must contain the '{runtime_state}' placeholder, got " +
                    JSON.stringify(this.template) +
                    '.'
            );
        }
    }
}

/** Reasoning-acting loop configuration. */
export class ReActConfig {
    maxIters: number;
    structuredOutputGraceIters: number;
    stopOnReject: boolean;
    interruptionMessage: string;
    interruptionRaiseCancelledError: boolean;

    constructor(options: Partial<ReActConfig> = {}) {
        this.maxIters = options.maxIters ?? 50;
        this.structuredOutputGraceIters = options.structuredOutputGraceIters ?? 5;
        this.stopOnReject = options.stopOnReject ?? false;
        this.interruptionMessage =
            options.interruptionMessage ?? 'I notice the interruption. How can I help you?';
        this.interruptionRaiseCancelledError = options.interruptionRaiseCancelledError ?? false;
        if (!Number.isInteger(this.maxIters)) {
            throw new Error('maxIters must be an integer.');
        }
        if (
            !Number.isInteger(this.structuredOutputGraceIters) ||
            this.structuredOutputGraceIters <= 0
        ) {
            throw new Error('structuredOutputGraceIters must be a positive integer.');
        }
    }
}

/** Agent-level retry and fallback model configuration. */
export class ModelConfig {
    maxRetries: number;
    fallbackModel: ChatModelBase | null;

    constructor(options: Partial<ModelConfig> = {}) {
        this.maxRetries = options.maxRetries ?? 0;
        this.fallbackModel = options.fallbackModel ?? null;
        if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
            throw new Error('maxRetries must be a non-negative integer.');
        }
    }
}
