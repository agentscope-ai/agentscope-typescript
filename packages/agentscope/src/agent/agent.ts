import { z } from 'zod';

import {
    ContentBlock,
    createMsg,
    getContentBlocks,
    Msg,
    ToolCallBlock,
    ToolResultBlock,
} from '../message';
import { ChatModelBase, ChatResponse, ChatUsage } from '../model';
import { Toolkit, ToolResponse } from '../tool';
import { ActingOptions, ObserveOptions, ReasoningOptions, ReplyOptions } from './interfaces';
import {
    AgentEvent,
    EventType,
    ModelCallEndedEvent,
    ModelCallStartedEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextBlockDeltaEvent,
    TextBlockEndEvent,
    TextBlockStartEvent,
    ThinkingBlockDeltaEvent,
    ThinkingBlockEndEvent,
    ThinkingBlockStartEvent,
    ToolCallDeltaEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolResultBinaryDeltaEvent,
    ToolResultEndEvent,
    ToolResultStartEvent,
    ToolResultTextDeltaEvent,
} from '../event';
import { StorageBase } from '../storage';

const DEFAULT_COMPRESSION_PROMPT =
    '<system-hint>You have been working on the task described above but have not yet completed it. ' +
    'Now write a continuation summary that will allow you to resume work efficiently in a future context window ' +
    'where the conversation history will be replaced with this summary. ' +
    'Your summary should be structured, concise, and actionable.</system-hint>';

const DEFAULT_SUMMARY_SCHEMA = z.object({
    task_overview: z
        .string()
        .max(300)
        .describe(
            "The user\'s core request and success criteria. Any clarifications or constraints they specified"
        ),
    current_state: z
        .string()
        .max(300)
        .describe(
            'What has been completed so far. File created, modified, or analyzed (with paths if relevant). Key outputs or artifacts produced.'
        ),
    important_discoveries: z
        .string()
        .max(300)
        .describe(
            "Technical constraints or requirements uncovered. Decisions made and their rationale. Errors encountered and how they were resolved. What approaches were tried that didn\'t work (and why)"
        ),
    next_steps: z
        .string()
        .max(200)
        .describe(
            'Specific actions needed to complete the task. Any blockers or open questions to resolve. Priority order if multiple steps remain'
        ),
    context_to_preserve: z
        .string()
        .max(300)
        .describe(
            "User preferences or style requirements. Domain-specific details that aren\'t obvious. Any promises made to the user"
        ),
});

export interface CompressionConfig {
    /**
     * Whether to enable memory compression.
     */
    enabled: boolean;
    /**
     * The token count threshold to trigger memory compression.
     */
    triggerThreshold: number;
    /**
     * The function to count the tokens of the messages in memory. If not provided, a heuristic token counting method will be used by default.
     */
    tokenCountFunc?: (msgs: Msg[]) => number;
    /**
     * The chat model used for compression. If not provided, the same model as the agent will be used by default.
     */
    compressionModel?: ChatModelBase;
    /**
     * The prompt template for memory compression. It should be designed to instruct the model to compress the input messages into a concise summary while preserving important information. If not provided, a default prompt will be used.
     */
    compressionPrompt?: string;
    /**
     * The JSON schema for the compressed summary. The model will be guided to compress the memory into a structured summary following this schema. If not provided, a default schema with a single text field will be used.
     */
    summarySchema?: z.ZodObject;
    /**
     * The number of recent messages to keep in the context without compression.
     */
    keepRecent?: number;
}

export interface AgentOptions {
    name: string;
    sysPrompt: string;
    model: ChatModelBase;
    maxIters?: number;
    toolkit?: Toolkit;
    storage?: StorageBase;
    compressionConfig?: CompressionConfig;
}

/**
 * The unified agent class in AgentScope library.
 */
export class Agent {
    // Agent configuration
    name: string;
    model: ChatModelBase;
    maxIters: number;
    toolkit: Toolkit;
    storage?: StorageBase;
    context: Msg[];
    private _loaded: boolean;
    private _sysPrompt: string;
    compressionConfig?: CompressionConfig;

    // Agent state
    replyId: string;
    curIter: number;
    confirmedToolCallIds: string[];
    curSummary: string;

    /**
     * Initialize an agent instance with the given parameters.
     *
     * @param options - The agent configuration options.
     * @param options.name - The name of the agent.
     * @param options.sysPrompt - The system prompt for the agent.
     * @param options.model - The chat model to use.
     * @param options.maxIters - Maximum iterations (default: 5).
     * @param options.memory - Memory storage (default: InMemoryMemory).
     * @param options.toolkit - Toolkit for tools (default: Toolkit).
     */
    constructor(options: AgentOptions) {
        // Check maxIters mast be greater than 0
        if (options.maxIters !== undefined && options.maxIters <= 0) {
            throw new Error('maxIters must be greater than 0');
        }

        this.name = options.name;
        this._sysPrompt = options.sysPrompt;
        this.model = options.model;
        this.maxIters = options.maxIters ?? 20;
        this.context = [];
        this.toolkit = options.toolkit ?? new Toolkit();
        this.storage = options.storage;
        this.compressionConfig = options.compressionConfig;

        // Record if the agent state has been loaded from storage to avoid repeat loading
        this._loaded = false;

        // The states that tracks the current reply session
        this.replyId = '';
        this.curIter = 0;
        this.confirmedToolCallIds = [];
        this.curSummary = '';
    }

    /**
     * Load the state from the storage if storage is provided and not loaded yet.
     */
    async loadState() {
        if (this._loaded || !this.storage) return;
        const { context, metadata } = await this.storage.loadAgentState({ agentId: this.name });
        console.log(`Load state for agent "${this.name}" from storage:`, { context, metadata });
        this.context = context;
        this.replyId = (metadata.replyId as string) || '';
        this.curIter = (metadata.curIter as number) || 0;
        this.curSummary = (metadata.curSummary as string) || '';
        this._loaded = true;
    }

    /**
     * Save the state of the current reply session to storage if storage is provided.
     */
    async saveState() {
        if (!this.storage) return;
        await this.storage.saveAgentState({
            agentId: this.name,
            context: this.context,
            metadata: {
                replyId: this.replyId,
                curIter: this.curIter,
                curSummary: this.curSummary,
            },
        });
    }

    /**
     * Get the system prompt of the agent.
     *
     * @returns The system prompt string.
     */
    public get sysPrompt() {
        const skillsPrompt = this.toolkit.getSkillsPrompt();
        if (skillsPrompt.length > 0) {
            return this._sysPrompt + '\n\n' + skillsPrompt;
        }
        return this._sysPrompt;
    }

    /**
     * Reply to the given message and stream agent events as they are generated.
     *
     * @param options - The reply options containing the incoming message.
     * @returns An async generator that yields agent events and resolves to the final reply message.
     */
    public async *replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent, Msg> {
        // Load the agent state from storage if not loaded yet
        await this.loadState();
        try {
            // Yield the reply stream
            return yield* this._reply(options);
        } finally {
            await this.saveState();
        }
    }

    /**
     * Reply to the given message, consuming all streamed events internally.
     *
     * @param options - The reply options containing the incoming message.
     * @param options.msgs - The incoming message(s) to reply to.
     * @returns A promise that resolves to the final reply message.
     */
    public async reply(options: ReplyOptions): Promise<Msg> {
        // Load the agent state from storage if not loaded yet
        await this.loadState();
        try {
            const res = this._reply(options);
            while (true) {
                const { value, done } = await res.next();
                if (done) {
                    return value as Msg;
                }
            }
        } finally {
            await this.saveState();
        }
    }

    /**
     * Save the given content blocks into the context as a new block in the last assistant message,
     * or create a new assistant message if the last message is not from the assistant or has a different name.
     * @param blocks
     * @param usage
     */
    protected _saveToContext(blocks: ContentBlock[], usage?: ChatUsage): void {
        const lastMsg = this.context.at(-1);
        if (this.context.length === 0) {
            this.context.push(
                createMsg({ name: this.name, content: blocks, role: 'assistant', usage })
            );
        } else if (lastMsg && lastMsg.role === 'assistant' && lastMsg.name === this.name) {
            lastMsg.content.push(...blocks);
            if (usage) {
                if (!lastMsg.usage) {
                    lastMsg.usage = {
                        inputTokens: 0,
                        outputTokens: 0,
                    };
                }
                lastMsg.usage.inputTokens = lastMsg.usage.inputTokens + usage.inputTokens;
                lastMsg.usage.outputTokens = lastMsg.usage.outputTokens + usage.outputTokens;
            }
        } else {
            this.context.push(
                createMsg({ name: this.name, content: blocks, role: 'assistant', usage })
            );
        }
    }

    /**
     * Get the pending tool calls that have no results yet in the context.
     * @returns An array of pending `ToolCallBlock`s that are waiting for execution results.
     */
    protected _getPendingToolCalls(): ToolCallBlock[] {
        if (this.context.length === 0) return [];

        const lastMsg = this.context.at(-1);
        if (!lastMsg) return [];
        if (lastMsg.role === 'assistant') {
            const toolCalls = getContentBlocks(lastMsg, 'tool_call');
            const toolResults = getContentBlocks(lastMsg, 'tool_result');
            return toolCalls.filter(toolCall => !toolResults.some(tr => tr.id === toolCall.id));
        }
        return [];
    }

    /**
     * Get the awaiting tool calls that require user confirmation or external execution.
     * @returns An array of `ToolCallBlock`s that are waiting for user confirmation or external execution.
     */
    protected _getAwaitingToolCalls(): {
        awaitingType?: EventType.REQUIRE_USER_CONFIRM | EventType.REQUIRE_EXTERNAL_EXECUTION;
        expectedEventType?: EventType.USER_CONFIRM_RESULT | EventType.EXTERNAL_EXECUTION_RESULT;
        awaitingToolCalls: ToolCallBlock[];
        preToolCalls: ToolCallBlock[];
    } {
        // If there is awaiting tool calls within the last assistant message in the context
        const pendingToolCalls = this._getPendingToolCalls();

        // The tool calls that should be executed before yield the (maybe have) user-confirm or external-execution event
        const preToolCalls: ToolCallBlock[] = [];
        for (const [index, toolCall] of pendingToolCalls.entries()) {
            if (
                this.toolkit.requireUserConfirm(toolCall.name) &&
                !this.confirmedToolCallIds.includes(toolCall.id)
            ) {
                toolCall.awaitUserConfirmation = true;
                // Find the continuous tool calls that require user confirmation
                let i = index + 1;
                for (; i < pendingToolCalls.length; i++) {
                    const nextToolCall = pendingToolCalls[i];
                    if (
                        !this.toolkit.requireUserConfirm(nextToolCall.name) ||
                        this.confirmedToolCallIds.includes(nextToolCall.id)
                    )
                        break;
                    nextToolCall.awaitUserConfirmation = true;
                }
                return {
                    awaitingType: EventType.REQUIRE_USER_CONFIRM,
                    expectedEventType: EventType.USER_CONFIRM_RESULT,
                    awaitingToolCalls: pendingToolCalls.slice(index, i),
                    preToolCalls,
                };
            }

            if (this.toolkit.requireExternalExecution(toolCall.name)) {
                // Find the continuous tool calls that require external execution
                let i = index + 1;
                for (; i < pendingToolCalls.length; i++) {
                    const nextToolCall = pendingToolCalls[i];
                    if (!this.toolkit.requireExternalExecution(nextToolCall.name)) break;
                }
                return {
                    awaitingType: EventType.REQUIRE_EXTERNAL_EXECUTION,
                    expectedEventType: EventType.EXTERNAL_EXECUTION_RESULT,
                    awaitingToolCalls: pendingToolCalls.slice(index, i),
                    preToolCalls,
                };
            }

            preToolCalls.push(toolCall);
        }
        return { awaitingToolCalls: [], preToolCalls };
    }

    /**
     * Core reply logic without middlewares. Observes the incoming message, runs
     * reasoning/acting iterations up to `maxIters`, and returns the final response.
     *
     * @param options - The reply options containing the incoming message.
     * @returns An async generator that yields agent events and resolves to the final reply message.
     */
    protected async *_reply(options?: ReplyOptions): AsyncGenerator<AgentEvent, Msg> {
        const { expectedEventType } = this._getAwaitingToolCalls();
        if (expectedEventType) {
            // Checking
            if (!options || !options.event || options.event.type !== expectedEventType) {
                throw new Error(
                    `Agent is awaiting for '${expectedEventType}' confirmation, but received event of type '${options?.event?.type ?? 'none'}'.`
                );
            }

            // handle the external execution result event
            const event = options.event;
            if (event.type === EventType.EXTERNAL_EXECUTION_RESULT) {
                // Record the tool results into context and go on acting
                this._saveToContext(event.executionResults);
            } else if (event.type === EventType.USER_CONFIRM_RESULT) {
                for (const result of event.confirmResults) {
                    if (result.confirmed) {
                        this.confirmedToolCallIds.push(result.toolCall.id);
                    } else {
                        // If user rejected, add a rejection result and handle the pending tool calls
                        const rejectionRes = `<system-info>**Note** the user rejected the execution of tool "${result.toolCall.name}"!</system-info>`;
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.TOOL_RESULT_START,
                            replyId: this.replyId,
                            toolCallId: result.toolCall.id,
                        } as ToolResultStartEvent;
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.TOOL_RESULT_TEXT_DELTA,
                            replyId: this.replyId,
                            toolCallId: result.toolCall.id,
                            delta: rejectionRes,
                        } as ToolResultTextDeltaEvent;
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.TOOL_RESULT_END,
                            replyId: this.replyId,
                            toolCallId: result.toolCall.id,
                            state: 'interrupted',
                        } as ToolResultEndEvent;
                        this._saveToContext([
                            {
                                type: 'tool_result',
                                id: result.toolCall.id,
                                name: result.toolCall.name,
                                output: [
                                    {
                                        id: crypto.randomUUID(),
                                        type: 'text',
                                        text: `<system-info>**Note** the user rejected the execution of tool "${result.toolCall.name}"!</system-info>`,
                                    },
                                ],
                                state: 'interrupted',
                            },
                        ]);
                    }
                }
                // Remove the tool call from the awaiting state
                const processedToolCallIds = event.confirmResults.map(result => result.toolCall.id);
                // Set the awaitingUserConfirmation flag to undefined for UI update
                this.context.at(-1)?.content.forEach(content => {
                    if (content.type === 'tool_call' && processedToolCallIds.includes(content.id)) {
                        delete content.awaitUserConfirmation;
                    }
                });
            }
        } else {
            // The normal reply flow starts without any external event
            this.curIter = 0;
            this.replyId = crypto.randomUUID();
            this.confirmedToolCallIds = [];

            // Yield the run started event
            yield {
                id: crypto.randomUUID(),
                type: EventType.RUN_STARTED,
                createdAt: new Date().toISOString(),
                sessionId: '',
                replyId: this.replyId,
                name: this.name,
                role: 'assistant',
            } as RunStartedEvent;
        }

        // Store the incoming message into memory
        if (Array.isArray(options?.msgs)) {
            // await this.memory.add(options.msg);
            this.context.push(...options.msgs);
        } else if (options?.msgs) {
            this.context.push(options.msgs);
        }

        while (this.curIter < this.maxIters) {
            const pendingToolCalls = this._getPendingToolCalls();
            if (pendingToolCalls.length === 0) {
                await this.compressMemoryIfNeeded();
                const reasoningResponse = yield* this._reasoning({ toolChoice: 'auto' });
                this._saveToContext(reasoningResponse.content, reasoningResponse.usage);
            }

            // Extract the awaiting tool calls and those should be executed before yielding human-in-the-loop events
            const { awaitingType, awaitingToolCalls, preToolCalls } = this._getAwaitingToolCalls();
            // Execute the pre-tool calls before yielding the user-confirm or external-execution event if there is any
            for (const toolCall of preToolCalls) {
                const actingContent = yield* this._acting({ toolCall });
                this._saveToContext([actingContent]);
                // Consume the confirmation after execution
                this.confirmedToolCallIds = this.confirmedToolCallIds.filter(
                    id => id !== toolCall.id
                );
            }

            // yield the user-confirm or external-execution event if there is any awaiting tool calls
            if (awaitingType) {
                yield {
                    id: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    type: awaitingType,
                    replyId: this.replyId,
                    toolCalls: awaitingToolCalls,
                };

                return createMsg({
                    name: this.name,
                    content: [
                        {
                            id: crypto.randomUUID(),
                            type: 'text',
                            text:
                                awaitingType === EventType.REQUIRE_USER_CONFIRM
                                    ? 'Waiting for user confirmation ...'
                                    : 'Waiting for external execution ...',
                        },
                    ],
                    role: 'assistant',
                });
            }

            // Break the loop if there is no tool call in the reasoning message
            if (preToolCalls.length === 0) break;

            this.curIter += 1;
        }

        // If exceed max iterations without text output
        if (this.context.at(-1)?.content.at(-1)?.type !== 'text') {
            // Generate a final response
            const summaryResponse = yield* this._reasoning({ toolChoice: 'none' });
            this._saveToContext(summaryResponse.content, summaryResponse.usage);
        }

        // Yield the run finished event
        yield {
            id: crypto.randomUUID(),
            type: EventType.RUN_FINISHED,
            createdAt: new Date().toISOString(),
            sessionId: '',
            replyId: this.replyId,
        } as RunFinishedEvent;

        return createMsg({
            id: this.replyId,
            name: this.name,
            // Must be a string for the final output message
            content: [this.context.at(-1)!.content.at(-1)!],
            role: 'assistant',
        });
    }

    /**
     * Core reasoning logic without middlewares. Calls the model with the current
     * memory and system prompt, converts the response to agent events, and saves
     * the resulting message to memory.
     *
     * @param options - The reasoning options, including tool choice strategy.
     * @returns An async generator that yields agent events and resolves to the content blocks of the model response.
     */
    protected async *_reasoning(
        options: ReasoningOptions
    ): AsyncGenerator<AgentEvent, ChatResponse> {
        const tools = this.toolkit.getJSONSchemas();
        yield {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            type: EventType.MODEL_CALL_STARTED,
            replyId: this.replyId,
            modelName: this.model.modelName,
        } as ModelCallStartedEvent;
        const res = await this.model.call({
            messages: [
                createMsg({
                    name: 'system',
                    content: [{ type: 'text', text: this.sysPrompt, id: crypto.randomUUID() }],
                    role: 'system',
                }),
                ...(this.curSummary
                    ? [
                          createMsg({
                              name: 'user',
                              content: [
                                  { type: 'text', text: this.curSummary, id: crypto.randomUUID() },
                              ],
                              role: 'user',
                          }),
                      ]
                    : []),
                ...this.context,
            ],
            tools,
            toolChoice: options.toolChoice,
        });

        let blockIds = {
            textBlockId: null,
            thinkingBlockId: null,
            toolCallIds: [],
        } as {
            textBlockId: string | null;
            thinkingBlockId: string | null;
            toolCallIds: string[];
        };
        let completedResponse: ChatResponse;
        if (this.model.stream) {
            // Handle streaming response
            while (true) {
                const { value, done } = await (
                    res as AsyncGenerator<ChatResponse, ChatResponse>
                ).next();
                if (done) {
                    // The complete response is returned in the `value` when `done` is true
                    completedResponse = value as ChatResponse;
                    break;
                }
                const chunk = value as ChatResponse;
                yield* this.convertChatResponseToEvent(blockIds, chunk);
            }
        } else {
            // Handle non-streaming response, the res is a ChatResponse instance
            completedResponse = res as ChatResponse;
            yield* this.convertChatResponseToEvent(blockIds, res as ChatResponse);
        }

        // Send end events for text message, thinking message and tool calls
        if (blockIds.textBlockId) {
            yield {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                type: EventType.TEXT_BLOCK_END,
                replyId: this.replyId,
                blockId: blockIds.textBlockId,
            } as TextBlockEndEvent;
        }
        if (blockIds.thinkingBlockId) {
            yield {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                type: EventType.THINKING_BLOCK_END,
                replyId: this.replyId,
                blockId: blockIds.thinkingBlockId,
            } as ThinkingBlockEndEvent;
        }
        if (blockIds.toolCallIds.length > 0) {
            for (const toolCallId of blockIds.toolCallIds) {
                yield {
                    id: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    type: EventType.TOOL_CALL_END,
                    replyId: this.replyId,
                    toolCallId,
                } as ToolCallEndEvent;
            }
        }

        yield {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            type: EventType.MODEL_CALL_ENDED,
            replyId: this.replyId,
            inputTokens: completedResponse.usage?.inputTokens || 0,
            outputTokens: completedResponse.usage?.outputTokens || 0,
        } as ModelCallEndedEvent;

        return completedResponse;
    }

    /**
     * Core acting logic without middlewares. Executes the given tool call, streams
     * intermediate tool result events, and saves the final tool response to memory.
     *
     * @param options - The acting options containing the tool call to execute.
     * @returns An async generator that yields tool result events.
     */
    protected async *_acting(options: ActingOptions): AsyncGenerator<AgentEvent, ToolResultBlock> {
        const res = this.toolkit.callToolFunction(options.toolCall);

        yield {
            type: EventType.TOOL_RESULT_START,
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            replyId: this.replyId,
            toolCallId: options.toolCall.id,
            toolCallName: options.toolCall.name,
        } as ToolResultStartEvent;

        while (true) {
            const { value, done } = await res.next();
            if (done) {
                return {
                    type: 'tool_result',
                    id: options.toolCall.id,
                    name: options.toolCall.name,
                    output: value.content,
                    state: value.state,
                } as ToolResultBlock;
            }
            yield* this.convertToolResponseToEvent(options.toolCall, value);
        }
    }

    /**
     * Receive external observation message(s) and save them into memory.
     *
     * @param options - The observe options containing the message to store.
     * @returns A promise that resolves when the message has been saved to memory.
     */
    protected async _observe(options: ObserveOptions): Promise<void> {
        // Load the agent state from storage if not loaded yet
        await this.loadState();

        if (Array.isArray(options.msg)) {
            // await this.memory.add(options.msg);
            this.context.push(...options.msg);
        } else if (options.msg) {
            this.context.push(options.msg);
        }
    }

    /**
     * Convert a `ChatResponse` chunk into a sequence of typed agent events.
     * Tracks message IDs across calls via the mutable `responseId` object so that
     * start/content/end events are correctly correlated.
     *
     * @param responseId - Mutable object tracking IDs for the current text, thinking, and tool-call messages.
     * @param responseId.textMessageId - ID of the in-progress text message, or `null` if not yet started.
     * @param responseId.thinkingMessageId - ID of the in-progress thinking message, or `null` if not yet started.
     * @param responseId.textBlockId
     * @param responseId.thinkingBlockId
     * @param responseId.toolCallIds - List of tool-call IDs seen so far in this response.
     * @param chunk - The chat response chunk to convert.
     * @returns An async generator that yields the corresponding agent events.
     */
    protected async *convertChatResponseToEvent(
        responseId: {
            textBlockId: string | null;
            thinkingBlockId: string | null;
            toolCallIds: string[];
        },
        chunk: ChatResponse
    ): AsyncGenerator<AgentEvent> {
        for (const block of chunk.content) {
            switch (block.type) {
                case 'text':
                    if (responseId.textBlockId === null) {
                        // A new uuid
                        responseId.textBlockId = crypto.randomUUID();
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.TEXT_BLOCK_START,
                            replyId: this.replyId,
                            blockId: responseId.textBlockId,
                        } as TextBlockStartEvent;
                    }
                    yield {
                        id: crypto.randomUUID(),
                        createdAt: new Date().toISOString(),
                        type: EventType.TEXT_BLOCK_DELTA,
                        replyId: this.replyId,
                        blockId: responseId.textBlockId,
                        delta: block.text,
                    } as TextBlockDeltaEvent;
                    break;

                case 'thinking':
                    if (responseId.thinkingBlockId === null) {
                        responseId.thinkingBlockId = crypto.randomUUID();
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.THINKING_BLOCK_START,
                            replyId: this.replyId,
                            blockId: responseId.thinkingBlockId,
                        } as ThinkingBlockStartEvent;
                    }
                    yield {
                        id: crypto.randomUUID(),
                        createdAt: new Date().toISOString(),
                        type: EventType.THINKING_BLOCK_DELTA,
                        replyId: this.replyId,
                        blockId: responseId.thinkingBlockId,
                        delta: block.thinking,
                    } as ThinkingBlockDeltaEvent;
                    break;

                case 'tool_call':
                    if (!responseId.toolCallIds.includes(block.id)) {
                        responseId.toolCallIds.push(block.id);
                        yield {
                            id: crypto.randomUUID(),
                            type: EventType.TOOL_CALL_START,
                            createdAt: new Date().toISOString(),
                            replyId: this.replyId,
                            toolCallId: block.id,
                            toolCallName: block.name,
                        } as ToolCallStartEvent;
                    }
                    yield {
                        id: crypto.randomUUID(),
                        createdAt: new Date().toISOString(),
                        type: EventType.TOOL_CALL_DELTA,
                        delta: block.input,
                        replyId: this.replyId,
                        toolCallId: block.id,
                    } as ToolCallDeltaEvent;
            }
        }
    }

    /**
     * Convert a `ToolResponse` into a sequence of typed agent events, followed by
     * a final `TOOL_RESULT_END` event.
     *
     * @param toolCall - The original tool-use block that triggered this response.
     * @param toolRes - The tool response containing result content blocks.
     * @returns An async generator that yields tool result events.
     */
    protected async *convertToolResponseToEvent(toolCall: ToolCallBlock, toolRes: ToolResponse) {
        for (const block of toolRes.content) {
            switch (block.type) {
                case 'text':
                    yield {
                        id: crypto.randomUUID(),
                        createdAt: new Date().toISOString(),
                        type: EventType.TOOL_RESULT_TEXT_DELTA,
                        replyId: this.replyId,
                        toolCallId: toolCall.id,
                        delta: block.text,
                    } as ToolResultTextDeltaEvent;
                    break;

                case 'data':
                    if (block.source.type === 'base64') {
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.TOOL_RESULT_BINARY_DELTA,
                            replyId: this.replyId,
                            toolCallId: toolCall.id,
                            mediaType: block.source.mediaType,
                            data: block.source.data,
                        } as ToolResultBinaryDeltaEvent;
                    } else if (block.source.type === 'url') {
                        yield {
                            id: crypto.randomUUID(),
                            createdAt: new Date().toISOString(),
                            type: EventType.TOOL_RESULT_BINARY_DELTA,
                            replyId: this.replyId,
                            toolCallId: toolCall.id,
                            mediaType: block.source.mediaType,
                            url: block.source.url,
                        } as ToolResultBinaryDeltaEvent;
                    }
                    break;
            }
        }
        yield {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            type: EventType.TOOL_RESULT_END,
            replyId: this.replyId,
            toolCallId: toolCall.id,
            state: toolRes.state,
        } as ToolResultEndEvent;
    }

    /**
     * Convert the agent instance to a JSON-serializable object.
     * @returns An object containing the agent's name and system prompt.
     */
    public async toJSON() {
        return {
            replyId: this.replyId,
            confirmedToolCallIds: this.confirmedToolCallIds,
            curIter: this.curIter,
        };
    }

    /**
     * Split the current context into two parts: one part that needs to be compressed and another part that should be reserved based on the compression configuration. The method calculates how many recent "units" (blocks or tool call pairs) to keep uncompressed according to the `keepRecent` setting in the compression configuration, and ensures that tool calls and their corresponding results are not separated during the split.
     * @returns An object containing the `toCompressedContext` which includes the messages that need to be compressed, and the `reservedContext` which includes the recent messages that should be kept uncompressed.
     */
    protected _splitContextForCompression() {
        let toCompressedContext: Msg[] = [];
        let reservedContext: Msg[] = [];

        // Calculate which messages need to be compressed
        // keepRecent specifies the number of recent "units" to keep uncompressed
        // A unit is either: a single block (text/thinking), or a tool_call + tool_result pair
        const keepRecent = this.compressionConfig!.keepRecent ?? 0;

        const nBlocks = this.context.map(msg => msg.content.length).reduce((a, b) => a + b, 0);
        const toCompressedBlockNumber = nBlocks - keepRecent > 0 ? nBlocks - keepRecent : 0;

        let currentCompressedBlocks = 0;
        for (const [index, msg] of this.context.entries()) {
            if (currentCompressedBlocks + msg.content.length <= toCompressedBlockNumber) {
                toCompressedContext.push(msg);
                currentCompressedBlocks += msg.content.length;
            } else {
                // The blocks that should be reserved according to the keepRecent count
                const reservedBlocks = msg.content.slice(
                    toCompressedBlockNumber - currentCompressedBlocks
                );
                // Check if the reserved blocks contain an unpaired tool_call or tool_result
                const unPairedToolResultIds = new Set<string>();
                for (const block of reservedBlocks) {
                    if (block.type == 'tool_call') {
                        unPairedToolResultIds.add(block.id);
                    } else if (block.type == 'tool_result') {
                        if (unPairedToolResultIds.has(block.id)) {
                            unPairedToolResultIds.delete(block.id);
                        }
                    }
                }
                // If there are unpaired tool calls, we need to move them to the reserved blocks
                let i = toCompressedBlockNumber - currentCompressedBlocks - 1;
                for (; i >= 0; i--) {
                    const block = msg.content[i];
                    if (block.type === 'tool_call' && unPairedToolResultIds.has(block.id)) {
                        unPairedToolResultIds.delete(block.id);
                    }
                    if (unPairedToolResultIds.size === 0) break;
                }
                // All contents in this message should be reserved if i
                if (i <= 0) {
                    reservedContext.push(msg);
                    break;
                }

                // Slice the message content and push the reserved part to the compressed context
                const lastMsg = { ...msg };
                lastMsg.content = msg.content.slice(0, i);
                toCompressedContext.push(lastMsg);

                const reservedMsg = { ...msg };
                reservedMsg.content = msg.content.slice(i);
                reservedContext.push(reservedMsg);

                // The rest messages should be reserved
                reservedContext.push(...this.context.slice(index + 1));
                break;
            }
        }
        return { toCompressedContext, reservedContext };
    }

    /**
     * Compress the agent's memory using the specified compression model (if provided) or the original model.
     */
    protected async compressMemoryIfNeeded() {
        // The tool call and result pair must be kept or removed together
        if (!this.compressionConfig || !this.compressionConfig.enabled) return;

        const { toCompressedContext, reservedContext } = this._splitContextForCompression();

        // Compress the toCompressedContext
        if (
            toCompressedContext.length <= 0 ||
            (toCompressedContext.length === 1 && toCompressedContext.at(0)?.content.length === 1)
        )
            return;

        // Compute if the context exceed the threshold
        const messages = [
            createMsg({
                name: 'system',
                content: [{ type: 'text', text: this.sysPrompt, id: crypto.randomUUID() }],
                role: 'system',
            }),
            ...toCompressedContext,
            // instructions to compress the context into a summary
            createMsg({
                name: 'user',
                content: [
                    {
                        id: crypto.randomUUID(),
                        type: 'text',
                        text:
                            this.compressionConfig.compressionPrompt || DEFAULT_COMPRESSION_PROMPT,
                    },
                ],
                role: 'user',
            }),
        ];

        const nTokens = await this.model.countTokens({
            messages,
            tools: this.toolkit.getJSONSchemas(),
        });
        console.debug(`[AGENT ${this.name}] Current context token count: ${nTokens}.`);
        if (nTokens <= this.compressionConfig.triggerThreshold) return;

        console.log(
            `[AGENT ${this.name}] Compressing memory with ${toCompressedContext.length} messages.`
        );
        // Generate the summary structured content
        const res = await this.model.callStructured({
            messages: [
                createMsg({
                    name: 'system',
                    content: [{ type: 'text', text: this.sysPrompt, id: crypto.randomUUID() }],
                    role: 'system',
                }),
                ...toCompressedContext,
                // instructions to compress the context into a summary
                createMsg({
                    name: 'user',
                    content: [
                        {
                            id: crypto.randomUUID(),
                            type: 'text',
                            text:
                                this.compressionConfig.compressionPrompt ||
                                DEFAULT_COMPRESSION_PROMPT,
                        },
                    ],
                    role: 'user',
                }),
            ],
            schema: this.compressionConfig.summarySchema || DEFAULT_SUMMARY_SCHEMA,
        });

        // Make the compression summary
        let summaryText = '<system-reminder>Here is a summary of your previous work\n';
        for (const [key, value] of Object.entries(res.content)) {
            summaryText += `# ${key}\n${value}\n`;
        }
        summaryText += '</system-reminder>';

        console.debug(`[AGENT ${this.name}] Compression summary: ${summaryText}`);

        // Update the context with the compression summary and the reserved recent blocks
        this.context = reservedContext;
        this.curSummary = summaryText;
    }
}
