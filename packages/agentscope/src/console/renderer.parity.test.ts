/* eslint-disable jsdoc/require-jsdoc */

import { Agent } from '../agent';
import { QueueModel } from '../agent/test-helpers';
import { EventType, createEvent, type AgentEvent, type RequireUserConfirmEvent } from '../event';
import { ToolCallBlock, UserMsg } from '../message';
import type { ChatModelRequestOptions } from '../model/base';
import { PermissionBehavior } from '../permission';
import { ReplyFinishedReason } from '../type';
import { confirmToolCalls, launchConsole, runConsoleReply, type ConsoleInput } from './launcher';
import { ConsoleRenderer, formatToolInput, humanSize, type ConsoleWriter } from './renderer';

const REPLY_ID = 'reply-test';

class MemoryWriter implements ConsoleWriter {
    output = '';
    write(text: string): void {
        this.output += text;
    }
}

describe('ConsoleRenderer Python parity', () => {
    let writer: MemoryWriter;
    let renderer: ConsoleRenderer;

    beforeEach(() => {
        writer = new MemoryWriter();
        renderer = new ConsoleRenderer({ writer });
    });

    test('streams text and accumulates the reply message', () => {
        renderAll(renderer, [
            event({
                type: EventType.REPLY_START,
                session_id: 's',
                reply_id: REPLY_ID,
                name: 'Friday',
            }),
            ...textEvents('hello world'),
        ]);
        expect(writer.output).toContain('Friday');
        expect(writer.output).toContain('hello world');
        expect(renderer.lastMsg?.id).toBe(REPLY_ID);
        expect(renderer.lastMsg?.content[0]).toEqual(
            expect.objectContaining({ type: 'text', text: 'hello world' })
        );
    });

    test('quiet hides everything except reply text and errors', () => {
        renderer.verbosity = 'quiet';
        renderAll(renderer, [
            event({
                type: EventType.REPLY_START,
                session_id: 's',
                reply_id: REPLY_ID,
                name: 'Friday',
            }),
            event({ type: EventType.THINKING_BLOCK_START, reply_id: REPLY_ID, block_id: 'th1' }),
            event({
                type: EventType.THINKING_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'th1',
                delta: 'pondering...',
            }),
            event({ type: EventType.THINKING_BLOCK_END, reply_id: REPLY_ID, block_id: 'th1' }),
            ...textEvents('the answer'),
            event({
                type: EventType.MODEL_CALL_END,
                reply_id: REPLY_ID,
                input_tokens: 10,
                output_tokens: 5,
            }),
        ]);
        expect(writer.output).toContain('the answer');
        expect(writer.output).not.toContain('Friday');
        expect(writer.output).not.toContain('pondering');
        expect(writer.output).not.toContain('tokens');
    });

    test('default shows thinking and token usage', () => {
        renderAll(renderer, [
            event({ type: EventType.THINKING_BLOCK_START, reply_id: REPLY_ID, block_id: 'th1' }),
            event({
                type: EventType.THINKING_BLOCK_DELTA,
                reply_id: REPLY_ID,
                block_id: 'th1',
                delta: 'pondering...',
            }),
            event({ type: EventType.THINKING_BLOCK_END, reply_id: REPLY_ID, block_id: 'th1' }),
            event({
                type: EventType.MODEL_CALL_END,
                reply_id: REPLY_ID,
                input_tokens: 10,
                output_tokens: 5,
            }),
        ]);
        expect(writer.output).toContain('Thinking');
        expect(writer.output).toContain('pondering...');
        expect(writer.output).toContain('tokens: 10 in / 5 out');
    });

    test('buffers a tool call and prints formatted input only on end', () => {
        renderAll(renderer, [
            event({
                type: EventType.TOOL_CALL_START,
                reply_id: REPLY_ID,
                tool_call_id: 'c1',
                tool_call_name: 'get_weather',
            }),
            event({
                type: EventType.TOOL_CALL_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'c1',
                delta: '{"city": "Hang',
            }),
            event({
                type: EventType.TOOL_CALL_DELTA,
                reply_id: REPLY_ID,
                tool_call_id: 'c1',
                delta: 'zhou"}',
            }),
        ]);
        expect(writer.output).not.toContain('get_weather');

        renderer.render(
            event({ type: EventType.TOOL_CALL_END, reply_id: REPLY_ID, tool_call_id: 'c1' })
        );
        expect(writer.output).toContain('get_weather {"city": "Hangzhou"}');
    });

    test('keeps concurrent tool result deltas separated', () => {
        renderAll(renderer, [
            toolResultStart('c1', 'tool_a'),
            toolResultStart('c2', 'tool_b'),
            toolResultDelta('c1', 'AAA-'),
            toolResultDelta('c2', 'BBB-'),
            toolResultDelta('c1', 'aaa'),
            toolResultDelta('c2', 'bbb'),
            event({
                type: EventType.TOOL_RESULT_END,
                reply_id: REPLY_ID,
                tool_call_id: 'c1',
                state: 'success',
            }),
            event({
                type: EventType.TOOL_RESULT_END,
                reply_id: REPLY_ID,
                tool_call_id: 'c2',
                state: 'error',
            }),
        ]);
        expect(writer.output).toContain('AAA-aaa');
        expect(writer.output).toContain('BBB-bbb');
        expect(writer.output).toContain('✓ tool_a');
        expect(writer.output).toContain('✗ tool_b');
    });

    test('truncates long tool results with the omitted-line count', () => {
        renderer.maxToolResultLines = 3;
        renderAll(renderer, [
            toolResultStart('c1', 'Bash'),
            toolResultDelta(
                'c1',
                Array.from({ length: 10 }, (_, index) => 'line-' + index).join('\n')
            ),
            event({
                type: EventType.TOOL_RESULT_END,
                reply_id: REPLY_ID,
                tool_call_id: 'c1',
                state: 'success',
            }),
        ]);
        expect(writer.output).toContain('line-2');
        expect(writer.output).not.toContain('line-3');
        expect(writer.output).toContain('(+7 more lines)');
    });

    test('shows hint blocks except in quiet mode', () => {
        const hint = event({
            type: EventType.HINT_BLOCK,
            reply_id: REPLY_ID,
            block_id: 'h1',
            source: 'runtime_state_injection',
            hint: '<current-time>2026-08-12</current-time>',
        });
        renderer.verbosity = 'quiet';
        renderer.render(hint);
        expect(writer.output).not.toContain('current-time');
        renderer.verbosity = 'default';
        renderer.render(hint);
        expect(writer.output).toContain('hint from runtime_state_injection');
        expect(writer.output).toContain('<current-time>2026-08-12</current-time>');
    });

    test('confirmation notice includes suggested rules', () => {
        renderer.render(
            event({
                type: EventType.REQUIRE_USER_CONFIRM,
                reply_id: REPLY_ID,
                tool_calls: [
                    ToolCallBlock({
                        id: 'c1',
                        name: 'Bash',
                        input: '{"command": "pip install requests"}',
                        state: 'asking',
                        suggested_rules: [
                            {
                                tool_name: 'Bash',
                                rule_content: 'pip install',
                                behavior: PermissionBehavior.ALLOW,
                                source: 'session',
                            },
                        ],
                    }),
                ],
            })
        );
        expect(writer.output).toContain('awaiting user confirmation');
        expect(writer.output).toContain('Bash {"command": "pip install requests"}');
        expect(writer.output).toContain('suggested rule: allow Bash(pip install)');
    });

    test('reply end prints interruption and updates lastMsg', () => {
        renderAll(renderer, [
            event({
                type: EventType.REPLY_START,
                session_id: 's',
                reply_id: REPLY_ID,
                name: 'Friday',
            }),
            ...textEvents('partial answer'),
            event({
                type: EventType.REPLY_END,
                session_id: 's',
                reply_id: REPLY_ID,
                finished_reason: ReplyFinishedReason.INTERRUPTED,
            }),
        ]);
        expect(writer.output).toContain('interrupted by the user');
        expect(renderer.lastMsg?.finished_reason).toBe(ReplyFinishedReason.INTERRUPTED);
        expect(renderer.lastMsg?.content[0]).toEqual(
            expect.objectContaining({ text: 'partial answer' })
        );
    });

    test('debug shows lifecycle details and tool metadata', () => {
        renderer.verbosity = 'debug';
        renderAll(renderer, [
            event({
                type: EventType.MODEL_CALL_START,
                reply_id: REPLY_ID,
                model_name: 'qwen',
            }),
            toolResultStart('c1', 'Read'),
            toolResultDelta('c1', 'ok'),
            event({
                type: EventType.TOOL_RESULT_END,
                reply_id: REPLY_ID,
                tool_call_id: 'c1',
                state: 'success',
                metadata: { path: '/tmp/a' },
            }),
        ]);
        expect(writer.output).toContain('model call → qwen');
        expect(writer.output).toContain('metadata: {"path":"/tmp/a"}');
    });

    test('format helpers match Python compact/pretty and size boundaries', () => {
        expect(formatToolInput('')).toBe('{}');
        expect(formatToolInput('{"city":"Hangzhou"}')).toBe('{"city": "Hangzhou"}');
        expect(formatToolInput('not-json')).toBe('not-json');
        expect(formatToolInput(JSON.stringify({ text: 'x'.repeat(100) })).includes('\n')).toBe(
            true
        );
        expect(humanSize(1023)).toBe('1023B');
        expect(humanSize(1024)).toBe('1KB');
        expect(humanSize(1024 ** 3)).toBe('1.0GB');
    });

    test('Python-style constructor and snake-case aliases remain available', () => {
        const positional = new ConsoleRenderer('quiet', 3, writer);
        expect(positional.verbosity).toBe('quiet');
        expect(positional.max_tool_result_lines).toBe(3);
        positional.max_tool_result_lines = null;
        expect(positional.maxToolResultLines).toBeNull();
        expect(positional.last_msg).toBeNull();
    });
});

describe('interactive console helpers', () => {
    test('runConsoleReply renders events and returns pending confirmation', async () => {
        const pending = event({
            type: EventType.REQUIRE_USER_CONFIRM,
            reply_id: REPLY_ID,
            tool_calls: [ToolCallBlock({ id: 'c1', name: 'Write', input: '{}' })],
        }) as RequireUserConfirmEvent;
        const target = scriptedTarget([
            event({
                type: EventType.REPLY_START,
                session_id: 's',
                reply_id: REPLY_ID,
                name: 'agent',
            }),
            pending,
        ]);
        const writer = new MemoryWriter();
        const renderer = new ConsoleRenderer({ writer });

        await expect(
            runConsoleReply(target, renderer, UserMsg({ name: 'user', content: 'hello' }))
        ).resolves.toBe(pending);
        expect(writer.output).toContain('awaiting user confirmation');
    });

    test('always confirmation accepts suggested rules', async () => {
        const toolCall = ToolCallBlock({
            id: 'c1',
            name: 'Bash',
            input: '{}',
            suggested_rules: [
                {
                    tool_name: 'Bash',
                    rule_content: 'npm install',
                    behavior: PermissionBehavior.ALLOW,
                    source: 'suggested',
                },
            ],
        });
        const input = new ScriptedInput(['always']);
        const result = await confirmToolCalls(
            event({
                type: EventType.REQUIRE_USER_CONFIRM,
                reply_id: REPLY_ID,
                tool_calls: [toolCall],
            }) as RequireUserConfirmEvent,
            input
        );
        expect(result.confirm_results).toEqual([
            { confirmed: true, tool_call: toolCall, rules: toolCall.suggested_rules },
        ]);
        expect(input.prompts[0]).toContain('[a]lways');
    });

    test('launchConsole skips empty input and exits without leaking I/O', async () => {
        const input = new ScriptedInput(['', 'hello', 'exit']);
        const writer = new MemoryWriter();
        const renderer = new ConsoleRenderer({ writer });
        const received: unknown[] = [];
        const target = {
            async *replyStream(options: unknown): AsyncGenerator<AgentEvent> {
                received.push(options);
                yield* scriptedTarget(textEvents('answer')).replyStream({});
            },
        };

        await launchConsole(target, { input, renderer, userName: 'alice' });

        expect(received).toHaveLength(1);
        expect(input.closed).toBe(true);
        expect(input.prompts).toEqual(['\nalice> ', '\nalice> ', '\nalice> ']);
        expect(writer.output).toContain('answer');
    });

    test('AbortSignal reaches Agent model calls and closes as interrupted', async () => {
        const model = new SignalModel();
        const agent = new Agent({ name: 'agent', systemPrompt: 'base', model });
        const controller = new AbortController();
        const events: AgentEvent[] = [];
        const draining = (async () => {
            for await (const item of agent.replyStream({
                inputs: UserMsg({ name: 'user', content: 'wait' }),
                signal: controller.signal,
            })) {
                if ('type' in item) events.push(item);
            }
        })();

        await model.started;
        controller.abort();
        await draining;

        expect(events).toContainEqual(
            expect.objectContaining({
                type: EventType.REPLY_END,
                finished_reason: ReplyFinishedReason.INTERRUPTED,
            })
        );
    });
});

class SignalModel extends QueueModel {
    readonly started: Promise<void>;
    private markStarted!: () => void;

    constructor() {
        super();
        this.started = new Promise(resolve => {
            this.markStarted = resolve;
        });
    }

    override async _callAPI(
        _modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<never> {
        this.markStarted();
        const signal = options.signal as AbortSignal;
        return new Promise((_, reject) => {
            const fail = (): void => reject(new DOMException('cancelled', 'AbortError'));
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
        });
    }
}

class ScriptedInput implements ConsoleInput {
    readonly prompts: string[] = [];
    closed = false;
    constructor(private readonly answers: string[]) {}
    async question(prompt: string): Promise<string> {
        this.prompts.push(prompt);
        const answer = this.answers.shift();
        if (answer === undefined) throw new Error('input closed');
        return answer;
    }
    close(): void {
        this.closed = true;
    }
}

function scriptedTarget(events: AgentEvent[]) {
    return {
        async *replyStream(_options?: unknown): AsyncGenerator<AgentEvent> {
            for (const value of events) yield value;
        },
    };
}

function renderAll(renderer: ConsoleRenderer, events: AgentEvent[]): void {
    for (const value of events) renderer.render(value);
}

function textEvents(text: string, blockId = 't1'): AgentEvent[] {
    return [
        event({ type: EventType.TEXT_BLOCK_START, reply_id: REPLY_ID, block_id: blockId }),
        event({
            type: EventType.TEXT_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: blockId,
            delta: text.slice(0, 3),
        }),
        event({
            type: EventType.TEXT_BLOCK_DELTA,
            reply_id: REPLY_ID,
            block_id: blockId,
            delta: text.slice(3),
        }),
        event({ type: EventType.TEXT_BLOCK_END, reply_id: REPLY_ID, block_id: blockId }),
    ];
}

function toolResultStart(id: string, name: string): AgentEvent {
    return event({
        type: EventType.TOOL_RESULT_START,
        reply_id: REPLY_ID,
        tool_call_id: id,
        tool_call_name: name,
    });
}

function toolResultDelta(id: string, delta: string): AgentEvent {
    return event({
        type: EventType.TOOL_RESULT_TEXT_DELTA,
        reply_id: REPLY_ID,
        tool_call_id: id,
        delta,
    });
}

function event(input: Parameters<typeof createEvent>[0]): AgentEvent {
    return createEvent(input);
}
