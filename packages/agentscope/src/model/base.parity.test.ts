/* eslint-disable jsdoc/require-jsdoc */

import { z } from 'zod';

import { StructuredOutputError } from '../exception';
import { Base64Source, DataBlock, TextBlock, ToolCallBlock, URLSource, UserMsg } from '../message';
import type { Msg } from '../message';
import { ToolChoice } from '../tool';
import type { ToolSchema } from '../type';
import { ChatModelBase, ChatModelOptions, ChatModelRequestOptions } from './base';
import { ChatResponse, FinishedReason } from './response';
import { ChatUsage } from './usage';

type MockResult = ChatResponse | AsyncGenerator<ChatResponse, ChatResponse> | Error;

class MockChatModel extends ChatModelBase {
    readonly calls: Array<{
        modelName: string;
        options: ChatModelRequestOptions<unknown>;
    }> = [];
    results: MockResult[] = [];
    retryable = false;

    constructor(options: Partial<ChatModelOptions> = {}) {
        super({ modelName: 'mock', retryDelay: 0, ...options });
    }

    protected override isRetryableError(): boolean {
        return this.retryable;
    }

    protected async _callAPI(
        modelName: string,
        options: ChatModelRequestOptions<unknown>
    ): Promise<ChatResponse | AsyncGenerator<ChatResponse, ChatResponse>> {
        this.calls.push({ modelName, options });
        const result = this.results.shift();
        if (result instanceof Error) throw result;
        if (!result) throw new Error('No mock result configured.');
        return result;
    }

    _formatToolChoice(toolChoice: string): unknown {
        return toolChoice;
    }

    _formatToolSchemas(tools: ToolSchema[]): unknown[] {
        return tools;
    }
}

const MESSAGES: Msg[] = [UserMsg({ name: 'user', content: 'hello' })];

function response(text: string, options: { isLast?: boolean; id?: string } = {}) {
    return new ChatResponse({
        content: [TextBlock({ id: 'text', text })],
        isLast: options.isLast ?? false,
        id: options.id,
    });
}

async function collect(
    stream: AsyncGenerator<ChatResponse, ChatResponse>
): Promise<{ chunks: ChatResponse[]; final: ChatResponse }> {
    const chunks: ChatResponse[] = [];
    while (true) {
        const result = await stream.next();
        if (result.done) return { chunks, final: result.value };
        chunks.push(result.value);
    }
}

describe('ChatModelBase parity', () => {
    test('returns non-stream responses and converts cancellation', async () => {
        const model = new MockChatModel({ stream: false });
        const success = response('ok', { isLast: true });
        model.results.push(success);
        await expect(model.call({ messages: MESSAGES })).resolves.toBe(success);

        const cancelled = new Error('cancelled');
        cancelled.name = 'AbortError';
        model.results.push(cancelled);
        const interrupted = (await model.call({ messages: MESSAGES })) as ChatResponse;
        expect(interrupted).toMatchObject({
            content: [],
            isLast: true,
            finishedReason: FinishedReason.INTERRUPTED,
        });
    });

    test('retries only provider-declared retryable failures', async () => {
        const immediate = new MockChatModel({ stream: false, maxRetries: 2 });
        immediate.results.push(new Error('fatal'), response('unreachable'));
        await expect(immediate.call({ messages: MESSAGES })).rejects.toThrow('fatal');
        expect(immediate.calls).toHaveLength(1);

        const retrying = new MockChatModel({ stream: false, maxRetries: 2 });
        retrying.retryable = true;
        retrying.results.push(new Error('transient'), response('ok', { isLast: true }));
        await expect(retrying.call({ messages: MESSAGES })).resolves.toMatchObject({
            content: [expect.objectContaining({ text: 'ok' })],
        });
        expect(retrying.calls).toHaveLength(2);
    });

    test('forwards stream deltas, suppresses carrier chunks, and returns accumulation', async () => {
        const usage = new ChatUsage({ inputTokens: 2, outputTokens: 3, time: 0.1 });
        async function* raw(): AsyncGenerator<ChatResponse, ChatResponse> {
            yield response('hello ', { id: 'chunk-1' });
            yield response('world', { id: 'chunk-2' });
            yield new ChatResponse({ content: [], isLast: false, id: 'usage', usage });
            return undefined as unknown as ChatResponse;
        }
        const model = new MockChatModel({ stream: true });
        model.results.push(raw());
        const result = await model.call({ messages: MESSAGES });
        const { chunks, final } = await collect(
            result as AsyncGenerator<ChatResponse, ChatResponse>
        );
        expect(chunks).toHaveLength(2);
        expect(final).toMatchObject({
            id: 'usage',
            isLast: true,
            content: [expect.objectContaining({ id: 'text', text: 'hello world' })],
            usage,
        });
    });

    test('returns interrupted accumulation when stream consumption is cancelled', async () => {
        async function* raw(): AsyncGenerator<ChatResponse, ChatResponse> {
            yield response('partial', { id: 'chunk' });
            const error = new Error('cancelled');
            error.name = 'AbortError';
            throw error;
        }
        const model = new MockChatModel({ stream: true });
        model.results.push(raw());
        const result = await model.call({ messages: MESSAGES });
        const { chunks, final } = await collect(
            result as AsyncGenerator<ChatResponse, ChatResponse>
        );
        expect(chunks).toHaveLength(1);
        expect(final).toMatchObject({
            isLast: true,
            finishedReason: FinishedReason.INTERRUPTED,
            content: [expect.objectContaining({ text: 'partial' })],
        });
    });

    test('validates structured tool choices before provider invocation', async () => {
        const model = new MockChatModel({ stream: false });
        const tools: ToolSchema[] = [
            {
                type: 'function',
                function: {
                    name: 'search',
                    description: 'Search',
                    parameters: { type: 'object', properties: {} },
                },
            },
        ];
        await expect(
            model.call({
                messages: MESSAGES,
                tools,
                toolChoice: new ToolChoice({ mode: 'missing', tools: ['missing'] }),
            })
        ).rejects.toThrow("Invalid tool name 'missing'");
        expect(model.calls).toHaveLength(0);
    });

    test('uses a flat estimate for base64 and URL data blocks', async () => {
        const model = new MockChatModel();
        const message = UserMsg({
            name: 'user',
            content: [
                TextBlock({ text: 'abcd' }),
                DataBlock({
                    source: Base64Source({ data: 'YWJj', media_type: 'image/png' }),
                }),
                DataBlock({
                    source: URLSource({
                        url: 'https://example.com/file.png',
                        media_type: 'image/png',
                    }),
                }),
            ],
        });
        await expect(model.countTokens({ messages: [message] })).resolves.toBe(4001);
    });

    test('generates and validates structured output through a forced tool call', async () => {
        const model = new MockChatModel({ stream: false, maxRetries: 0 });
        model.results.push(
            new ChatResponse({
                id: 'structured',
                content: [
                    ToolCallBlock({
                        id: 'call',
                        name: 'generate_structured_output',
                        input: '{"answer":42}',
                    }),
                ],
                isLast: true,
            })
        );
        const result = await model.generateStructuredOutput({
            messages: MESSAGES,
            schema: z.object({ answer: z.number() }),
        });
        expect(result).toMatchObject({
            id: 'structured',
            content: { answer: 42 },
            type: 'structured_response',
        });
        expect(model.calls[0].options.toolChoice).toBe('generate_structured_output');
    });

    test('falls back from forced to auto only for structured-output errors', async () => {
        const model = new MockChatModel({ stream: false, maxRetries: 0 });
        model.results.push(
            new StructuredOutputError('forced rejected'),
            new ChatResponse({
                content: [
                    ToolCallBlock({
                        id: 'call',
                        name: 'generate_structured_output',
                        input: '{"answer":"ok"}',
                    }),
                ],
                isLast: true,
            })
        );
        await expect(
            model.generateStructuredOutput({
                messages: MESSAGES,
                schema: {
                    type: 'object',
                    properties: { answer: { type: 'string' } },
                    required: ['answer'],
                },
            })
        ).resolves.toMatchObject({ content: { answer: 'ok' } });
        expect(model.calls.map(call => call.options.toolChoice)).toEqual([
            'generate_structured_output',
            'auto',
        ]);
    });
});
