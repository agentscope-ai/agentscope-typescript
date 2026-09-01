/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import type { ReplyOptions } from '../agent';
import { EventType, type AgentEvent } from '../event';
import { logger } from '../logger';
import { TextBlock, UserMsg, type ContentBlock, type Msg } from '../message';
import { ReplyFinishedReason } from '../type';
import type { PipelineProtocol } from './base';

export const ExecutionReportSchema = z.object({
    report: z
        .string()
        .describe(
            'An achievement report of the given goal. E.g. file paths, entry points, ' +
                'how-to-run, runtime environment, etc. So that a verifier can check if ' +
                'you have achieved the goal.'
        ),
});

export const VerificationResultSchema = z.object({
    result: z
        .enum(['pass', 'fail', 'impossible'])
        .describe(
            "The verification result: 'pass', 'fail', or 'impossible'. 'impossible' " +
                'means the given goal cannot be achieved and the executor should stop trying.'
        ),
    message: z
        .string()
        .describe(
            'If not passed, explain why it failed and what must be fixed. Include exact ' +
                'locations such as file paths and line numbers.'
        ),
});

export type GoalPipelineInput = NonNullable<ReplyOptions['inputs']>;

export interface GoalPipelineAgent {
    readonly state: { replyId: string };
    replyStream(options: ReplyOptions & { yieldFinalMsg: true }): AsyncGenerator<AgentEvent | Msg>;
}

export interface GoalPipelineOptions {
    executor: GoalPipelineAgent;
    verifier: GoalPipelineAgent;
    verifierResetContext?: boolean;
    verifier_reset_context?: boolean;
    maxIters?: number;
    max_iters?: number;
    maxRetries?: number;
    max_retries?: number;
}

/** Run an executor and verifier until the goal passes or cannot continue. */
export class GoalPipeline implements PipelineProtocol {
    readonly executor: GoalPipelineAgent;
    readonly verifier: GoalPipelineAgent;
    readonly verifierResetContext: boolean;
    readonly maxIters: number;
    readonly maxRetries: number;
    private iters = 0;
    private goal: ContentBlock[] | null = null;

    constructor(options: GoalPipelineOptions);
    constructor(
        executor: GoalPipelineAgent,
        verifier: GoalPipelineAgent,
        verifierResetContext?: boolean,
        maxIters?: number,
        maxRetries?: number
    );
    constructor(
        optionsOrExecutor: GoalPipelineOptions | GoalPipelineAgent,
        verifier?: GoalPipelineAgent,
        verifierResetContext = true,
        maxIters = 10,
        maxRetries = 3
    ) {
        const options: GoalPipelineOptions = isOptions(optionsOrExecutor)
            ? optionsOrExecutor
            : {
                  executor: optionsOrExecutor,
                  verifier: requireVerifier(verifier),
                  verifierResetContext,
                  maxIters,
                  maxRetries,
              };
        this.executor = options.executor;
        this.verifier = options.verifier;
        this.verifierResetContext =
            options.verifierResetContext ?? options.verifier_reset_context ?? true;
        this.maxIters = options.maxIters ?? options.max_iters ?? 10;
        this.maxRetries = options.maxRetries ?? options.max_retries ?? 3;
    }

    get verifier_reset_context(): boolean {
        return this.verifierResetContext;
    }

    get max_iters(): number {
        return this.maxIters;
    }

    get max_retries(): number {
        return this.maxRetries;
    }

    replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent | Msg, void>;
    replyStream(inputs: GoalPipelineInput): AsyncGenerator<AgentEvent | Msg, void>;
    async *replyStream(
        optionsOrInputs: ReplyOptions | GoalPipelineInput
    ): AsyncGenerator<AgentEvent | Msg, void> {
        const inputs = normalizeInputs(optionsOrInputs);
        const signal = isReplyOptions(optionsOrInputs) ? optionsOrInputs.signal : undefined;
        let executorInputs: GoalPipelineInput | null = null;
        let verifierInputs: GoalPipelineInput | null = null;

        if (isMessageInput(inputs)) {
            executorInputs = structuredClone(inputs);
            this.iters = 0;
            const hint =
                '<system-reminder>When you finish the goal, you should summarize your output ' +
                '(if any) so that a verifier can check whether you have achieved the goal ' +
                '(e.g., file paths, entry points, how-to-run, runtime environment, etc.).' +
                '</system-reminder>';
            if (Array.isArray(inputs)) {
                this.goal = inputs.flatMap(message => message.content);
                (executorInputs as Msg[]).push(UserMsg({ name: 'system', content: hint }));
            } else {
                this.goal = inputs.content;
                (executorInputs as Msg).content.push(TextBlock({ text: hint }));
            }
        } else if (isContinuationEvent(inputs)) {
            if (inputs.reply_id === this.executor.state.replyId) {
                executorInputs = inputs;
            } else if (inputs.reply_id === this.verifier.state.replyId) {
                verifierInputs = inputs;
            } else {
                throw new Error('Invalid inputs with reply_id: ' + inputs.reply_id + '. ');
            }
        }

        if (isUserInterrupt(inputs)) {
            const parked = verifierInputs ? this.verifier : this.executor;
            yield* parked.replyStream({ inputs, yieldFinalMsg: true, signal });
            return;
        }

        while (true) {
            let breakLoop = false;
            let executionReport: string | null = null;
            if (executorInputs) {
                while (executionReport === null) {
                    for await (const item of this.executor.replyStream({
                        inputs: executorInputs,
                        structuredSchema: ExecutionReportSchema,
                        yieldFinalMsg: true,
                        signal,
                    })) {
                        yield item;
                        if (isParkEvent(item)) {
                            breakLoop = true;
                        } else if (
                            isMessage(item) &&
                            item.finished_reason === ReplyFinishedReason.COMPLETED &&
                            isRecord(item.structured_output) &&
                            typeof item.structured_output.report === 'string'
                        ) {
                            executionReport = item.structured_output.report;
                        }
                    }
                    if (breakLoop) break;
                    if (executionReport === null) {
                        executorInputs = UserMsg({
                            name: 'system',
                            content:
                                '<system-reminder>You have failed to generate valid execution ' +
                                "report. You should call the 'GenerateStructuredOutput' tool " +
                                'with a valid structured output that matches the schema. ',
                        });
                    }
                }
            }
            if (breakLoop) break;

            let finalMessage: Msg | null = null;
            let instruction: GoalPipelineInput =
                verifierInputs ?? this.buildVerificationInstruction(executionReport);
            verifierInputs = null;
            while (finalMessage === null) {
                for await (const item of this.verifier.replyStream({
                    inputs: instruction,
                    structuredSchema: VerificationResultSchema,
                    yieldFinalMsg: true,
                    signal,
                })) {
                    if (isMessage(item) && item.finished_reason === ReplyFinishedReason.COMPLETED) {
                        finalMessage = item;
                    } else if (isParkEvent(item)) {
                        breakLoop = true;
                        yield item;
                    } else {
                        yield item;
                    }
                }

                if (breakLoop) break;
                if (finalMessage === null) continue;
                if (!isRecord(finalMessage.structured_output)) {
                    finalMessage = null;
                    instruction = UserMsg({
                        name: 'system',
                        content:
                            '<system-reminder>You have failed to generate valid verification ' +
                            "result. You should call the 'GenerateStructuredOutput' tool with " +
                            'a valid structured output that matches the schema. Recall the ' +
                            'verification requirements as follows:\n' +
                            String(this.goal) +
                            '</system-reminder>',
                    });
                    continue;
                }
                const result = finalMessage.structured_output.result;
                if (result === 'pass' || result === 'impossible') {
                    if (result === 'impossible') {
                        logger.info(
                            'The verifier judged the goal impossible: %s',
                            String(finalMessage.structured_output.message ?? '')
                        );
                    }
                    breakLoop = true;
                } else {
                    this.iters += 1;
                    if (this.iters >= this.maxIters) {
                        breakLoop = true;
                        break;
                    }
                    executorInputs = UserMsg({
                        name: 'system',
                        content:
                            "<system-reminder>You've failed to pass the verification. Now " +
                            'recorrect your work based on the following feedback:\n' +
                            String(finalMessage.structured_output.message ?? '') +
                            '</system-reminder>',
                    });
                }
            }
            if (breakLoop) break;
        }
    }

    private buildVerificationInstruction(executionReport: string | null): Msg {
        return UserMsg({
            name: 'user',
            content: [
                TextBlock({
                    text:
                        '<system-reminder>Now you should verify the work done by the executor. ' +
                        'The goal is as follows, you should verify whether the executor has ' +
                        'achieved the goal.\n<goal>',
                }),
                ...(this.goal ?? []),
                TextBlock({
                    text:
                        "</goal>\nThe executor's achievement report is as follows:\n<report>" +
                        String(executionReport) +
                        '</report></system-reminder>',
                }),
            ],
        });
    }
}

function normalizeInputs(value: ReplyOptions | GoalPipelineInput): GoalPipelineInput {
    if (isRecord(value) && 'inputs' in value) {
        if (value.inputs == null) throw new Error('GoalPipeline requires inputs.');
        return value.inputs as GoalPipelineInput;
    }
    return value as GoalPipelineInput;
}

function isReplyOptions(value: ReplyOptions | GoalPipelineInput): value is ReplyOptions {
    return isRecord(value) && 'inputs' in value;
}

function isMessageInput(value: GoalPipelineInput): value is Msg | Msg[] {
    return isMessage(value) || (Array.isArray(value) && value.every(isMessage));
}

function isMessage(value: unknown): value is Msg {
    return (
        isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        Array.isArray(value.content)
    );
}

function isContinuationEvent(value: unknown): value is Exclude<GoalPipelineInput, Msg | Msg[]> {
    return isRecord(value) && typeof value.reply_id === 'string' && typeof value.type === 'string';
}

function isUserInterrupt(value: unknown): boolean {
    return isRecord(value) && value.type === EventType.USER_INTERRUPT;
}

function isParkEvent(value: AgentEvent | Msg): value is AgentEvent {
    return (
        !isMessage(value) &&
        (value.type === EventType.REQUIRE_EXTERNAL_EXECUTION ||
            value.type === EventType.REQUIRE_USER_CONFIRM)
    );
}

function isOptions(value: GoalPipelineOptions | GoalPipelineAgent): value is GoalPipelineOptions {
    return 'executor' in value && 'verifier' in value;
}

function requireVerifier(verifier: GoalPipelineAgent | undefined): GoalPipelineAgent {
    if (!verifier) throw new Error('GoalPipeline requires a verifier.');
    return verifier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
