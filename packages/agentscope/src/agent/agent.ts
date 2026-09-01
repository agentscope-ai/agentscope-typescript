/* eslint-disable jsdoc/require-jsdoc */

import { Validator } from '@cfworker/json-schema';
import { minimatch } from 'minimatch';
import { z } from 'zod';

import { _generateId, _jsonLoadsWithRepair } from '../_utils';
import { ContextConfig, InjectionConfig, ModelConfig, ReActConfig } from './config';
import type { ReplyOptions } from './interfaces';
import { GenerateStructuredOutputTool } from './structured-output-tool';
import { createEvent, EventType } from '../event';
import type {
    AgentEvent,
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
    UserInterruptEvent,
} from '../event';
import {
    AssistantMsg,
    DataBlock,
    HintBlock,
    SystemMsg,
    TextBlock,
    ToolResultBlock,
    createMsg,
    getContentBlocks,
} from '../message';
import type {
    ContentBlock,
    HintBlock as HintBlockType,
    Msg,
    ToolCallBlock,
    ToolCallState,
    ToolResultState,
} from '../message';
import type {
    ActingHookInput,
    ActingStream,
    AgentStream,
    CompressContextHookInput,
    MiddlewareBase,
    ModelCallHookInput,
    ModelResult,
    PermissionHookInput,
    ReasoningHookInput,
    ReplyHookInput,
} from '../middleware/base';
import { ChatResponse, FinishedReason } from '../model';
import type { ChatModelBase, ChatUsage } from '../model';
import { PermissionBehavior, PermissionEngine } from '../permission';
import type { PermissionDecision, PermissionRule } from '../permission';
import { AgentState, ReplyContext } from '../state';
import type { StorageBase } from '../storage';
import { Toolkit, ToolChoice, ToolResponse } from '../tool';
import type { ToolBase, ToolChunk } from '../tool';
import { ReplyFinishedReason } from '../type';
import type { ToolSchema } from '../type';

export interface AgentOffloader {
    offloadContext?(sessionId: string, msgs: Msg[]): Promise<string | undefined>;
    offloadDataBlock?(block: DataBlock): Promise<DataBlock>;
    offloadToolResult?(sessionId: string, result: ToolResultBlock): Promise<string | undefined>;
    getInstructions?(): Promise<string | null>;
}

export interface LegacyCompressionConfig {
    enabled: boolean;
    triggerThreshold: number;
    tokenCountFunc?: (msgs: Msg[]) => number;
    compressionModel?: ChatModelBase;
    compressionPrompt?: string;
    summarySchema?: z.ZodObject;
    keepRecent?: number;
}

export interface AgentOptions {
    name: string;
    systemPrompt?: string;
    /** @deprecated Use systemPrompt. */
    sysPrompt?: string;
    model: ChatModelBase;
    toolkit?: Toolkit;
    middlewares?: MiddlewareBase[];
    state?: AgentState;
    offloader?: AgentOffloader;
    modelConfig?: ModelConfig | Partial<ModelConfig>;
    contextConfig?: ContextConfig | Partial<ContextConfig>;
    reactConfig?: ReActConfig | Partial<ReActConfig>;
    injectionConfig?: InjectionConfig | Partial<InjectionConfig>;
    /** @deprecated Use reactConfig.maxIters. */
    maxIters?: number;
    /** @deprecated State is now explicitly owned by AgentState. */
    storage?: StorageBase;
    /** @deprecated Use contextConfig. */
    compressionConfig?: LegacyCompressionConfig;
}

type AgentInput =
    | Msg
    | Msg[]
    | UserConfirmResultEvent
    | UserInterruptEvent
    | ExternalExecutionResultEvent
    | null;

type NextAction =
    | { type: 'reasoning'; hint?: HintBlockType; toolChoice?: ToolChoice | null }
    | { type: 'acting'; toolCalls: ToolCallBlock[] }
    | { type: 'exit'; message: Msg; events?: AgentEvent[] };

type ToolBatch = { type: 'sequential' | 'concurrent'; toolCalls: ToolCallBlock[] };

/** Unified Python-compatible reasoning-acting agent. */
export class Agent {
    readonly name: string;
    readonly model: ChatModelBase;
    readonly toolkit: Toolkit;
    readonly state: AgentState;
    readonly offloader?: AgentOffloader;
    readonly modelConfig: ModelConfig;
    readonly contextConfig: ContextConfig;
    readonly reactConfig: ReActConfig;
    readonly injectionConfig: InjectionConfig;
    readonly storage?: StorageBase;
    readonly compressionConfig?: LegacyCompressionConfig;
    private readonly systemPromptValue: string;
    private readonly engine: PermissionEngine;
    private readonly replyMiddlewares: MiddlewareBase[];
    private readonly reasoningMiddlewares: MiddlewareBase[];
    private readonly permissionMiddlewares: MiddlewareBase[];
    private readonly actingMiddlewares: MiddlewareBase[];
    private readonly modelCallMiddlewares: MiddlewareBase[];
    private readonly systemPromptMiddlewares: MiddlewareBase[];
    private readonly compressionMiddlewares: MiddlewareBase[];
    private receiveReplyEnd = false;
    private loaded = false;

    constructor(options: AgentOptions) {
        const systemPrompt = options.systemPrompt ?? options.sysPrompt;
        if (systemPrompt === undefined) throw new Error('systemPrompt is required.');
        this.name = options.name;
        this.systemPromptValue = systemPrompt;
        this.model = options.model;
        this.toolkit = options.toolkit ?? new Toolkit();
        this.state = options.state ?? new AgentState();
        this.offloader = options.offloader;
        this.storage = options.storage;
        this.compressionConfig = options.compressionConfig;
        this.modelConfig = asConfig(ModelConfig, options.modelConfig);
        this.contextConfig = asConfig(ContextConfig, options.contextConfig);
        this.reactConfig = asConfig(ReActConfig, options.reactConfig);
        if (options.maxIters !== undefined) this.reactConfig.maxIters = options.maxIters;
        this.injectionConfig = asConfig(InjectionConfig, options.injectionConfig);
        this.validateConfigs();
        this.engine = new PermissionEngine(this.state.permissionContext);
        const middlewares = options.middlewares ?? [];
        this.replyMiddlewares = implemented(middlewares, 'onReply');
        this.reasoningMiddlewares = implemented(middlewares, 'onReasoning');
        this.permissionMiddlewares = implemented(middlewares, 'onCheckPermission');
        this.actingMiddlewares = implemented(middlewares, 'onActing');
        this.modelCallMiddlewares = implemented(middlewares, 'onModelCall');
        this.systemPromptMiddlewares = implemented(middlewares, 'onSystemPrompt');
        this.compressionMiddlewares = implemented(middlewares, 'onCompressContext');
    }

    get context(): Msg[] {
        return this.state.context;
    }

    get replyId(): string {
        return this.state.replyId;
    }

    set replyId(value: string) {
        this.state.replyId = value;
    }

    get curIter(): number {
        return this.state.curIter;
    }

    set curIter(value: number) {
        this.state.curIter = value;
    }

    get sysPrompt(): string {
        return this.systemPromptValue;
    }

    replyStream(
        options?: ReplyOptions & { yieldFinalMsg?: false }
    ): AsyncGenerator<AgentEvent, Msg>;
    replyStream(
        options: ReplyOptions & { yieldFinalMsg: true }
    ): AsyncGenerator<AgentEvent | Msg, Msg>;
    async *replyStream(options: ReplyOptions = {}): AsyncGenerator<AgentEvent | Msg, Msg> {
        await this.loadLegacyState();
        let finalMessage: Msg | null = null;
        try {
            for await (const item of this.replyGenerator(normalizeReplyInput(options))) {
                if (isMsg(item)) {
                    finalMessage = item;
                    if (options.yieldFinalMsg) yield item;
                } else {
                    yield item;
                }
            }
        } finally {
            await this.saveLegacyState();
        }
        if (!finalMessage) throw new Error('Agent did not produce a final message.');
        return finalMessage;
    }

    async reply(options: ReplyOptions = {}): Promise<Msg> {
        const stream = this.replyStream({ ...options, yieldFinalMsg: false });
        while (true) {
            const item = await stream.next();
            if (item.done) return item.value;
        }
    }

    async observe(msgs?: Msg | Msg[] | null): Promise<void> {
        await this.handleIncomingMessages(msgs ?? null);
    }

    async compressContext(
        contextConfig?: ContextConfig | null,
        instructions?: HintBlockType | null
    ): Promise<void> {
        if (this.compressionMiddlewares.length === 0) {
            await this.compressContextImpl(contextConfig, instructions);
            return;
        }
        const execute = async (index: number, input: CompressContextHookInput): Promise<void> => {
            if (index >= this.compressionMiddlewares.length) {
                await this.compressContextImpl(input.contextConfig, input.instructions);
                return;
            }
            await this.compressionMiddlewares[index].onCompressContext(this, input, patch =>
                execute(index + 1, { ...input, ...patch })
            );
        };
        await execute(0, { contextConfig, instructions });
    }

    async toJSON(): Promise<ReturnType<AgentState['toJSON']>> {
        return this.state.toJSON();
    }

    private validateConfigs(): void {
        if (this.contextConfig.reserveRatio >= this.contextConfig.triggerRatio) {
            throw new Error('reserveRatio must be smaller than triggerRatio.');
        }
        if (
            this.injectionConfig.injectRuntimeState &&
            this.injectionConfig.contextBufferRatio >= this.contextConfig.triggerRatio
        ) {
            throw new Error('contextBufferRatio must be smaller than triggerRatio.');
        }
    }

    private async *replyGenerator(input: ReplyHookInput): AgentStream {
        const execute = (index: number, current: ReplyHookInput): AgentStream => {
            if (index >= this.replyMiddlewares.length) return this.replyImpl(current);
            return this.replyMiddlewares[index].onReply(this, current, patch =>
                execute(index + 1, { ...current, ...patch })
            );
        };
        this.receiveReplyEnd = false;
        for await (const item of execute(0, input)) {
            if (!isMsg(item) && item.type === EventType.REPLY_END) this.receiveReplyEnd = true;
            yield item;
        }
    }

    private async *replyImpl(input: ReplyHookInput): AgentStream {
        let endEvent: AgentEvent | null = null;
        try {
            const inputs = (input.inputs ?? null) as AgentInput;
            const event = isContinuationEvent(inputs) ? inputs : null;
            const messages = event ? null : (inputs as Msg | Msg[] | null);
            if (event?.type === EventType.USER_INTERRUPT) {
                if (this.state.hasAwaitingToolCalls({ name: this.name })) {
                    endEvent = this.event({
                        type: EventType.REPLY_END,
                        session_id: this.state.sessionId,
                        reply_id: this.state.replyId,
                        finished_reason: ReplyFinishedReason.INTERRUPTED,
                    });
                }
                return;
            }
            const awaiting = this.checkIncomingEvent(event);
            if (awaiting) {
                yield* this.handleIncomingEvent(event);
            } else {
                await this.handleIncomingMessages(messages);
                this.state.replyContext = new ReplyContext({
                    replyId: _generateId(),
                    curIter: 0,
                    structuredSchema: input.structuredSchema ?? null,
                    structuredOutput: null,
                });
                yield this.event({
                    type: EventType.REPLY_START,
                    session_id: this.state.sessionId,
                    reply_id: this.state.replyId,
                    name: this.name,
                });
            }
            await this.toolkit.removeTool('GenerateStructuredOutput');
            if (this.state.replyContext.structuredSchema) {
                await this.toolkit.addTool(
                    new GenerateStructuredOutputTool(this.state.replyContext.structuredSchema)
                );
            }
            let finalMessage: Msg | null = null;
            let madeProgress = true;
            while (true) {
                input.signal?.throwIfAborted();
                const action = this.nextAction(finalMessage);
                if (action.type === 'exit') {
                    if (!action.events) {
                        yield action.message;
                        return;
                    }
                    for (const item of action.events) yield item;
                    if (this.receiveReplyEnd) {
                        yield action.message;
                        return;
                    }
                    if (!madeProgress) {
                        throw new Error(
                            'A middleware swallowed ReplyEndEvent twice without progress.'
                        );
                    }
                    madeProgress = false;
                    finalMessage = null;
                    continue;
                }
                if (action.type === 'reasoning') {
                    madeProgress = true;
                    finalMessage = null;
                    if (action.hint) {
                        this.state.appendContext({ name: this.name, blocks: [action.hint] });
                    }
                    await this.compressContext();
                    yield* this.injectRuntimeState();
                    let interrupted = false;
                    for await (const item of this.reasoning(action.toolChoice, input.signal)) {
                        if (isMsg(item)) {
                            finalMessage = item;
                            continue;
                        }
                        if (
                            item.type === EventType.MODEL_CALL_END &&
                            item.finished_reason === FinishedReason.INTERRUPTED
                        ) {
                            interrupted = true;
                        }
                        yield item;
                    }
                    if (interrupted) {
                        endEvent = this.interruptedEnd();
                        return;
                    }
                } else {
                    madeProgress = true;
                    for (const batch of await this.batchToolCalls(action.toolCalls)) {
                        const stream =
                            batch.type === 'sequential'
                                ? this.executeSequential(batch.toolCalls)
                                : this.executeConcurrent(batch.toolCalls);
                        let park = false;
                        let interrupted = false;
                        for await (const item of stream) {
                            yield item;
                            park ||=
                                item.type === EventType.REQUIRE_USER_CONFIRM ||
                                item.type === EventType.REQUIRE_EXTERNAL_EXECUTION;
                            interrupted ||=
                                item.type === EventType.TOOL_RESULT_END &&
                                item.state === 'interrupted';
                        }
                        if (interrupted) {
                            endEvent = this.interruptedEnd();
                            return;
                        }
                        if (park) break;
                    }
                }
                if (this.state.getUnfinishedToolCalls({ name: this.name }).length === 0) {
                    this.state.curIter += 1;
                }
            }
        } catch (error) {
            if (!isCancellationError(error)) throw error;
            endEvent = this.interruptedEnd();
            if (this.reactConfig.interruptionRaiseCancelledError) throw error;
        } finally {
            if (endEvent) {
                yield* this.closeUnfinishedToolCalls();
                yield endEvent;
                yield AssistantMsg({
                    id: this.state.replyId,
                    name: this.name,
                    content: this.reactConfig.interruptionMessage,
                    finished_reason: ReplyFinishedReason.INTERRUPTED,
                });
            }
        }
    }

    private checkIncomingEvent(event: AgentEvent | null): boolean {
        const awaiting = this.state.getAwaitingToolCalls({ name: this.name });
        const confirmations = awaiting.filter(call => call.state === 'asking').map(call => call.id);
        const external = awaiting.filter(call => call.state === 'submitted').map(call => call.id);
        if (!event && (confirmations.length || external.length)) {
            throw new Error(
                `Agent is waiting for ${confirmations.length} confirmations and ` +
                    `${external.length} external results, but received no event.`
            );
        }
        if (event?.type === EventType.USER_CONFIRM_RESULT) {
            if (!confirmations.length) throw new Error('Agent is not waiting for confirmation.');
            const extra = event.confirm_results
                .map(result => result.tool_call.id)
                .filter(id => !confirmations.includes(id));
            if (extra.length) throw new Error(`Unexpected confirmation ids: ${extra.join(', ')}.`);
        }
        if (event?.type === EventType.EXTERNAL_EXECUTION_RESULT) {
            if (!external.length) throw new Error('Agent is not waiting for external results.');
            const extra = event.execution_results
                .map(result => result.id)
                .filter(id => !external.includes(id));
            if (extra.length)
                throw new Error(`Unexpected external result ids: ${extra.join(', ')}.`);
        }
        return event !== null;
    }

    private async *handleIncomingEvent(event: AgentEvent | null): AsyncGenerator<AgentEvent> {
        if (!event || !this.state.context.length) return;
        if (event.type === EventType.USER_CONFIRM_RESULT) {
            const results = new Map(
                event.confirm_results.map(value => [value.tool_call.id, value])
            );
            const last = this.state.context.at(-1)!;
            for (const call of getContentBlocks(last, 'tool_call')) {
                const result = results.get(call.id);
                if (!result) continue;
                if (result.confirmed) {
                    this.updateToolCallState(call.id, 'allowed');
                    call.name = result.tool_call.name;
                    call.input = result.tool_call.input;
                    for (const rule of result.rules ?? []) this.engine.addRule(rule);
                } else {
                    yield* this.handleErrorToolCall(
                        call,
                        `<system-reminder>The execution of tool "${call.name}" is denied by user!</system-reminder>`,
                        'denied'
                    );
                }
            }
        } else if (event.type === EventType.EXTERNAL_EXECUTION_RESULT) {
            for (const result of event.execution_results) {
                yield* this.convertToolContentToEvents(result.id, result.output);
                yield this.event({
                    type: EventType.TOOL_RESULT_END,
                    reply_id: this.state.replyId,
                    tool_call_id: result.id,
                    state: result.state,
                    metadata: result.metadata,
                });
                this.saveToContext([result]);
                this.updateToolCallState(result.id, 'finished');
            }
        }
    }

    private async handleIncomingMessages(msgs: Msg | Msg[] | null): Promise<void> {
        if (!msgs) return;
        const copied = structuredClone(Array.isArray(msgs) ? msgs : [msgs]);
        for (const message of copied) {
            if (
                !isMsg(message) ||
                message.role === 'system' ||
                getContentBlocks(message).some(block =>
                    ['tool_call', 'tool_result', 'thinking'].includes(block.type)
                )
            ) {
                throw new Error(
                    'Input messages must have user or assistant role and cannot contain tool ' +
                        'calls, tool results, or thinking blocks.'
                );
            }
            const supported = this.model.formatter?.supportedInputMediaTypes ?? [];
            message.content = await Promise.all(
                message.content.map(async block => {
                    if (
                        block.type !== 'data' ||
                        supported.some(pattern => minimatch(block.source.media_type, pattern))
                    ) {
                        return block;
                    }
                    let url = block.source.type === 'url' ? block.source.url : '';
                    if (!url && this.offloader?.offloadDataBlock) {
                        const saved = await this.offloader.offloadDataBlock(block);
                        if (saved.source.type === 'url') url = saved.source.url;
                    }
                    const name = block.name ? `named '${block.name}' ` : '';
                    return TextBlock({
                        text: url
                            ? `<system-reminder>An attached file ${name}is saved into ${url}.</system-reminder>`
                            : `<system-reminder>An unsupported input file ${name}is attached with media type '${block.source.media_type}'.</system-reminder>`,
                    });
                })
            );
            this.state.context.push(message);
        }
    }

    private nextAction(finalMessage: Msg | null): NextAction {
        const awaiting = this.state.getAwaitingToolCalls({ name: this.name });
        const last = this.getLastMessage();
        if (last) {
            const finished = new Set(
                getContentBlocks(last, 'tool_result').map(result => result.id)
            );
            const executable = getContentBlocks(last, 'tool_call').filter(
                call =>
                    !finished.has(call.id) &&
                    (call.state === 'allowed' ||
                        (call.state === 'pending' && awaiting.length === 0))
            );
            if (executable.length) return { type: 'acting', toolCalls: executable };
        }
        if (awaiting.length) {
            return {
                type: 'exit',
                message: AssistantMsg({
                    id: this.state.replyId,
                    name: this.name,
                    content: "I'm waiting for your permission or the external execution to finish.",
                }),
            };
        }
        const required = this.state.replyContext.structuredSchema !== null;
        const satisfied = this.state.replyContext.structuredOutput !== null;
        if (required && satisfied) {
            return this.completedExit(
                AssistantMsg({
                    id: this.state.replyId,
                    name: this.name,
                    content: 'The required structured output is generated.',
                    finished_reason: ReplyFinishedReason.COMPLETED,
                    structured_output: structuredClone(
                        this.state.replyContext.structuredOutput
                    ) as Msg['structured_output'],
                })
            );
        }
        if (required) {
            if (
                this.state.curIter >=
                this.reactConfig.maxIters + this.reactConfig.structuredOutputGraceIters
            ) {
                return this.exceededExit();
            }
            const forced = this.state.curIter >= this.reactConfig.maxIters;
            return {
                type: 'reasoning',
                hint: HintBlock({
                    hint:
                        "<system-reminder>You're required to generate structured output by " +
                        "calling the 'GenerateStructuredOutput' tool. " +
                        (forced
                            ? 'Call this tool at once to generate the final structured output.'
                            : 'Call it when you are ready to generate the final structured output.') +
                        '</system-reminder>',
                    source: '{"label": "System", "sublabel": "Structured Output Requirement"}',
                }),
                toolChoice: forced ? new ToolChoice({ mode: 'GenerateStructuredOutput' }) : null,
            };
        }
        if (finalMessage) {
            const exceeded = this.state.curIter > this.reactConfig.maxIters;
            const reason = exceeded
                ? ReplyFinishedReason.EXCEED_MAX_ITERS
                : ReplyFinishedReason.COMPLETED;
            finalMessage.finished_reason = reason;
            return {
                type: 'exit',
                events: [
                    ...(exceeded
                        ? [
                              this.event({
                                  type: EventType.EXCEED_MAX_ITERS,
                                  reply_id: this.state.replyId,
                                  name: this.name,
                              }),
                          ]
                        : []),
                    this.event({
                        type: EventType.REPLY_END,
                        session_id: this.state.sessionId,
                        reply_id: this.state.replyId,
                        finished_reason: reason,
                    }),
                ],
                message: finalMessage,
            };
        }
        if (this.state.curIter === this.reactConfig.maxIters) {
            return {
                type: 'reasoning',
                hint: HintBlock({
                    hint:
                        `<system-reminder>You have reached the maximum of ${this.reactConfig.maxIters} ` +
                        'reasoning-acting iterations. Summarize the work and findings so far and ' +
                        'return the final answer as text. Do not call any tools.</system-reminder>',
                    source: '{"label": "System", "sublabel": "Max Iterations Reached"}',
                }),
                toolChoice: new ToolChoice({ mode: 'none' }),
            };
        }
        if (this.state.curIter >= this.reactConfig.maxIters) return this.exceededExit();
        return { type: 'reasoning' };
    }

    private completedExit(message: Msg): NextAction {
        return {
            type: 'exit',
            message,
            events: [
                this.event({
                    type: EventType.REPLY_END,
                    session_id: this.state.sessionId,
                    reply_id: this.state.replyId,
                    finished_reason: ReplyFinishedReason.COMPLETED,
                }),
            ],
        };
    }

    private exceededExit(): NextAction {
        return {
            type: 'exit',
            events: [
                this.event({
                    type: EventType.EXCEED_MAX_ITERS,
                    reply_id: this.state.replyId,
                    name: this.name,
                }),
                this.event({
                    type: EventType.REPLY_END,
                    session_id: this.state.sessionId,
                    reply_id: this.state.replyId,
                    finished_reason: ReplyFinishedReason.EXCEED_MAX_ITERS,
                }),
            ],
            message: AssistantMsg({
                id: this.state.replyId,
                name: this.name,
                content: 'The maximum reasoning-acting iterations are exceeded.',
                finished_reason: ReplyFinishedReason.EXCEED_MAX_ITERS,
            }),
        };
    }

    private interruptedEnd(): AgentEvent {
        return this.event({
            type: EventType.REPLY_END,
            session_id: this.state.sessionId,
            reply_id: this.state.replyId,
            finished_reason: ReplyFinishedReason.INTERRUPTED,
        });
    }

    private async *reasoning(toolChoice?: ToolChoice | null, signal?: AbortSignal): AgentStream {
        const execute = (index: number, input: ReasoningHookInput): AgentStream => {
            if (index >= this.reasoningMiddlewares.length) {
                return this.reasoningImpl(input.toolChoice, input.signal);
            }
            return this.reasoningMiddlewares[index].onReasoning(this, input, patch =>
                execute(index + 1, { ...input, ...patch })
            );
        };
        yield* execute(0, { toolChoice, ...(signal ? { signal } : {}) });
    }

    private async *reasoningImpl(
        toolChoice?: ToolChoice | null,
        signal?: AbortSignal
    ): AgentStream {
        signal?.throwIfAborted();
        yield this.event({
            type: EventType.MODEL_CALL_START,
            reply_id: this.state.replyId,
            model_name: this.model.modelName,
        });
        const modelInput = await this.prepareModelInput();
        const response = await this.callModel({ ...modelInput, toolChoice, signal });
        const ids: StreamIds = { text: null, thinking: null, tools: [], data: [] };
        let completed: ChatResponse | null = null;
        if (isAsyncGenerator(response)) {
            while (true) {
                const item = await response.next();
                if (item.done) {
                    if (item.value) completed = ChatResponse.from(item.value);
                    break;
                }
                const chunk = ChatResponse.from(item.value);
                if (chunk.isLast) completed = chunk;
                else yield* this.convertChatResponseToEvents(ids, chunk);
            }
        } else {
            completed = ChatResponse.from(response);
            yield* this.convertChatResponseToEvents(ids, completed);
        }
        yield* this.closeActiveBlocks(ids);
        if (!completed) throw new Error('Model returned an empty streaming response.');
        const usage = completed.usage;
        yield this.event({
            type: EventType.MODEL_CALL_END,
            reply_id: this.state.replyId,
            input_tokens: usage?.inputTokens ?? 0,
            output_tokens: usage?.outputTokens ?? 0,
            cache_input_tokens: usage?.cacheInputTokens ?? 0,
            cache_creation_input_tokens: usage?.cacheCreationInputTokens ?? 0,
            finished_reason: completed.finishedReason,
        });
        this.saveToContext(completed.content, usage);
        const thinkingOnly =
            completed.content.length > 0 &&
            completed.content.every(block => block.type === 'thinking');
        if (
            completed.finishedReason !== FinishedReason.INTERRUPTED &&
            !completed.content.some(block => block.type === 'tool_call') &&
            !thinkingOnly
        ) {
            yield AssistantMsg({
                id: this.state.replyId,
                name: this.name,
                content: [...completed.content],
                usage: this.getLastMessage()?.usage,
                finished_reason: ReplyFinishedReason.COMPLETED,
            });
        }
    }

    private async callModel(input: {
        messages: Msg[];
        tools: ToolSchema[];
        toolChoice?: ToolChoice | null;
        signal?: AbortSignal;
    }): Promise<ModelResult> {
        const models = [
            this.model,
            ...(this.modelConfig.fallbackModel ? [this.modelConfig.fallbackModel] : []),
        ];
        let lastError: unknown;
        for (const model of models) {
            for (let attempt = 0; attempt <= this.modelConfig.maxRetries; attempt++) {
                try {
                    const execute = async (
                        index: number,
                        current: ModelCallHookInput
                    ): Promise<ModelResult> => {
                        if (index >= this.modelCallMiddlewares.length) {
                            return current.currentModel.call({
                                messages: current.messages,
                                tools: current.tools,
                                toolChoice: current.toolChoice ?? undefined,
                                ...(current.signal ? { signal: current.signal } : {}),
                            });
                        }
                        return this.modelCallMiddlewares[index].onModelCall(this, current, patch =>
                            execute(index + 1, { ...current, ...patch })
                        );
                    };
                    return await execute(0, {
                        currentModel: model,
                        messages: input.messages,
                        tools: input.tools,
                        toolChoice: input.toolChoice,
                        ...(input.signal ? { signal: input.signal } : {}),
                    });
                } catch (error) {
                    lastError = error;
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async batchToolCalls(toolCalls: ToolCallBlock[]): Promise<ToolBatch[]> {
        const batches: ToolBatch[] = [];
        for (const call of toolCalls) {
            const tool = await this.toolkit.getTool(call.name);
            const type = !tool || tool.isConcurrencySafe ? 'concurrent' : 'sequential';
            const previous = batches.at(-1);
            if (previous?.type === type) previous.toolCalls.push(call);
            else batches.push({ type, toolCalls: [call] });
        }
        return batches;
    }

    private async *executeSequential(toolCalls: ToolCallBlock[]): AsyncGenerator<AgentEvent> {
        for (const call of toolCalls) {
            let stop = false;
            for await (const item of this.executeToolCall(call)) {
                yield item;
                stop ||=
                    item.type === EventType.REQUIRE_USER_CONFIRM ||
                    item.type === EventType.REQUIRE_EXTERNAL_EXECUTION ||
                    (item.type === EventType.TOOL_RESULT_END && item.state === 'interrupted');
            }
            if (stop) break;
        }
    }

    private async *executeConcurrent(toolCalls: ToolCallBlock[]): AsyncGenerator<AgentEvent> {
        const queue = new AsyncQueue<AgentEvent>();
        const rules: PermissionRule[] = [];
        const workers = toolCalls.map(async call => {
            for await (const item of this.executeToolCall(call, rules)) queue.push(item);
        });
        void Promise.allSettled(workers).then(results => queue.close(results));
        for await (const item of queue) yield item;
        const failures = queue.results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'One or more tool calls failed');
    }

    private async *executeToolCall(
        toolCall: ToolCallBlock,
        keptRules?: PermissionRule[]
    ): AsyncGenerator<AgentEvent> {
        let tool: ToolBase;
        let parsed: Record<string, unknown>;
        try {
            tool = await this.toolkit.checkToolAvailable(
                toolCall.name,
                this.state.toolContext.activatedGroups
            );
            parsed = _jsonLoadsWithRepair(toolCall.input) as Record<string, unknown>;
            if (tool.inputSchema instanceof z.ZodType) parsed = tool.inputSchema.parse(parsed);
            else {
                const validation = new Validator(tool.inputSchema).validate(parsed);
                if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
            }
        } catch (error) {
            yield* this.handleErrorToolCall(
                toolCall,
                error instanceof Error ? error.message : String(error),
                'error'
            );
            return;
        }
        const decision = await this.checkPermission(toolCall, tool, parsed);
        if (
            decision.behavior === PermissionBehavior.ASK ||
            decision.behavior === PermissionBehavior.PASSTHROUGH
        ) {
            if (keptRules && !decision.bypass_immune) {
                for (const rule of keptRules) {
                    if (
                        rule.tool_name === tool.name &&
                        rule.rule_content !== null &&
                        (await tool.matchRule(rule.rule_content, parsed))
                    ) {
                        return;
                    }
                }
            }
            keptRules?.push(...(decision.suggested_rules ?? []));
            this.updateToolCallState(toolCall.id, 'asking');
            toolCall.suggested_rules = decision.suggested_rules ?? [];
            yield this.event({
                type: EventType.REQUIRE_USER_CONFIRM,
                reply_id: this.state.replyId,
                tool_calls: [toolCall],
            });
            return;
        }
        if (decision.behavior === PermissionBehavior.DENY) {
            yield* this.handleErrorToolCall(toolCall, decision.message, 'denied');
            return;
        }
        if (decision.behavior !== PermissionBehavior.ALLOW) {
            throw new Error(`Invalid permission behavior: ${decision.behavior}.`);
        }
        this.updateToolCallState(toolCall.id, 'allowed');
        yield this.event({
            type: EventType.TOOL_RESULT_START,
            reply_id: this.state.replyId,
            tool_call_id: toolCall.id,
            tool_call_name: toolCall.name,
        });
        if (tool.isExternalTool) {
            this.updateToolCallState(toolCall.id, 'submitted');
            yield this.event({
                type: EventType.REQUIRE_EXTERNAL_EXECUTION,
                reply_id: this.state.replyId,
                tool_calls: [toolCall],
            });
            return;
        }
        for await (const chunk of this.acting(toolCall)) {
            if (chunk instanceof ToolResponse) {
                const result = ToolResultBlock({
                    id: toolCall.id,
                    name: toolCall.name,
                    output: chunk.content,
                    state: chunk.state,
                    metadata: chunk.metadata,
                });
                const [reserved, offloaded] = await this.splitToolResult(result);
                if (offloaded) await this.attachOffloadReminder(reserved, offloaded);
                this.saveToContext([reserved]);
                this.updateToolCallState(toolCall.id, 'finished');
                yield this.event({
                    type: EventType.TOOL_RESULT_END,
                    reply_id: this.state.replyId,
                    tool_call_id: toolCall.id,
                    state: chunk.state,
                    metadata: chunk.metadata,
                });
            } else {
                yield* this.convertToolContentToEvents(toolCall.id, chunk.content);
            }
        }
    }

    private async checkPermission(
        toolCall: ToolCallBlock,
        tool: ToolBase,
        toolInput: Record<string, unknown>
    ): Promise<PermissionDecision> {
        const execute = async (
            index: number,
            input: PermissionHookInput
        ): Promise<PermissionDecision> => {
            if (index >= this.permissionMiddlewares.length) {
                if (input.toolCall.state === 'allowed') {
                    return {
                        behavior: PermissionBehavior.ALLOW,
                        message: 'Already allowed by user confirmation.',
                    };
                }
                return this.engine.checkPermission(input.tool, input.toolInput);
            }
            return this.permissionMiddlewares[index].onCheckPermission(
                this,
                clonePermissionInput(input),
                patch => execute(index + 1, { ...input, ...patch })
            );
        };
        return execute(0, { toolCall, tool, toolInput });
    }

    private async *acting(toolCall: ToolCallBlock): AsyncGenerator<ToolChunk | ToolResponse> {
        const execute = (index: number, input: ActingHookInput): ActingStream => {
            if (index >= this.actingMiddlewares.length) return this.actingImpl(input.toolCall);
            return this.actingMiddlewares[index].onActing(this, input, patch =>
                execute(index + 1, { ...input, ...patch })
            );
        };
        yield* execute(0, { toolCall });
    }

    private async *actingImpl(toolCall: ToolCallBlock): AsyncGenerator<ToolChunk | ToolResponse> {
        yield* this.toolkit.callTool(toolCall, this.state);
    }

    private async *handleErrorToolCall(
        toolCall: ToolCallBlock,
        message: string,
        state: ToolResultState
    ): AsyncGenerator<AgentEvent> {
        yield this.event({
            type: EventType.TOOL_RESULT_START,
            reply_id: this.state.replyId,
            tool_call_id: toolCall.id,
            tool_call_name: toolCall.name,
        });
        this.saveToContext([
            ToolResultBlock({ id: toolCall.id, name: toolCall.name, output: message, state }),
        ]);
        yield* this.convertToolContentToEvents(toolCall.id, message);
        yield this.event({
            type: EventType.TOOL_RESULT_END,
            reply_id: this.state.replyId,
            tool_call_id: toolCall.id,
            state,
        });
        this.updateToolCallState(toolCall.id, 'finished');
    }

    private async *closeUnfinishedToolCalls(): AsyncGenerator<AgentEvent> {
        const last = this.getLastMessage();
        if (!last) return;
        const results = new Set(getContentBlocks(last, 'tool_result').map(result => result.id));
        for (const call of getContentBlocks(last, 'tool_call')) {
            if (results.has(call.id)) continue;
            const message =
                '<system-reminder>The tool call has been interrupted by the user.</system-reminder>';
            if (call.state !== 'allowed' && call.state !== 'submitted') {
                yield this.event({
                    type: EventType.TOOL_RESULT_START,
                    reply_id: this.state.replyId,
                    tool_call_id: call.id,
                    tool_call_name: call.name,
                });
            }
            call.state = 'finished';
            yield this.event({
                type: EventType.TOOL_RESULT_TEXT_DELTA,
                reply_id: this.state.replyId,
                tool_call_id: call.id,
                delta: message,
            });
            yield this.event({
                type: EventType.TOOL_RESULT_END,
                reply_id: this.state.replyId,
                tool_call_id: call.id,
                state: 'interrupted',
            });
            last.content.push(
                ToolResultBlock({
                    id: call.id,
                    name: call.name,
                    output: message,
                    state: 'interrupted',
                })
            );
        }
    }

    private async *injectRuntimeState(): AsyncGenerator<AgentEvent> {
        const config = this.injectionConfig;
        if (!config.injectRuntimeState) return;
        const injections: Record<string, string> = {};
        const timezone = safeTimezone(config.timezone);
        const now = new Intl.DateTimeFormat('sv-SE', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        })
            .format(new Date())
            .replace(' ', 'T');
        let lastTime: string | null = null;
        let awareOfTasks = false;
        const taskStatus = { pending: 0, inProgress: 0 };
        for (const task of this.state.tasksContext.tasks) {
            if (task.state === 'pending') taskStatus.pending += 1;
            if (task.state === 'in_progress') taskStatus.inProgress += 1;
        }
        for (const message of [...this.state.context].reverse()) {
            if (message.role !== 'assistant') continue;
            for (const block of [...message.content].reverse()) {
                if (block.type === 'hint' && block.source === config.injectionSource) {
                    const text =
                        typeof block.hint === 'string'
                            ? block.hint
                            : block.hint
                                  .filter(value => value.type === 'text')
                                  .map(value => (value.type === 'text' ? value.text : ''))
                                  .join('');
                    lastTime ??= /<current-time>(.*?)<\/current-time>/.exec(text)?.[1] ?? null;
                    awareOfTasks ||= text.includes('<tasks>');
                } else if (
                    block.type === 'tool_call' &&
                    config.taskToolNames.includes(block.name)
                ) {
                    awareOfTasks = true;
                }
            }
        }
        if (!lastTime || elapsedHours(lastTime) > config.timeInterval) {
            injections['current-time'] = formatPythonTime(now, config.timeFormat);
            injections.timezone = config.timezone;
        }
        if ((taskStatus.pending || taskStatus.inProgress) && !awareOfTasks) {
            injections.tasks =
                `You have ${taskStatus.inProgress} in-progress tasks and ` +
                `${taskStatus.pending} pending tasks. Use \`TaskList\` to view them if you don't know.`;
        }
        if (this.state.curIter === 0) {
            const input = await this.prepareModelInput();
            const tokens = await this.model.countTokens(input);
            const threshold = Math.floor(this.contextConfig.triggerRatio * this.model.contextSize);
            if (
                tokens >
                Math.max(0, this.contextConfig.triggerRatio - config.contextBufferRatio) *
                    this.model.contextSize
            ) {
                injections['context-length'] =
                    `Your current context contains ${tokens} tokens. When reaching ${threshold} ` +
                    'tokens, your context will be compressed.';
            }
        }
        const repeated = this.getRepeatedToolError();
        if (repeated) {
            injections['tool-error'] = config.toolRetriesHint
                .replaceAll('{tool_name}', repeated.name)
                .replaceAll('{count}', `${repeated.count}`);
        }
        if (!Object.keys(injections).length) return;
        Object.assign(injections, config.extraFields);
        const hint = HintBlock({
            source: config.injectionSource,
            hint: config.template.replace(
                '{runtime_state}',
                Object.entries(injections)
                    .map(([key, value]) => `<${key}>${value}</${key}>`)
                    .join('\n')
            ),
        });
        this.state.appendContext({ name: this.name, blocks: [hint] });
        if (config.emitHintEvent) {
            yield this.event({
                type: EventType.HINT_BLOCK,
                reply_id: this.state.replyId,
                block_id: hint.id,
                source: hint.source,
                hint: hint.hint,
            });
        }
    }

    private getRepeatedToolError(): { name: string; count: number } | null {
        const last = this.getLastMessage();
        if (!last) return null;
        const results = getContentBlocks(last, 'tool_result');
        if (results.at(-1)?.state !== 'error') return null;
        const name = results.at(-1)!.name;
        const streak: string[] = [];
        for (const result of [...results].reverse()) {
            if (result.state !== 'error' || result.name !== name) break;
            streak.push(result.id);
        }
        if (streak.length < this.injectionConfig.toolRetriesLimit) return null;
        const inputs = new Map(
            getContentBlocks(last, 'tool_call').map(call => [call.id, call.input])
        );
        const normalized = streak.map(id => normalizeJSON(inputs.get(id) ?? ''));
        let count = 0;
        for (const value of normalized) {
            if (value !== normalized[0]) break;
            count += 1;
        }
        return count >= this.injectionConfig.toolRetriesLimit ? { name, count } : null;
    }

    private async compressContextImpl(
        configValue?: ContextConfig | null,
        instructions?: HintBlockType | null
    ): Promise<void> {
        if (this.compressionConfig && !this.compressionConfig.enabled) return;
        const config = configValue ?? this.contextConfig;
        await this.limitContextImages(config);
        const input = await this.prepareModelInput();
        const tokens = this.compressionConfig?.tokenCountFunc
            ? this.compressionConfig.tokenCountFunc(this.state.context)
            : await this.model.countTokens(input);
        const threshold =
            this.compressionConfig?.triggerThreshold ??
            config.triggerRatio * this.model.contextSize;
        if (tokens < threshold) return;
        if (!this.state.context.length) {
            throw new Error('The system prompt and summary exceed the compression threshold.');
        }
        const split =
            this.compressionConfig?.keepRecent !== undefined
                ? Math.max(0, this.state.context.length - this.compressionConfig.keepRecent)
                : await this.findCompressionBoundary(config, input.tools);
        const toCompress = structuredClone(this.state.context.slice(0, split));
        const reserved = structuredClone(this.state.context.slice(split));
        if (!toCompress.length) return;
        const model = this.compressionConfig?.compressionModel ?? this.model;
        const messages: Msg[] = [
            SystemMsg({ name: 'system', content: await this.getSystemPrompt() }),
        ];
        if (this.state.summary) {
            messages.push(createMsg({ name: 'user', role: 'user', content: this.state.summary }));
        }
        messages.push(...toCompress);
        if (instructions) {
            messages.push(AssistantMsg({ name: this.name, content: [instructions] }));
        }
        messages.push(
            createMsg({
                name: 'user',
                role: 'user',
                content: this.compressionConfig?.compressionPrompt ?? config.compressionPrompt,
            })
        );
        let summary: string;
        try {
            const response = await model.generateStructuredOutput({
                messages,
                schema: this.compressionConfig?.summarySchema ?? config.summarySchema,
            });
            summary = interpolate(config.summaryTemplate, response.content);
        } catch {
            summary =
                typeof this.state.summary === 'string' && this.state.summary
                    ? this.state.summary
                    : '<system-info>Some earlier messages were truncated for limited context.</system-info>';
        }
        if (this.offloader?.offloadContext) {
            const path = await this.offloader.offloadContext(this.state.sessionId, toCompress);
            if (path) {
                summary +=
                    `\n<system-reminder>The compressed context is offloaded to '${path}', ` +
                    'you can refer to it when needed.</system-reminder>';
            }
        }
        this.state.summary = summary;
        this.state.context = reserved;
    }

    private async findCompressionBoundary(
        config: ContextConfig,
        tools: ToolSchema[]
    ): Promise<number> {
        const limit = config.reserveRatio * this.model.contextSize;
        for (let index = this.state.context.length - 1; index >= 0; index--) {
            const messages = [
                SystemMsg({ name: 'system', content: await this.getSystemPrompt() }),
                ...this.state.context.slice(index),
            ];
            if ((await this.model.countTokens({ messages, tools })) >= limit) return index;
        }
        return 0;
    }

    private async limitContextImages(config: ContextConfig): Promise<void> {
        const images: ImageLocation[] = [];
        for (const message of this.state.context) {
            message.content.forEach((block, index) => {
                if (isImage(block)) {
                    images.push({
                        container: message.content,
                        index,
                        block,
                        top: true,
                        role: message.role,
                    });
                } else if (
                    (block.type === 'tool_result' && Array.isArray(block.output)) ||
                    (block.type === 'hint' && Array.isArray(block.hint))
                ) {
                    const container = (
                        block.type === 'tool_result' ? block.output : block.hint
                    ) as Array<ReturnType<typeof TextBlock> | DataBlock>;
                    container.forEach((nested, nestedIndex) => {
                        if (isImage(nested)) {
                            images.push({
                                container: container as ContentBlock[],
                                index: nestedIndex,
                                block: nested,
                                top: false,
                                role: message.role,
                            });
                        }
                    });
                }
            });
        }
        const remove = Math.max(0, images.length - config.maxImageNum);
        for (const image of images.slice(0, remove)) {
            let url = image.block.source.type === 'url' ? image.block.source.url : '';
            if (!url && this.offloader?.offloadDataBlock) {
                const saved = await this.offloader.offloadDataBlock(image.block);
                if (saved.source.type === 'url') url = saved.source.url;
            }
            const text = url
                ? `<system-reminder>The image is offloaded into ${url}, you can refer to it when needed.</system-reminder>`
                : '<system-reminder>The image is removed to free up context space.</system-reminder>';
            image.container[image.index] =
                image.top && image.role !== 'user'
                    ? HintBlock({ hint: text })
                    : TextBlock({ text });
        }
    }

    private async splitToolResult(
        result: ToolResultBlock
    ): Promise<[ToolResultBlock, ToolResultBlock | null]> {
        const output =
            typeof result.output === 'string'
                ? [TextBlock({ text: result.output })]
                : result.output;
        const tokens = await this.model.countTokens({
            messages: [AssistantMsg({ name: this.name, content: output })],
        });
        if (tokens <= this.contextConfig.toolResultLimit) return [result, null];
        const ratio = Math.max(0, Math.min(1, this.contextConfig.toolResultLimit / tokens));
        const textLength = output.reduce(
            (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
            0
        );
        let budget = Math.floor(textLength * ratio);
        const reserved: Array<ReturnType<typeof TextBlock> | DataBlock> = [];
        const offloaded: Array<ReturnType<typeof TextBlock> | DataBlock> = [];
        for (const block of output) {
            if (block.type !== 'text') {
                (budget > 0 ? reserved : offloaded).push(structuredClone(block));
                continue;
            }
            const keep = Math.min(budget, block.text.length);
            if (keep) reserved.push(TextBlock({ id: block.id, text: block.text.slice(0, keep) }));
            if (keep < block.text.length) {
                offloaded.push(TextBlock({ id: block.id, text: block.text.slice(keep) }));
            }
            budget -= keep;
        }
        return [
            ToolResultBlock({ ...result, output: reserved }),
            offloaded.length ? ToolResultBlock({ ...result, output: offloaded }) : null,
        ];
    }

    private async attachOffloadReminder(
        reserved: ToolResultBlock,
        offloaded: ToolResultBlock
    ): Promise<void> {
        let reminder =
            '\n<<<TRUNCATED>>>\n<system-reminder>The remaining content has been omitted ' +
            'for limited context.';
        if (this.offloader?.offloadToolResult) {
            const path = await this.offloader.offloadToolResult(this.state.sessionId, offloaded);
            if (path) reminder += ` You can refer to '${path}' for the omitted content.`;
        }
        reminder += '</system-reminder>';
        if (typeof reserved.output === 'string') reserved.output += reminder;
        else reserved.output.push(TextBlock({ text: reminder }));
    }

    private async prepareModelInput(): Promise<{ messages: Msg[]; tools: ToolSchema[] }> {
        const messages = [SystemMsg({ name: 'system', content: await this.getSystemPrompt() })];
        if (this.state.summary) {
            messages.push(createMsg({ name: 'user', role: 'user', content: this.state.summary }));
        }
        messages.push(...this.state.context);
        return {
            messages,
            tools: await this.toolkit.getToolSchemas({
                groups: this.state.toolContext.activatedGroups,
            }),
        };
    }

    private async getSystemPrompt(): Promise<string> {
        const sections = [this.systemPromptValue];
        const skills = await this.toolkit.getSkillInstructions({
            activatedGroups: this.state.toolContext.activatedGroups,
        });
        if (skills) sections.push(skills);
        const offloader = await this.offloader?.getInstructions?.();
        if (offloader) sections.push(offloader);
        let prompt = sections.join('\n');
        for (const middleware of this.systemPromptMiddlewares) {
            prompt = await middleware.onSystemPrompt(this, prompt);
        }
        return prompt;
    }

    private saveToContext(blocks: ContentBlock[], usage?: ChatUsage | null): void {
        const persisted = blocks.filter(
            block => !(block.type === 'data' && block.source.media_type.startsWith('audio/'))
        );
        if (!persisted.length && !usage) return;
        this.state.appendContext({ name: this.name, blocks: persisted });
        const last = this.state.context.at(-1)!;
        if (usage) {
            last.usage ??= {
                input_tokens: 0,
                output_tokens: 0,
                cache_input_tokens: 0,
                cache_creation_input_tokens: 0,
            };
            last.usage.input_tokens += usage.inputTokens;
            last.usage.output_tokens += usage.outputTokens;
            last.usage.cache_input_tokens += usage.cacheInputTokens ?? 0;
            last.usage.cache_creation_input_tokens += usage.cacheCreationInputTokens ?? 0;
        }
    }

    private getLastMessage(): Msg | null {
        const last = this.state.context.at(-1);
        return last?.role === 'assistant' && last.name === this.name ? last : null;
    }

    private updateToolCallState(id: string, state: ToolCallState): void {
        const last = this.getLastMessage();
        if (!last) return;
        const call = getContentBlocks(last, 'tool_call').find(value => value.id === id);
        if (call) call.state = state;
    }

    private async *convertChatResponseToEvents(
        ids: StreamIds,
        chunk: ChatResponse
    ): AsyncGenerator<AgentEvent> {
        const thinking = chunk.content.filter(block => block.type === 'thinking');
        const text = chunk.content.filter(block => block.type === 'text');
        const tools = chunk.content.filter(block => block.type === 'tool_call');
        const data = chunk.content.filter(block => block.type === 'data');
        if (thinking.length) {
            if (!ids.thinking) {
                ids.thinking = _generateId();
                yield this.event({
                    type: EventType.THINKING_BLOCK_START,
                    reply_id: this.state.replyId,
                    block_id: ids.thinking,
                });
            }
            yield this.event({
                type: EventType.THINKING_BLOCK_DELTA,
                reply_id: this.state.replyId,
                block_id: ids.thinking,
                delta: thinking.map(block => block.thinking).join(''),
            });
        } else if (ids.thinking && !data.length) {
            yield this.event({
                type: EventType.THINKING_BLOCK_END,
                reply_id: this.state.replyId,
                block_id: ids.thinking,
            });
            ids.thinking = null;
        }
        if (text.length) {
            if (!ids.text) {
                ids.text = _generateId();
                yield this.event({
                    type: EventType.TEXT_BLOCK_START,
                    reply_id: this.state.replyId,
                    block_id: ids.text,
                });
            }
            yield this.event({
                type: EventType.TEXT_BLOCK_DELTA,
                reply_id: this.state.replyId,
                block_id: ids.text,
                delta: text.map(block => block.text).join(''),
            });
        } else if (ids.text && !data.length) {
            yield this.event({
                type: EventType.TEXT_BLOCK_END,
                reply_id: this.state.replyId,
                block_id: ids.text,
            });
            ids.text = null;
        }
        for (const call of tools) {
            if (!ids.tools.includes(call.id)) {
                ids.tools.push(call.id);
                yield this.event({
                    type: EventType.TOOL_CALL_START,
                    reply_id: this.state.replyId,
                    tool_call_id: call.id,
                    tool_call_name: call.name,
                });
            }
            yield this.event({
                type: EventType.TOOL_CALL_DELTA,
                reply_id: this.state.replyId,
                tool_call_id: call.id,
                delta: call.input,
            });
        }
        for (const id of ids.tools.filter(id => !tools.some(call => call.id === id))) {
            yield this.event({
                type: EventType.TOOL_CALL_END,
                reply_id: this.state.replyId,
                tool_call_id: id,
            });
            ids.tools.splice(ids.tools.indexOf(id), 1);
        }
        for (const block of data) {
            if (block.source.type !== 'base64') continue;
            if (!ids.data.includes(block.id)) {
                ids.data.push(block.id);
                yield this.event({
                    type: EventType.DATA_BLOCK_START,
                    reply_id: this.state.replyId,
                    block_id: block.id,
                    media_type: block.source.media_type,
                });
            }
            yield this.event({
                type: EventType.DATA_BLOCK_DELTA,
                reply_id: this.state.replyId,
                block_id: block.id,
                data: block.source.data,
                media_type: block.source.media_type,
            });
        }
    }

    private async *closeActiveBlocks(ids: StreamIds): AsyncGenerator<AgentEvent> {
        if (ids.text) {
            yield this.event({
                type: EventType.TEXT_BLOCK_END,
                reply_id: this.state.replyId,
                block_id: ids.text,
            });
        }
        if (ids.thinking) {
            yield this.event({
                type: EventType.THINKING_BLOCK_END,
                reply_id: this.state.replyId,
                block_id: ids.thinking,
            });
        }
        for (const id of ids.tools) {
            yield this.event({
                type: EventType.TOOL_CALL_END,
                reply_id: this.state.replyId,
                tool_call_id: id,
            });
        }
        for (const id of ids.data) {
            yield this.event({
                type: EventType.DATA_BLOCK_END,
                reply_id: this.state.replyId,
                block_id: id,
            });
        }
    }

    private async *convertToolContentToEvents(
        toolCallId: string,
        output: string | Array<ReturnType<typeof TextBlock> | DataBlock>
    ): AsyncGenerator<AgentEvent> {
        if (typeof output === 'string') {
            yield this.event({
                type: EventType.TOOL_RESULT_TEXT_DELTA,
                reply_id: this.state.replyId,
                tool_call_id: toolCallId,
                delta: output,
            });
            return;
        }
        for (const block of output) {
            if (block.type === 'text') {
                yield this.event({
                    type: EventType.TOOL_RESULT_TEXT_DELTA,
                    reply_id: this.state.replyId,
                    tool_call_id: toolCallId,
                    delta: block.text,
                });
            } else if (block.source.type === 'base64') {
                yield this.event({
                    type: EventType.TOOL_RESULT_DATA_DELTA,
                    reply_id: this.state.replyId,
                    tool_call_id: toolCallId,
                    media_type: block.source.media_type,
                    data: block.source.data,
                });
            } else {
                yield this.event({
                    type: EventType.TOOL_RESULT_DATA_DELTA,
                    reply_id: this.state.replyId,
                    tool_call_id: toolCallId,
                    media_type: block.source.media_type,
                    url: block.source.url,
                });
            }
        }
    }

    private event(input: Parameters<typeof createEvent>[0]): AgentEvent {
        return createEvent(input);
    }

    private async loadLegacyState(): Promise<void> {
        if (this.loaded || !this.storage) return;
        const loaded = await this.storage.loadAgentState({ agentId: this.name });
        this.state.context = loaded.context;
        this.state.replyId =
            typeof loaded.metadata.replyId === 'string'
                ? loaded.metadata.replyId
                : this.state.replyId;
        this.state.curIter =
            typeof loaded.metadata.curIter === 'number'
                ? loaded.metadata.curIter
                : this.state.curIter;
        this.state.summary =
            typeof loaded.metadata.curSummary === 'string'
                ? loaded.metadata.curSummary
                : this.state.summary;
        this.loaded = true;
    }

    private async saveLegacyState(): Promise<void> {
        if (!this.storage) return;
        await this.storage.saveAgentState({
            agentId: this.name,
            context: this.state.context,
            metadata: {
                replyId: this.state.replyId,
                curIter: this.state.curIter,
                curSummary: this.state.summary,
            },
        });
    }
}

interface StreamIds {
    text: string | null;
    thinking: string | null;
    tools: string[];
    data: string[];
}

interface ImageLocation {
    container: ContentBlock[];
    index: number;
    block: DataBlock;
    top: boolean;
    role: Msg['role'];
}

class AsyncQueue<T> implements AsyncIterable<T> {
    private values: T[] = [];
    private waiters: Array<(value: IteratorResult<T>) => void> = [];
    private closed = false;
    results: PromiseSettledResult<void>[] = [];

    push(value: T): void {
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value, done: false });
        else this.values.push(value);
    }

    close(results: PromiseSettledResult<void>[]): void {
        this.results = results;
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                const value = this.values.shift();
                if (value !== undefined) return Promise.resolve({ value, done: false });
                if (this.closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise(resolve => this.waiters.push(resolve));
            },
        };
    }
}

function normalizeReplyInput(options: ReplyOptions): ReplyHookInput {
    return {
        inputs: options.inputs ?? options.event ?? options.msgs ?? null,
        structuredSchema: options.structuredSchema ?? options.structuredModel ?? null,
        ...(options.signal ? { signal: options.signal } : {}),
    };
}

function isMsg(value: AgentEvent | Msg): value is Msg {
    return 'role' in value && 'content' in value;
}

function isContinuationEvent(
    value: AgentInput
): value is UserConfirmResultEvent | UserInterruptEvent | ExternalExecutionResultEvent {
    return (
        !!value &&
        !Array.isArray(value) &&
        'type' in value &&
        [
            EventType.USER_CONFIRM_RESULT,
            EventType.USER_INTERRUPT,
            EventType.EXTERNAL_EXECUTION_RESULT,
        ].includes(value.type as EventType)
    );
}

function isAsyncGenerator(
    value: unknown
): value is AsyncGenerator<ChatResponse, ChatResponse | void> {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'next') === 'function'
    );
}

function implemented(middlewares: MiddlewareBase[], hook: keyof MiddlewareBase): MiddlewareBase[] {
    return middlewares.filter(middleware => middleware.isImplemented(hook));
}

function asConfig<T>(constructor: new (options?: Partial<T>) => T, value?: T | Partial<T>): T {
    return value instanceof constructor ? value : new constructor(value);
}

function clonePermissionInput(input: PermissionHookInput): PermissionHookInput {
    return {
        toolCall: structuredClone(input.toolCall),
        tool: input.tool,
        toolInput: structuredClone(input.toolInput),
    };
}

function isCancellationError(error: unknown): boolean {
    return error instanceof Error && ['AbortError', 'CancelledError'].includes(error.name);
}

function safeTimezone(value: string): string {
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return value;
    } catch {
        return 'UTC';
    }
}

function elapsedHours(value: string): number {
    const time = Date.parse(value);
    return Number.isFinite(time) ? (Date.now() - time) / 3_600_000 : Number.POSITIVE_INFINITY;
}

function formatPythonTime(iso: string, format: string): string {
    const [date, time] = iso.split('T');
    const [year, month, day] = date.split('-');
    const [hour, minute, second] = time.split(':');
    return format
        .replaceAll('%Y', year)
        .replaceAll('%m', month)
        .replaceAll('%d', day)
        .replaceAll('%H', hour)
        .replaceAll('%M', minute)
        .replaceAll('%S', second);
}

function normalizeJSON(value: string): string {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return JSON.stringify(parsed, Object.keys(parsed).sort());
    } catch {
        return value.trim();
    }
}

function interpolate(template: string, values: Record<string, unknown>): string {
    return Object.entries(values).reduce(
        (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
        template
    );
}

function isImage(block: ContentBlock): block is DataBlock {
    return block.type === 'data' && block.source.media_type.startsWith('image/');
}
